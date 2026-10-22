import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { documentUrl, imageExtension } from './feishu.ts';
import type { Node, Snapshot } from './converter.ts';

export class ApiError extends Error {
  kind: string;
  constructor(kind: string, message: string) { super(message); this.kind = kind; }
}
const fail = (message: string): never => { throw new ApiError('structure', message); };
const node = (tag: string, id: string, children: (Node | string)[] = [], attrs: Record<string, string> = {}): Node => ({ tag, attrs: { id, ...attrs }, children });
const digest = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
export const READER_VERSION = 'openapi-1';
export type ApiSnapshot = Snapshot & { snapshot_version: 2; reader: string; blocks: any[]; source: any; completeness: any; tree: Node };

/** 所有网络请求限定官方 API；注入 fetch 仅供离线测试，不从网页接收上游地址。 */
export class FeishuApi {
  getToken: () => Promise<string>;
  fetcher: typeof fetch;
  checkpoint: () => void;
  constructor(getToken: () => Promise<string>, fetcher = fetch, checkpoint = () => {}) { this.getToken = getToken; this.fetcher = fetcher; this.checkpoint = checkpoint; }
  async request(endpoint: string, binary = false): Promise<any> {
    if (!endpoint.startsWith('/open-apis/') || /[\r\n]/.test(endpoint)) fail('接口地址无效');
    for (let attempt = 0; attempt < 3; attempt++) {
      this.checkpoint();
      const token = await this.getToken();
      let response: Response;
      try { response = await this.fetcher('https://open.feishu.cn' + endpoint, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(30_000) }); }
      catch { if (attempt < 2) { await new Promise(r => setTimeout(r, 200 * 2 ** attempt)); continue; } throw new ApiError('network', '飞书连接超时或失败，请稍后重试'); }
      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel();
        if (attempt < 2) { const wait = Number(response.headers.get('retry-after') ?? 1); if (wait > 10) throw new ApiError('network', '飞书限流，请稍后重试'); await new Promise(r => setTimeout(r, Math.max(1, Number.isFinite(wait) ? wait : 1) * 1000)); continue; }
        throw new ApiError('network', '飞书限流或服务暂不可用，请稍后重试');
      }
      if (response.status === 401) { await response.body?.cancel(); throw new ApiError('authorization', '飞书授权已失效，请重新授权'); }
      if (!response.ok) { await response.body?.cancel(); throw new ApiError('permission', '飞书资源不存在或当前身份无权访问'); }
      const bytes = await readLimited(response, binary ? 50 * 1024 * 1024 : 24 * 1024 * 1024);
      this.checkpoint();
      if (binary && !response.headers.get('content-type')?.includes('json')) return bytes;
      let json: any;
      try { json = JSON.parse(bytes.toString('utf8')); } catch { throw new ApiError('structure', '飞书返回内容无法识别'); }
      if (json.code !== 0) {
        if ([99991661, 99991663, 99991668, 99991669].includes(json.code)) throw new ApiError('authorization', '飞书授权已失效，请重新授权');
        if ([99991672, 99991679].includes(json.code)) throw new ApiError('scope', '缺少飞书接口权限，请补充应用配置及用户授权');
        throw new ApiError('permission', '飞书拒绝读取，请检查当前用户的文档及资源权限');
      }
      if (binary) throw new ApiError('structure', '图片接口未返回图片');
      return json.data;
    }
  }
  async resolve(url: string) {
    const parsed = new URL(documentUrl(url)); const id = parsed.pathname.split('/')[2];
    if (parsed.pathname.startsWith('/docx/')) return id;
    const data = await this.request(`/open-apis/wiki/v2/spaces/get_node?token=${id}`);
    if (data?.node?.obj_type !== 'docx' || !/^[a-zA-Z0-9]+$/.test(data.node.obj_token)) fail('此知识库节点不是可读取的新版文档');
    return data.node.obj_token;
  }
  async meta(id: string) { return (await this.request(`/open-apis/docx/v1/documents/${id}`))?.document; }
  async media(token: string) {
    if (!/^[a-zA-Z0-9]+$/.test(token)) fail('图片素材标识无效');
    return this.request(`/open-apis/drive/v1/medias/${token}/download`, true) as Promise<Buffer>;
  }
  async read(url: string, runDir: string): Promise<ApiSnapshot> {
    const id = await this.resolve(url), before = await this.meta(id);
    if (!Number.isInteger(before?.revision_id) || !before.title?.trim()) fail('文档标题或版本不完整');
    const blocks: any[] = [], pages = new Set<string>(); let cursor = '', totalBytes = 0;
    for (let page = 0; ; page++) {
      if (page >= 200) fail('文档分页超过上限');
      const result = await this.request(`/open-apis/docx/v1/documents/${id}/blocks?page_size=500&document_revision_id=${before.revision_id}${cursor ? '&page_token=' + encodeURIComponent(cursor) : ''}`);
      if (!Array.isArray(result?.items)) fail('未取得文档块');
      totalBytes += Buffer.byteLength(JSON.stringify(result.items));
      if (totalBytes > 24 * 1024 * 1024 || blocks.length + result.items.length > 50000) fail('文档总量超过初版上限');
      blocks.push(...result.items);
      if (!result.has_more) break;
      cursor = result.page_token;
      if (!cursor || pages.has(cursor)) fail('文档分页缺失或重复'); pages.add(cursor);
    }
    const tree = blocksToTree(blocks, id, before.title);
    const snapshot: ApiSnapshot = { snapshot_version: 2, reader: READER_VERSION, documentId: id, revision: before.revision_id, title: before.title, url: documentUrl(url), content: '', tree, blocks,
      source: { document_id: id, url: documentUrl(url), revision: before.revision_id, fetched_at: new Date().toISOString() }, images: {}, sheets: {}, completeness: { pages: pages.size + 1, blocks: blocks.length, relationships: true, revision: false } };
    snapshot.sourceWarnings = blocks.flatMap(block => {
      const messages: string[] = [];
      if (JSON.stringify(block).includes('text_color')) messages.push('文字颜色枚举已映射到色系，具体色值与飞书主题的显示差异需核对');
      if (block.block_type === 31) messages.push('普通表格保留内容与行列关系，列宽和外观需要核对');
      if (block.block_type === 14) messages.push('代码正文保留，语言标识尚未映射');
      return messages.map(reason => ({ code: 'DISPLAY', source: block.block_id, location: '来源文档', reason }));
    });
    await mkdir(path.join(runDir, 'assets'), { recursive: true, mode: 0o700 });
    let assetBytes = 0;
    for (const block of blocks) {
      if (block.block_type === 27 && block.image?.token) {
        try {
          const bytes = await this.media(block.image.token); let ext: string;
          try { ext = imageExtension(bytes); } catch { throw new ApiError('structure', '素材文件不是支持的图片格式'); }
          assetBytes += bytes.length; if (assetBytes > 200 * 1024 * 1024) throw new ApiError('limit', '本次图片总量超过 200 MB 上限');
          const src = `assets/${digest(id + ':' + block.block_id).slice(0, 24)}.${ext}`;
          await writeFile(path.join(runDir, src), bytes, { flag: 'wx', mode: 0o600 });
          snapshot.images[block.block_id] = { src, sha256: digest(bytes) };
        } catch (error) {
          if (!(error instanceof ApiError) || !['permission', 'structure'].includes(error.kind)) throw error;
          snapshot.images[block.block_id] = { error: error.message };
        }
      }
      if (block.block_type === 30) snapshot.sheets[block.block_id] = { error: '原生电子表格的样式与版本读取尚未完成验证，需明确排除或取消转换' };
    }
    if ((await this.meta(id))?.revision_id !== before.revision_id) fail('读取期间文档版本变化，请重新获取');
    snapshot.completeness.revision = true; this.checkpoint();
    await writeFile(path.join(runDir, 'snapshot.json'), JSON.stringify(snapshot, null, 2), { flag: 'wx', mode: 0o600 });
    return snapshot;
  }
  async check(snapshot: ApiSnapshot, retainedImages = Object.keys(snapshot.images), sameVersion = false) {
    if (await this.resolve(snapshot.url) !== snapshot.documentId) fail('原文地址的目标已变化，请重新获取');
    const meta = await this.meta(snapshot.documentId);
    if (!meta?.document_id) fail('未能确认原文访问权限');
    if (sameVersion && meta.revision_id !== snapshot.revision) fail('原文已更新，请重新获取并审核');
    // 实际读取正文验证权限，元信息成功不作为正文可读的替代。
    const response = await this.request(`/open-apis/docx/v1/documents/${snapshot.documentId}/blocks?page_size=1`);
    if (!Array.isArray(response?.items)) fail('未能确认正文访问权限');
    for (const blockId of retainedImages) {
      const block = snapshot.blocks.find(b => b.block_id === blockId);
      if (!block?.image?.token) fail('图片来源信息缺失');
      await this.media(block.image.token);
    }
    this.checkpoint();
  }
}
export async function readLimited(response: Response, limit: number): Promise<Buffer> {
  const chunks: Uint8Array[] = []; let size = 0;
  const reader = response.body?.getReader(); if (!reader) throw new ApiError('network', '接口返回为空');
  try { while (true) { const item = await reader.read(); if (item.done) break; size += item.value.length; if (size > limit) throw new ApiError('structure', '接口内容超过允许大小'); chunks.push(item.value); } }
  catch (error) { await reader.cancel().catch(() => {}); if (error instanceof ApiError) throw error; throw new ApiError('network', '接口返回中断，请重新读取'); }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

/** 将原始块转成现有转换器的节点；未知行内元素排除整块，防止丢掉局部语义。 */
export function blocksToTree(blocks: any[], documentId: string, title: string): Node {
  const map = new Map<string, any>();
  for (const b of blocks) { if (!b?.block_id || map.has(b.block_id)) fail('原始块缺少标识或重复'); map.set(b.block_id, b); }
  const root = map.get(documentId); if (!root || root.block_type !== 1) fail('文档根节点缺失');
  const seen = new Set<string>();
  const align: Record<number, string> = { 1: 'left', 2: 'center', 3: 'right' };
  // 飞书颜色枚举；保留色系。像素级色值及暗色主题仍需真实页面验收。
  const palette = ['', '#d83931', '#de7802', '#dc9b04', '#2ea121', '#245bdb', '#6425d0', '#8f959e'];
  function inline(elements: any[], id: string): (Node | string)[] {
    if (!Array.isArray(elements)) throw new Error('文字元素缺失');
    return elements.map((e, index) => {
      const run = e.text_run;
      if (!run || typeof run.content !== 'string') throw new Error('行内提及、公式或其他内容尚未适配');
      const style = run.text_element_style ?? {}; let item: Node | string = run.content;
      if (style.inline_code) throw new Error('行内代码样式尚未适配');
      for (const key of Object.keys(style)) if (!['bold', 'italic', 'strikethrough', 'underline', 'inline_code', 'text_color', 'background_color', 'link', 'comment_ids'].includes(key)) throw new Error('未适配的文字样式');
      for (const [key, tag] of [['bold', 'b'], ['italic', 'i'], ['strikethrough', 'del'], ['underline', 'u']]) if (style[key]) item = node(tag, `${id}-${index}-${tag}`, [item]);
      if (style.text_color) { if (!palette[style.text_color]) throw new Error('未知文字颜色'); item = node('span', `${id}-${index}-color`, [item], { 'text-color': palette[style.text_color] }); }
      if (style.background_color) throw new Error('文字背景色枚举尚未验证');
      if (style.link?.url) item = node('a', `${id}-${index}-link`, [item], { href: style.link.url });
      return item;
    });
  }
  function build(id: string, parent?: string, depth = 0): Node {
    if (depth > 100 || seen.has(id)) fail('文档块存在循环或多次引用');
    const b = map.get(id); if (!b) fail('文档缺少被引用的块');
    if (parent && b.parent_id !== parent) fail('文档父子关系不一致');
    seen.add(id);
    const refs = b.children ?? []; if (!Array.isArray(refs)) fail('子节点列表无效');
    const rawChildren = refs.map((x: string) => build(x, id, depth + 1));
    const children: Node[] = [];
    for (const child of rawChildren) {
      const previous = children.at(-1);
      if (['ul', 'ol'].includes(child.tag) && previous?.tag === child.tag && !child.attrs.start) previous.children.push(...child.children);
      else children.push(child);
    }
    try {
      const t = b.block_type;
      if (t === 1) return node('root', id, [node('title', id + '-title', [title]), ...children]);
      if (t === 2 || (t >= 3 && t <= 15)) {
        const field = t === 2 ? 'text' : t <= 11 ? `heading${t - 2}` : ({ 12: 'bullet', 13: 'ordered', 14: 'code', 15: 'quote' } as any)[t];
        const data = b[field], style = data?.style ?? {}, text = inline(data?.elements, id);
        const attrs: Record<string, string> = {};
        if (Object.keys(style).some(key => !['align', 'background_color', 'indentation_level', 'sequence', 'folded', 'language', 'wrap'].includes(key))) throw new Error('段落含未知样式');
        if (style.align) { if (!align[style.align]) throw new Error('未知对齐方式'); attrs.align = align[style.align]; }
        if (style.background_color) throw new Error('段落背景色尚未适配');
        if (style.indentation_level === 'OneLevelIndent') attrs.indent = '1';
        if (style.folded) attrs.folded = 'true';
        if (t === 12 || t === 13) {
          if (t === 13 && style.sequence && style.sequence !== 'auto') { if (!/^\d+$/.test(style.sequence)) throw new Error('列表起始编号无法识别'); attrs.start = style.sequence; }
          return node(t === 12 ? 'ul' : 'ol', id, [node('li', id + '-li', [...text, ...children])], attrs);
        }
        if (children.length) throw new Error('该文字块含未适配的嵌套内容');
        if (t === 14) { if (data.elements.some((e: any) => !e.text_run)) throw new Error('代码内容无法识别'); return node('pre', id, data.elements.map((e: any) => e.text_run.content), { wrap: String(!!style.wrap) }); }
        if (t === 15) return node('quote', id, [node('p', id + '-p', text)]);
        return node(t === 2 ? 'p' : `h${t - 2}`, id, text, attrs);
      }
      if (t === 22) return node('hr', id);
      if (t === 24) return node('grid', id, children);
      if (t === 25) return node('column', id, children, b.grid_column?.width_ratio ? { 'width-ratio': String(b.grid_column.width_ratio) } : {});
      if (t === 27) {
        const attrs: Record<string, string> = {}; const image = b.image ?? {};
        for (const key of Object.keys(image)) if (!['token', 'width', 'height', 'align', 'caption', 'scale'].includes(key)) throw new Error('图片含未适配的裁剪或变换属性');
        for (const key of ['width', 'height', 'scale']) if (image[key] != null) attrs[key] = String(image[key]);
        if (image.caption?.content) attrs.caption = image.caption.content;
        if (image.align) { if (!align[image.align]) throw new Error('未知图片对齐方式'); attrs.align = align[image.align]; }
        return node('img', id, [], attrs);
      }
      if (t === 30) return node('sheet', id);
      if (t === 31) {
        const p = b.table?.property, cells = b.table?.cells;
        if (!p || !Array.isArray(cells) || p.row_size * p.column_size !== cells.length || children.length !== cells.length || cells.some((x: string, i: number) => refs[i] !== x)) throw new Error('表格结构不完整');
        if (p.merge_info?.some((m: any) => m.row_span !== 1 || m.col_span !== 1)) throw new Error('合并单元格尚未适配');
        const rows: Node[] = [];
        for (let r = 0; r < p.row_size; r++) rows.push(node('tr', id + '-r' + r, children.slice(r * p.column_size, (r + 1) * p.column_size).map((cell: Node, c: number) => ({ ...cell, tag: (p.header_row && r === 0) || (p.header_column && c === 0) ? 'th' : 'td' }))));
        return node('table', id, rows);
      }
      if (t === 32) return node('td', id, children);
      if (t === 34) return node('quote', id, children);
      if (t === 19 && !b.callout?.background_color && !b.callout?.text_color && !b.callout?.border_color && !b.callout?.emoji_id) return node('callout', id, children);
      return node('unsupported', id, children, { type: ({ 18: '多维表格', 19: '提示框样式', 20: '群名片', 21: '流程图', 23: '附件', 26: '嵌入网页', 28: '第三方组件（含时间轴组件）', 29: '思维笔记', 43: '画板', 46: '同步块', 47: '同步块引用' } as any)[t] ?? `未适配的飞书内容类型 ${t}` });
    } catch (e) { return node('unsupported', id, children, { type: e instanceof Error ? e.message : '未适配结构' }); }
  }
  const result = build(documentId); if (seen.size !== blocks.length) fail('存在未归属文档块，不能忽略'); return result;
}

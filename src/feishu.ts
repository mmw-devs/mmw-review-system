import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, copyFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { allNodes, parseXml, color, plain } from './converter.ts';
import type { Node, Snapshot } from './converter.ts';
const execute = promisify(execFile);

export function documentUrl(input: string): string {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('请输入完整的飞书文档地址'); }
  if (url.protocol !== 'https:' || !/(^|\.)feishu\.cn$/.test(url.hostname) || url.port || url.username || url.password || !/^\/(wiki|docx)\/[a-zA-Z0-9]+\/?$/.test(url.pathname)) throw new Error('仅接受 HTTPS 飞书 wiki 或 docx 文档地址');
  url.search = ''; url.hash = ''; return url.href;
}

export class Feishu {
  executable: string;
  prefix: string[];
  identity: string;
  constructor(cliPath?: string, identity = 'user') {
    if (!['user', 'bot'].includes(identity)) throw new Error('身份只能为 user 或 bot');
    this.identity = identity;
    const installed = process.platform === 'win32' && process.env.APPDATA ? path.join(process.env.APPDATA, 'npm/node_modules/@larksuite/cli/scripts/run.js') : undefined;
    const entry = cliPath ?? (installed && existsSync(installed) ? installed : undefined);
    this.executable = entry?.endsWith('.js') ? process.execPath : entry ?? 'lark-cli';
    this.prefix = entry?.endsWith('.js') ? [entry] : [];
  }
  async call(args: string[], cwd?: string): Promise<any> {
    let stdout: string;
    try {
      const result = await execute(this.executable, [...this.prefix, ...args, '--as', this.identity], { cwd, timeout: 120_000, maxBuffer: 24 * 1024 * 1024, windowsHide: true, encoding: 'utf8' });
      stdout = result.stdout;
    } catch { throw new Error('飞书 CLI 调用失败或超时，请检查登录状态、读取权限和 CLI 路径；未记录原始错误以避免泄露凭据'); }
    let response: any;
    try { response = JSON.parse(stdout); } catch { throw new Error('飞书 CLI 未返回完整 JSON'); }
    if (response.ok === false || (response.code !== undefined && response.code !== 0) || response.error) throw new Error('飞书拒绝读取请求，请检查当前身份的文档权限');
    return response.data ?? response;
  }
  async document(url: string): Promise<Snapshot> {
    const result = await this.call(['docs', '+fetch', '--doc', documentUrl(url), '--detail', 'full']);
    const d = result.document;
    if (!d?.content || !/^[a-zA-Z0-9]+$/.test(d.document_id) || !Number.isInteger(d.revision_id) || result.has_more || result.truncated) throw new Error('文档返回不完整，不能继续转换');
    const root = parseXml(d.content);
    const titleNode = root.children.find(n => typeof n !== 'string' && n.tag === 'title') as Node | undefined;
    const title = titleNode ? plain(titleNode) : '';
    if (!title.trim()) throw new Error('未取得文档标题');
    // 用原始块分页清单核对 XML 覆盖范围，缺块时整体阻断，不能把缺页当成空白。
    const xmlIds = new Set(allNodes(root).map(n => n.attrs.id).filter(Boolean));
    const rawIds = new Set<string>(), tokens = new Set<string>();
    let pageToken: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= 200) throw new Error('文档块分页超出当前上限');
      const params: any = { page_size: 500, document_revision_id: d.revision_id, ...(pageToken ? { page_token: pageToken } : {}) };
      const blocks = await this.call(['api', 'GET', `/open-apis/docx/v1/documents/${d.document_id}/blocks`, '--params', JSON.stringify(params)]);
      if (!Array.isArray(blocks.items)) throw new Error('未取得原始块清单，无法核对正文完整性');
      for (const b of blocks.items) {
        if (!b.block_id || rawIds.has(b.block_id)) throw new Error('原始块分页出现重复或缺少标识');
        rawIds.add(b.block_id);
        if (!xmlIds.has(b.block_id)) throw new Error('完整内容中缺少原始块定位，不能静默忽略；需补充适配');
      }
      if (!blocks.has_more) break;
      if (!blocks.page_token || tokens.has(blocks.page_token)) throw new Error('原始块分页不完整');
      pageToken = blocks.page_token; tokens.add(pageToken!);
    }
    return { documentId: d.document_id, revision: d.revision_id, title, content: d.content, url: documentUrl(url), sheets: {}, images: {} };
  }
  async assertRevision(snapshot: Snapshot): Promise<void> {
    const result = await this.call(['api', 'GET', `/open-apis/docx/v1/documents/${snapshot.documentId}`]);
    if (result.document?.revision_id !== snapshot.revision) throw new Error('读取期间飞书文档版本发生变化，请重新获取；未生成最终 JSON');
  }
  async sheet(n: Node): Promise<any> {
    const token = n.attrs.token, sheetId = n.attrs['sheet-id'];
    if (!/^[a-zA-Z0-9]+$/.test(token ?? '') || !/^[a-zA-Z0-9]+$/.test(sheetId ?? '')) throw new Error('表格引用无法识别');
    const common = ['--spreadsheet-token', token, '--sheet-id', sheetId];
    const info = await this.call(['sheets', '+sheet-info', ...common, '--include', 'merges,col_widths,hidden_rows,hidden_cols']);
    const range = n.attrs.range || info.range;
    if (n.attrs.range && n.attrs.range !== info.range) throw new Error('局部引用表格尚未验证');
    if (!range || !Number.isInteger(info.revision) || [info.hidden_rows, info.hidden_columns, info.merged_cells, info.row_groups, info.column_groups].some(x => !Array.isArray(x) || x.length)) throw new Error('表格有隐藏、合并或分组等未适配内容');
    const cells = await this.call(['sheets', '+cells-get', ...common, '--range', range, '--include', 'value,formula,style']);
    const after = await this.call(['sheets', '+sheet-info', ...common, '--include', 'merges,col_widths,hidden_rows,hidden_cols']);
    if (info.revision !== after.revision || info.revision !== cells.revision || cells.has_more || cells.truncated || cells.ranges?.length !== 1) throw new Error('表格内容不完整或读取期间版本变化');
    return { table: sheetTable(info, cells), revision: info.revision, raw: { info, cells } };
  }
  async resources(snapshot: Snapshot, runDir: string, mediaWorkdir?: string, progress: (s: string) => void = () => {}): Promise<void> {
    const nodes = allNodes(parseXml(snapshot.content));
    const imageDir = path.join(runDir, 'assets'); await mkdir(imageDir, { recursive: true });
    if (mediaWorkdir && !(await stat(mediaWorkdir)).isDirectory()) throw new Error('图片临时目录不存在');
    const jobs = nodes.filter(n => ['img', 'sheet'].includes(n.tag));
    let cursor = 0, done = 0;
    await Promise.all(Array.from({ length: 3 }, async () => {
      while (cursor < jobs.length) {
        const n = jobs[cursor++], blockId = n.attrs.id;
        if (!blockId) throw new Error('资源缺少来源定位，无法安全列出排除清单');
        if (n.tag === 'sheet') {
          try { snapshot.sheets[blockId] = await this.sheet(n); }
          catch (e) { snapshot.sheets[blockId] = { error: e instanceof Error ? e.message : '表格获取失败' }; }
        } else if (!n.attrs.crop) {
          try {
            const token = n.attrs.src;
            if (!/^[a-zA-Z0-9]+$/.test(token ?? '')) throw new Error('图片来源不是可识别的飞书资源');
            const basename = createHash('sha256').update(snapshot.documentId + ':' + blockId).digest('hex').slice(0, 24);
            const tempName = `mmw-${basename}-${snapshot.revision}.bin`;
            const cwd = mediaWorkdir ?? runDir;
            await this.call(['docs', '+media-download', '--token', token, '--output', tempName], cwd);
            const downloaded = path.join(cwd, tempName);
            const bytes = await readFile(downloaded), extension = imageExtension(bytes);
            const relative = `assets/${basename}.${extension}`;
            await copyFile(downloaded, path.join(runDir, relative));
            snapshot.images[blockId] = { src: relative, sha256: createHash('sha256').update(bytes).digest('hex') };
          } catch (e) { snapshot.images[blockId] = { error: e instanceof Error ? e.message : '图片获取失败' }; }
        }
        done++; if (done % 10 === 0 || done === jobs.length) progress(`资源检查 ${done}/${jobs.length}`);
      }
    }));
    await this.assertRevision(snapshot);
    await writeFile(path.join(runDir, 'snapshot.json'), JSON.stringify(snapshot, null, 2), { mode: 0o600 });
  }
}
export function imageExtension(bytes: Buffer): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'gif';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  throw new Error('图片文件签名未支持或下载内容不是图片');
}

export function sheetTable(info: any, data: any): any {
  const range = data.ranges?.[0];
  const match = info.range?.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
  if (!match || data.has_more || data.truncated || range?.truncated || range?.actual_range !== info.range || data.ranges.length !== 1) throw new Error('表格范围不完整');
  const colNumber = (s: string) => [...s].reduce((a, c) => a * 26 + c.charCodeAt(0) - 64, 0);
  const firstCol = colNumber(match[1]), lastCol = colNumber(match[3]), firstRow = Number(match[2]), lastRow = Number(match[4]);
  if ((lastCol - firstCol + 1) * (lastRow - firstRow + 1) > 10000) throw new Error('表格超过初版单表 10000 格上限');
  const rows: any[] = [];
  for (let r = firstRow; r <= lastRow; r++) {
    const rowIndex = range.row_indices.indexOf(r);
    if (rowIndex < 0) throw new Error('表格缺行');
    const cells = [];
    for (let c = firstCol; c <= lastCol; c++) {
      const colIndex = range.col_indices.findIndex((s: string) => colNumber(s) === c);
      const cell = range.cells[rowIndex]?.[colIndex];
      if (!cell || cell.formula || !['string', 'number', 'boolean'].includes(typeof cell.value)) throw new Error('单元格缺失、公式或非文本值尚未验证');
      const s = cell.cell_styles ?? {}, style: any = {};
      if (s.font_color) style.color = color(s.font_color);
      if (s.font_size) style.font_size_px = Number(s.font_size);
      for (const [a, k] of [['bold', 'bold'], ['italic', 'italic'], ['underline', 'underline'], ['strikethrough', 'strike']]) if (typeof s[a] === 'boolean') style[k] = s[a];
      const text = String(cell.value);
      const result: any = { content: [{ type: 'paragraph', ...(s.horizontal_alignment ? { align: s.horizontal_alignment } : {}), content: text ? [{ type: 'text', text, ...(Object.keys(style).length ? { style } : {}) }] : [] }] };
      if (s.background_color) result.background_color = color(s.background_color);
      cells.push(result);
    }
    rows.push({ cells });
  }
  if (new Set(range.row_indices).size !== range.row_indices.length || new Set(range.col_indices).size !== range.col_indices.length || range.row_indices.length !== rows.length || range.col_indices.length !== lastCol - firstCol + 1) throw new Error('表格坐标重复或范围异常');
  const widths = [];
  for (let c = firstCol; c <= lastCol; c++) {
    const width = info.column_widths?.find((item: any) => { const m = item.cols?.match(/^([A-Z]+):([A-Z]+)$/); return m && colNumber(m[1]) <= c && colNumber(m[2]) >= c; })?.width;
    if (!(width > 0)) throw new Error('表格列宽不完整');
    widths.push(width);
  }
  return { type: 'table', rows, column_widths_px: widths };
}

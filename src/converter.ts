import { createHash } from 'node:crypto';
import { validateStrategy } from './validation.ts';

export type Node = { tag: string; attrs: Record<string, string>; children: (Node | string)[] };
export type Issue = { code: string; source: string; location: string; reason: string; unitId?: string };
export type Snapshot = { documentId: string; revision: number; title: string; content: string; tree?: Node; sourceWarnings?: Issue[]; url: string; sheets: Record<string, any>; images: Record<string, { src?: string; sha256?: string; error?: string }> };
export type Options = { dutyId: string; dutyName: string; dutyType?: string; profile: 'legacy' | 'standard' };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export const fingerprint = (value: any) => hash(JSON.stringify(value));

// 解析 CLI 的 XML 片段，拒绝 DTD、外部实体和不完整标签，禁止修复后冒充完整正文。
export function parseXml(xml: string): Node {
  if (xml.length > 20_000_000) throw new Error('文档超过当前读取上限');
  const root: Node = { tag: 'root', attrs: {}, children: [] }, stack = [root];
  let pos = 0;
  function decode(text: string): string {
    return text.replace(/&([^;\s]+);/g, (_, name) => {
      const known: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
      if (name in known) return known[name];
      if (/^#(?:x[0-9a-f]+|[0-9]+)$/i.test(name)) {
        const n = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
        if (n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)) return String.fromCodePoint(n);
      }
      throw new Error('文档包含无法识别的 XML 实体');
    });
  }
  const tokens = /<[^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>|[^<]+/g;
  for (const match of xml.matchAll(tokens)) {
    if (match.index !== pos) throw new Error('XML 内容不完整');
    const token = match[0]; pos += token.length;
    if (!token.startsWith('<')) { stack.at(-1)!.children.push(decode(token)); continue; }
    if (/^<[!?]/.test(token)) throw new Error('不允许 XML 声明或外部实体');
    if (token.startsWith('</')) {
      if (stack.length === 1 || token !== `</${stack.at(-1)!.tag}>`) throw new Error('XML 结束标签不匹配');
      stack.pop(); continue;
    }
    const m = token.match(/^<([\w-]+)([\s\S]*?)(\/?)>$/);
    if (!m) throw new Error('无法识别 XML 标签');
    const node: Node = { tag: m[1], attrs: {}, children: [] };
    let rest = m[2];
    while (rest.trim()) {
      const a = rest.match(/^\s+([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/);
      if (!a || a[1] in node.attrs) throw new Error('XML 属性格式无效');
      node.attrs[a[1]] = decode(a[2] ?? a[3]); rest = rest.slice(a[0].length);
    }
    stack.at(-1)!.children.push(node);
    if (!m[3]) { stack.push(node); if (stack.length > 100) throw new Error('文档嵌套过深'); }
  }
  if (pos !== xml.length || stack.length !== 1) throw new Error('XML 内容不完整');
  return root;
}
export const plain = (node: Node): string => node.children.map(x => typeof x === 'string' ? x : x.tag === 'br' ? '\n' : plain(x)).join('');
export function allNodes(root: Node): Node[] { return [root, ...root.children.flatMap(x => typeof x === 'string' ? [] : allNodes(x))]; }
export function color(text: string): string {
  if (/^#[0-9a-f]{6}$/i.test(text)) return text.toLowerCase();
  const m = text.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
  if (!m || m.slice(1).some(x => Number(x) > 255)) throw new Error('颜色格式未支持');
  return '#' + m.slice(1).map(x => Number(x).toString(16).padStart(2, '0')).join('');
}

// 输出候选攻略及诊断；排除决策由 CLI 在展示具体清单后执行，此函数从不授权丢弃。
export function convert(snapshot: Snapshot, options: Options, splitPhases = true) {
  const unsupported: Issue[] = [], warnings: Issue[] = [...(snapshot.sourceWarnings ?? [])], blockers: Issue[] = [];
  let location = '文档开头';
  let reportingUnit: string | undefined = splitPhases ? 'basic' : undefined;
  const root = snapshot.tree ?? parseXml(snapshot.content);
  const source = (n: Node) => n.attrs.id || `fragment-${hash(JSON.stringify(n)).slice(0, 16)}`;
  const id = (n: Node, prefix: string) => `${prefix}-${hash(snapshot.documentId + ':' + source(n)).slice(0, 16)}`;
  function issue(list: Issue[], n: Node, code: string, reason: string) { list.push({ code, source: source(n), location, reason, ...(reportingUnit ? { unitId: reportingUnit } : {}) }); }
  const warn = (n: Node, reason: string) => issue(warnings, n, 'DISPLAY', reason);
  const block = (n: Node, reason: string) => issue(blockers, n, 'STRUCTURE', reason);
  const reject = (n: Node, reason: string): any[] => { issue(unsupported, n, 'UNSUPPORTED', reason); return []; };
  function inline(n: Node, style: any = {}, href?: string): any[] {
    return n.children.flatMap(child => {
      if (typeof child === 'string') return child ? [{ type: 'text', text: child, ...(Object.keys(style).length ? { style } : {}), ...(href ? { href } : {}) }] : [];
      if (child.tag === 'br') return [{ type: 'hard_break' }];
      const next = { ...style };
      const marks: Record<string, string> = { b: 'bold', strong: 'bold', i: 'italic', em: 'italic', u: 'underline', del: 'strike', s: 'strike' };
      if (marks[child.tag]) next[marks[child.tag]] = true;
      else if (!['span', 'a'].includes(child.tag)) throw new Error(`未适配的行内内容：${child.tag}`);
      for (const [attr, value] of Object.entries(child.attrs)) {
        if (attr === 'id' || (attr === 'href' && child.tag === 'a')) continue;
        if (attr === 'text-color') next.color = color(value);
        else if (attr === 'background-color') next.background_color = color(value);
        else if (attr === 'font-size' && /^\d+(?:\.\d+)?(?:px)?$/.test(value)) next.font_size_px = parseFloat(value);
        else throw new Error(`行内属性无法保留：${attr}`);
      }
      const link = child.tag === 'a' ? child.attrs.href : href;
      if (link && !/^(https?:\/\/|#|\/[^/])/.test(link)) throw new Error('链接协议无法保留');
      return inline(child, next, link);
    });
  }
  const children = (n: Node): any[] => n.children.flatMap(c => typeof c === 'string' ? c.trim() ? [{ type: 'paragraph', content: [{ type: 'text', text: c }] }] : [] : body(c));
  function requiredChildren(n: Node): any[] {
    const result = children(n);
    if (!result.length) throw new Error('容器没有可转换正文，排除范围包含整个容器');
    return result;
  }
  function body(n: Node): any[] {
    try {
      const a = n.attrs, t = n.tag;
      if (t === 'unsupported') return reject(n, a.type || '飞书内容尚未适配（含内部内容）');
      if (t === 'p' || /^h[1-9]$/.test(t)) {
        const result: any = { type: t === 'p' ? 'paragraph' : 'heading', ...(t === 'p' ? {} : { level: Number(t[1]) }), content: inline(n) };
        if (a.align) result.align = a.align;
        if (a.indent) result.indent = Number(a.indent);
        for (const attr of Object.keys(a)) if (!['id', 'align', 'indent'].includes(attr)) warn(n, `段落属性未输出：${attr}`);
        return [result];
      }
      if (t === 'img') {
        if (a.crop) return reject(n, '图片裁剪尚不能正确还原');
        const image = snapshot.images[source(n)];
        if (!image?.src) return reject(n, image?.error ?? '图片未能获取');
        const result: any = { type: 'image', src: image.src };
        for (const key of ['width', 'height']) if (Number(a[key]) > 0) result[key] = Math.round(Number(a[key]));
        if (a.align) result.align = a.align;
        if (a.caption?.trim()) result.caption = [{ type: 'text', text: a.caption }];
        if (a.scale && Number(a.scale) !== 1) warn(n, '图片缩放表现需要检查；保留原图及显示尺寸');
        return [result];
      }
      if (t === 'sheet') {
        const sheet = snapshot.sheets[source(n)];
        if (!sheet?.table) return reject(n, sheet?.error ?? '电子表格未完整取得');
        warn(n, '电子表格未保留行高、边框和竖直对齐，请检查显示效果');
        return [sheet.table];
      }
      if (t === 'grid') {
        const cols = n.children.filter(x => typeof x !== 'string') as Node[];
        if (cols.length < 2 || cols.some(x => x.tag !== 'column')) throw new Error('分栏结构无法保留');
        return [{ type: 'columns', columns: cols.map(c => ({ content: requiredChildren(c), ...(c.attrs['width-ratio'] ? { width_weight: Number(c.attrs['width-ratio']) } : {}) })) }];
      }
      if (t === 'table') {
        const rows = n.children.filter(x => typeof x !== 'string') as Node[];
        if (rows.some(r => r.tag !== 'tr')) throw new Error('普通表格结构尚未适配');
        return [{ type: 'table', rows: rows.map(r => ({ cells: r.children.filter(x => typeof x !== 'string').map((cell: any) => {
          if (!['td', 'th'].includes(cell.tag)) throw new Error('表格单元格结构无法识别');
          const content = children(cell);
          const value: any = { content: content.length ? content : [{ type: 'paragraph', content: [] }] };
          if (!content.length && cell.children.some((c: any) => typeof c !== 'string')) throw new Error('单元格内容全部无法转换，排除范围包含整个表格');
          if (cell.tag === 'th') value.header = true;
          for (const [a, key] of [['rowspan', 'row_span'], ['colspan', 'col_span']]) if (cell.attrs[a]) value[key] = Number(cell.attrs[a]);
          if (cell.attrs['background-color']) value.background_color = color(cell.attrs['background-color']);
          return value;
        }) })) }];
      }
      if (t === 'ul' || t === 'ol') {
        const items = n.children.filter(x => typeof x !== 'string') as Node[];
        if (items.some(x => x.tag !== 'li')) throw new Error('列表结构无法识别');
        return [{ type: 'list', ordered: t === 'ol', ...(t === 'ol' && a.start ? { start: Number(a.start) } : {}), items: items.map(item => {
          // 列表项可混排行内文字和嵌套列表，按连续行内片段分段，保留原顺序。
          const result: any[] = []; let pending: (Node | string)[] = [];
          const flushInline = () => { if (pending.length) { result.push({ type: 'paragraph', content: inline({ tag: 'p', attrs: {}, children: pending }) }); pending = []; } };
          for (const child of item.children) {
            if (typeof child === 'string' || ['b', 'strong', 'i', 'em', 'u', 'del', 's', 'a', 'span', 'br'].includes(child.tag)) pending.push(child);
            else { flushInline(); result.push(...body(child)); }
          }
          flushInline();
          if (!result.length) throw new Error('列表项全部无法转换，排除范围包含整个列表');
          return result;
        }) }];
      }
      if (t === 'callout' || t === 'blockquote' || t === 'quote') {
        const result: any = { type: t === 'callout' ? 'callout' : 'quote', content: requiredChildren(n) };
        if (t === 'callout') {
          if (a.emoji) result.icon = a.emoji;
          if (a['background-color']) result.background_color = color(a['background-color']);
          if (a['border-color']) result.border_color = color(a['border-color']);
        }
        return [result];
      }
      if (t === 'pre') {
        if (n.children.some(c => typeof c !== 'string' && c.tag !== 'code')) throw new Error('代码块包含未适配内容');
        const result = [{ type: 'code', text: plain(n), ...(a.lang ? { language: a.lang } : {}), ...(a.wrap ? { wrap: a.wrap === 'true' } : {}) }];
        if (a.caption?.trim()) result.push({ type: 'paragraph', content: [{ type: 'text', text: a.caption }] } as any);
        return result;
      }
      if (t === 'hr') return [{ type: 'divider' }];
      return reject(n, `当前不支持的内容：${t}${a.type ? ' / ' + a.type : ''}（含内部内容）`);
    } catch (error) { return reject(n, error instanceof Error ? error.message : '内容无法转换'); }
  }

  const doc: any = { schema_version: '0.1.0', duty: { id: options.dutyId, name: options.dutyName, title: snapshot.title, ...(options.dutyType ? { type: options.dutyType } : {}) }, phases: [], phase_contents: [] };
  let phase: any, sections: any[] = [], current: any, global = 'introduction', mechanism: string | undefined;
  let currentLevel = 0, currentSource: Node | undefined;
  const recommendations = new Set<string>(), solutionLevels = new Map<string, number>();
  const seenGlobals = new Set(['introduction']);
  const normalize = (s: string) => s.normalize('NFKC').trim();
  function flush(): void {
    if (!current) return;
    if (current.content.length) sections.push(current);
    else if (current.title && currentSource) reject(currentSource, `正文全部为空或不支持，连带排除空区块标题：${current.title}`);
    else warn(root, `空区块未输出：${current.type}；没有连带删除已有正文`);
    current = undefined;
    currentSource = undefined;
  }
  function startPhase(n: Node, number: string, title: string): void {
    flush();
    const phaseId = `p${Number(number)}`.replace('.', '-');
    if (doc.phases.some((p: any) => p.id === phaseId)) { block(n, '阶段重复进入，不能重排正文；请修正阶段标题'); return; }
    phase = { id: phaseId, title, name: `P${Number(number)}`, mechanics: [] };
    sections = []; doc.phases.push(phase); doc.phase_contents.push({ phase_id: phase.id, sections });
    mechanism = undefined; currentLevel = 0; location = title;
    if (splitPhases) reportingUnit = phaseId;
  }
  function startMechanic(n: Node, title: string): void {
    flush(); mechanism = id(n, 'm');
    phase.mechanics.push({ id: mechanism, name: title });
    sections.push({ id: mechanism, type: 'separator', title });
    current = { id: id(n, 'body'), type: 'mechanic', content: [] };
    currentLevel = 0; location = `${phase.title} / ${title}`;
  }
  for (const child of root.children) {
    if (typeof child === 'string') { if (child.trim()) block(root, '顶层出现无归属文字'); continue; }
    if (child.tag === 'title') continue;
    const level = /^h[1-9]$/.test(child.tag) ? Number(child.tag[1]) : 0;
    const original = plain(child), title = normalize(original);
    if (level) {
      if (/\[(分P阶段|机制名)\]/i.test(title)) { block(child, '存在模板占位标题，需回飞书明确归属'); }
      const globalName = level === 1 ? ({ '攻略须知': 'introduction', '战前准备': 'preparation' } as any)[title] : undefined;
      if (globalName) {
        if (phase || (seenGlobals.has(globalName) && globalName !== global)) block(child, '全局内容与阶段或其他全局内容交错，不能静默重排');
        flush(); global = globalName; seenGlobals.add(global); location = title; continue;
      }
      const purePhase = title.match(splitPhases ? /^P(\d+(?:\.5)?)(?:阶段)?$/i : /^P(\d+)(?:阶段)?$/i);
      const namedPhase = options.profile === 'standard' && level === 1 ? title.match(splitPhases ? /^P(\d+(?:\.5)?)\s*[·:：-]\s*(.+)$/i : /^P(\d+)\s*[·:：-]\s*(.+)$/i) : null;
      if (purePhase || namedPhase) { startPhase(child, (purePhase ?? namedPhase)![1], original); continue; }
      const composite = title.match(splitPhases ? /^P(\d+(?:\.5)?)\s*[·:：-]\s*(.+)$/i : /^P(\d+)\s*[·:：-]\s*(.+)$/i);
      if (composite && options.profile === 'legacy') {
        if (!phase || phase.id !== `p${Number(composite[1])}`.replace('.', '-')) startPhase(child, composite[1], `P${Number(composite[1])}`);
        if (phase) startMechanic(child, original); continue;
      }
      if (phase && options.profile === 'standard' && level === 2) { startMechanic(child, original); continue; }
      const purpose = /(?:^|[·:：])\s*解法/.test(title) ? 'solution' : /^(?:注意事项|(?:防护|治疗|进攻)职能注意)/.test(title) ? 'note' : title === '机制说明' ? 'mechanic' : undefined;
      if (phase && purpose && (options.profile === 'legacy' || level === 3) && !(currentLevel && level > currentLevel && current?.type === 'solution' && purpose !== 'solution')) {
        flush(); current = { id: id(child, 's'), type: purpose, title: original, content: [] }; currentLevel = level; currentSource = child;
        if (purpose === 'solution') {
          if (/\bBeta\b/i.test(title)) current.beta = true;
          if (/[（(]推荐[）)]/.test(original)) recommendations.add(current.id);
          solutionLevels.set(current.id, level);
        }
        if (purpose === 'note') {
          const roles = [['防护', 'tank'], ['治疗', 'healer'], ['进攻', 'dps']].filter(([label]) => title.includes(label)).map(([, role]) => role);
          if (roles.length) current.roles = roles;
        }
        continue;
      }
      if (phase && currentLevel && level <= currentLevel) { flush(); currentLevel = 0; }
      if (phase && level <= 2 && options.profile === 'legacy') warn(child, '历史标题保留为正文小标题，未据级别推断机制导航');
    }
    const converted = body(child);
    if (phase) {
      if (!current && converted.length) current = { id: id(child, 's'), type: mechanism ? 'mechanic' : 'content', content: [] };
      if (current) current.content.push(...converted);
    } else if (converted.length) (doc.duty[global] ??= []).push(...converted);
  }
  flush();
  for (const content of doc.phase_contents) {
    const result: any[] = [];
    for (let i = 0; i < content.sections.length;) {
      const section = content.sections[i];
      if (section.type !== 'solution') { result.push(section); i++; continue; }
      const group = [section]; let j = i + 1;
      while (content.sections[j]?.type === 'solution' && solutionLevels.get(section.id) === solutionLevels.get(content.sections[j].id)) group.push(content.sections[j++]);
      if (group.length === 1) result.push(section);
      else {
        const value: any = { id: `group-${section.id}`, type: 'multi_solution', solutions: group.map(({ type, ...rest }: any) => rest) };
        const recommended = group.filter(x => recommendations.has(x.id));
        if (recommended.length === 1) value.defaultSolution = recommended[0].id;
        if (recommended.length > 1) warn(root, '同组有多个推荐解法，未设置默认解法');
        result.push(value);
      }
      i = j;
    }
    content.sections = result;
  }
  reportingUnit = undefined;
  if (!doc.phases.length) block(root, '未识别到阶段，请使用明确的 P1 阶段标题；不自动伪造阶段');
  for (const reason of validateStrategy(doc)) issue(blockers, root, 'VALIDATION', reason);
  const digest = fingerprint({ snapshot, options, unsupported, document: doc, warnings, blockers });
  return { document: doc, unsupported, warnings, blockers, digest };
}

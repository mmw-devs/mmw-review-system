import { validateStrategy } from './validation.ts';

// 输出源码或校验规则变化时升级；历史任务不重新生成。
export const ASTRO_EXPORT_VERSION = 'astro-3';
export const isReviewAssetPath = (source: string) => /^assets\/[a-f0-9]{24}\.(png|jpg|gif|webp)$/.test(source);
export type AstroExport = {
  files: { name: string; content: string }[];
  assets: { source: string; target: string }[];
};

type Value = Record<string, any>;
const upstream = '7b140bd18a71eb4a1304aa0c16ae7dbe41802fc1';
const escape = (value: string | number) => String(value).replace(/[&<>"'{}\r]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '{': '&#123;', '}': '&#125;', '\r': '&#13;' })[c]!);
const attr = (name: string, value: unknown) => value === undefined ? '' : ` ${name}="${escape(String(value))}"`;
const style = (values: string[]) => values.length ? attr('style', values.join(';')) : '';

// 双重 JSON 序列化只产生字符串数据，花括号不能成为模板表达式或用户代码。
const literal = (value: unknown) => `JSON.parse(${JSON.stringify(JSON.stringify(value)).replace(/[<>&{}\u2028\u2029]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)})`;
// 站内路径统一跟随目标站 BASE_URL，外部地址和本页锚点保持原义。
const urlAttr = (name: string, source: string) => source.startsWith('/') ? ` ${name}={siteBase + ${literal(source.slice(1))}}` : attr(name, source);
function safeUrl(value: string): string {
  if (/[\u0000-\u0020\u007f\\]/.test(value)) throw new Error('攻略站导出地址含不安全字符');
  if (/^https?:\/\//.test(value)) {
    const url = new URL(value);
    if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw new Error('攻略站导出地址不得包含凭据或不安全协议');
    return value;
  }
  if (/^#[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(value) || /^\/(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\/?(?:#[a-z0-9_-]+)?$/.test(value)) return value;
  throw new Error('攻略站导出地址格式不受支持');
}

const pageCss = `<style>
  .review-body{line-height:1.8;overflow-wrap:anywhere}.review-paragraph{white-space:pre-wrap;margin:0.65rem 0}.review-heading{font-weight:700;margin:1rem 0 0.5rem}.review-body figure{margin:1rem 0}.review-body img{display:inline-block;max-width:100%;height:auto}.review-body figcaption{font-size:0.9em;margin-top:0.4rem}.review-body ul{list-style:disc;padding-left:1.5rem}.review-body ol{list-style:decimal;padding-left:1.5rem}.review-table-scroll{overflow-x:auto;max-width:100%}.review-table{border-collapse:collapse;min-width:100%}.review-table td,.review-table th{border:1px solid currentColor;padding:0.5rem;vertical-align:top}.review-table th{font-weight:700}.review-columns{display:flex;gap:1rem}.review-columns>div{min-width:0}.review-callout,.review-quote{border-left:3px solid currentColor;padding:0.5rem 1rem;margin:1rem 0}.review-code{overflow:auto;padding:1rem;tab-size:4}.review-beta,.review-roles{font-size:0.9em;margin-bottom:0.5rem}.review-index{max-width:80rem;margin:auto;padding:2rem}.review-index h1{font-size:1.75rem;font-weight:700}.review-index h2{font-size:1.35rem;font-weight:700;margin-top:1.5rem}.review-metadata dt{font-weight:700}.review-metadata dd{margin-bottom:0.5rem}@media(max-width:800px){.review-columns{flex-direction:column}}
</style>`;

/** 将已审核的 JSON 内容序列化为攻略站原生源码，不读取文件、不下载资源、不执行用户文字。 */
export function generateAstro(document: unknown): AstroExport {
  let errors: string[];
  try { errors = validateStrategy(document); } catch { throw new Error('攻略 JSON 结构无效，无法导出攻略站文件'); }
  if (errors.length) throw new Error(`攻略 JSON 校验失败：${errors.join('；')}`);
  const doc = document as Value;
  const assets = new Map<string, string>();
  const imports = new Set<string>();
  const component = (name: string) => { imports.add(name); return name; };

  // 合法 JSON 仍可能包含 HTML 无法无损保存的控制字符；拒绝而非静默替换。
  function checkStrings(value: unknown): void {
    if (typeof value === 'string' && /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new Error('攻略内容含无法保留的控制字符');
    if (value && typeof value === 'object') for (const child of Object.values(value)) checkStrings(child);
  }
  checkStrings(doc);
  function imageSource(source: string): string {
    if (/^https?:\/\//.test(source)) return safeUrl(source);
    if (!/^assets\/[A-Za-z0-9_-]+\.(?:png|jpg|jpeg|gif|webp|avif)$/i.test(source)) throw new Error('攻略站本地图片必须是 assets/ 下的 PNG、JPEG、GIF、WebP 或 AVIF 文件');
    const target = `public/review-assets/${doc.duty.id}/${source.slice(7)}`;
    assets.set(source, target);
    return target.slice('public'.length);
  }
  function inlines(parts: Value[]): string {
    return parts.map(part => {
      if (part.type === 'hard_break') return '<br />';
      const s = part.style ?? {}, styles: string[] = [];
      if (s.bold !== undefined) styles.push(`font-weight:${s.bold ? '700' : '400'}`);
      if (s.italic !== undefined) styles.push(`font-style:${s.italic ? 'italic' : 'normal'}`);
      if (s.underline !== undefined || s.strike !== undefined) styles.push(`text-decoration:${[s.underline ? 'underline' : '', s.strike ? 'line-through' : ''].filter(Boolean).join(' ') || 'none'}`);
      if (s.color) styles.push(`color:${s.color}`);
      if (s.background_color) styles.push(`background-color:${s.background_color}`);
      if (s.font_size_px !== undefined) styles.push(`font-size:${s.font_size_px}px`);
      const text = `<span${style(styles)}>${escape(part.text)}</span>`;
      return part.href ? `<a${urlAttr('href', safeUrl(part.href))}>${text}</a>` : text;
    }).join('');
  }
  function body(blocks: Value[]): string {
    return blocks.map(block => {
      switch (block.type) {
        case 'paragraph': case 'heading': {
          const tag = block.type === 'paragraph' ? 'p' : `h${Math.min(block.level, 6)}`;
          const styles = [];
          if (block.align) styles.push(`text-align:${block.align}`);
          if (block.indent !== undefined) styles.push(`padding-inline-start:${block.indent}em`);
          return `<${tag} class="${block.type === 'paragraph' ? 'review-paragraph' : 'review-heading'}"${style(styles)}${block.level > 6 ? attr('aria-level', block.level) : ''}>${inlines(block.content)}</${tag}>`;
        }
        case 'image': return `<figure${style(block.align ? [`text-align:${block.align}`] : [])}><img${urlAttr('src', imageSource(block.src))}${attr('alt', block.alt ?? '')}${attr('width', block.width)}${attr('height', block.height)} loading="lazy" />${block.caption ? `<figcaption>${inlines(block.caption)}</figcaption>` : ''}</figure>`;
        case 'list': {
          const tag = block.ordered ? 'ol' : 'ul';
          return `<${tag}${attr('start', block.start)}>${block.items.map((item: Value[]) => `<li>${body(item)}</li>`).join('')}</${tag}>`;
        }
        case 'table': {
          const columns = block.column_widths_px ? `<colgroup>${block.column_widths_px.map((width: number) => `<col${style([`width:${width}px`])} />`).join('')}</colgroup>` : '';
          return `<div class="review-table-scroll"><table class="review-table">${columns}<tbody>${block.rows.map((row: Value) => `<tr>${row.cells.map((cell: Value) => {
            const tag = cell.header ? 'th' : 'td';
            return `<${tag}${attr('rowspan', cell.row_span)}${attr('colspan', cell.col_span)}${style(cell.background_color ? [`background-color:${cell.background_color}`] : [])}>${body(cell.content)}</${tag}>`;
          }).join('')}</tr>`).join('')}</tbody></table></div>`;
        }
        case 'columns': return `<div class="review-columns">${block.columns.map((column: Value) => `<div${style([`flex:${column.width_weight ?? 1} 1 0`])}>${body(column.content)}</div>`).join('')}</div>`;
        case 'callout': {
          const styles = [];
          if (block.background_color) styles.push(`background-color:${block.background_color}`);
          if (block.border_color) styles.push(`border-color:${block.border_color}`);
          return `<aside class="review-callout"${style(styles)}>${block.icon ? `<span>${escape(block.icon)}</span>` : ''}${body(block.content)}</aside>`;
        }
        case 'quote': return `<blockquote class="review-quote">${body(block.content)}</blockquote>`;
        case 'code': return `<pre class="review-code"${style([`white-space:${block.wrap ? 'pre-wrap' : 'pre'}`])}${attr('data-language', block.language)}><code>${escape(block.text)}</code></pre>`;
        case 'divider': return '<hr />';
        default: throw new Error('攻略正文包含尚未适配的类型');
      }
    }).join('\n');
  }
  const beta = (value: unknown) => value === true ? '<p class="review-beta">Beta（测试解法）</p>' : '';
  const wrappedBody = (blocks: Value[]) => `<div class="review-body">${body(blocks)}</div>`;
  function section(value: Value): string {
    const id = attr('id', value.id), title = attr('title', value.title);
    if (value.type === 'separator') return `<${component('SeparatorSection')}${id}${title} />`;
    if (value.type === 'collapse') {
      // 上游折叠组件不转发 id/title；用包裹节点保存锚点，两个命名插槽保持摘要与详情分离。
      return `<div${id}><${component('CollapseSection')}><div slot="summary" class="review-body">${value.title ? `<h3 class="review-heading">${escape(value.title)}</h3>` : ''}${body(value.summary)}</div><${component('ContentSection')} slot="details">${wrappedBody(value.details)}</ContentSection></CollapseSection></div>`;
    }
    if (value.type === 'multi_solution') {
      const titles = new Set(value.solutions.map((item: Value) => item.title));
      if (titles.size !== value.solutions.length) throw new Error('攻略站多解法要求同组方案标题唯一，请修改重复标题');
      if (titles.has('__proto__')) throw new Error('解法标题不能使用模板保留名称 __proto__，请修改标题');
      const selected = value.solutions.find((item: Value) => item.id === value.defaultSolution) ?? value.solutions[0];
      const solutions = value.solutions.map((item: Value) => ({ id: item.id, title: item.title }));
      return `<div${id}>${value.title ? `<${component('ContentSection')}><h3 class="review-heading">${escape(value.title)}</h3></ContentSection>` : ''}<${component('MultiSolutionSection')} solutions={${literal(solutions)}} defaultSolution={${literal(selected.title)}} client:load>${value.solutions.map((item: Value) => `<div${attr('slot', item.title)} class="review-body"${attr('data-beta', item.beta)}>${beta(item.beta)}${body(item.content)}</div>`).join('\n')}</MultiSolutionSection></div>`;
    }
    const names: Record<string, string> = { mechanic: 'MechanicSection', solution: 'SolutionSection', note: 'NoteSection', content: 'ContentSection' };
    const name = names[value.type];
    if (!name) throw new Error('攻略区块包含尚未适配的类型');
    const roles: Record<string, string> = { tank: '防护', healer: '治疗', dps: '进攻' };
    return `<${component(name)}${id}${name === 'ContentSection' ? '' : title}><div class="review-body"${attr('data-beta', value.beta)}>${name === 'ContentSection' && value.title ? `<h3 class="review-heading">${escape(value.title)}</h3>` : ''}${value.roles ? `<p class="review-roles">适用职能：${value.roles.map((role: string) => roles[role]).join('、')}</p>` : ''}${beta(value.beta)}${body(value.content)}</div></${name}>`;
  }
  function page(content: string, phase?: Value): string {
    const layout = phase ? 'DutyStratLayout' : 'DutyLayout';
    const header = [`import ${layout} from '@/layouts/${layout}.astro';`, ...[...imports].sort().map(name => `import ${name} from '@/components/section/${name}.${name === 'MultiSolutionSection' ? 'vue' : 'astro'}';`),
      "const siteBase = import.meta.env.BASE_URL.replace(/\\/?$/, '/');",
      "if (!Astro.url.pathname.startsWith(siteBase)) throw new Error('页面地址与站点基础路径不一致');",
      "const route = Astro.url.pathname.slice(siteBase.length).split('/').filter(Boolean);",
      phase ? "const dutyId = route.slice(0, -1).join('/');" : "const dutyId = (route.at(-1) === 'index' ? route.slice(0, -1) : route).join('/');",
      "if (!dutyId) throw new Error('请将页面放入攻略站已配置的副本目录');"];
    const base = phase?.base ? Number(phase.base.split(':')[0]) * 60 + Number(phase.base.split(':')[1]) : 0;
    if (!Number.isFinite(base)) throw new Error('阶段时间基准超出可表示范围');
    return `---\n${header.join('\n')}\n---\n\n<${layout} dutyId={dutyId}${phase ? ` base={${base}}` : ''}>\n${content}\n</${layout}>\n\n${pageCss}\n`;
  }
  const files: AstroExport['files'] = [];
  const metadata = ['name', 'short', 'type', 'description'].filter(key => doc.duty[key] !== undefined).map(key => `<dt>${({ name: '副本名称', short: '简称', type: '分类', description: '简介' } as Record<string, string>)[key]}</dt><dd>${escape(doc.duty[key])}</dd>`).join('');
  const index = `<main class="review-body review-index"><h1>${escape(doc.duty.title)}</h1><dl class="review-metadata">${metadata}</dl>${doc.duty.banner ? `<figure><img${urlAttr('src', imageSource(doc.duty.banner))}${attr('alt', doc.duty.name)} /></figure>` : ''}${doc.duty.videoLink ? `<p><a${urlAttr('href', safeUrl(doc.duty.videoLink))}>攻略视频</a></p>` : ''}${doc.duty.introduction ? `<h2>攻略须知</h2>${body(doc.duty.introduction)}` : ''}${doc.duty.preparation ? `<h2>战前准备</h2>${body(doc.duty.preparation)}` : ''}<h2>阶段攻略</h2><ul>${doc.phases.map((phase: Value) => `<li><a${phase.href ? urlAttr('href', safeUrl(phase.href)) : ` href={siteBase + dutyId + '/' + ${literal(phase.id)}}`}>${escape(phase.title)}</a></li>`).join('')}</ul></main>`;
  files.push({ name: 'pages/index.astro', content: page(index) });
  for (const phase of doc.phases) {
    if (phase.id === 'index') throw new Error('阶段 ID 不得使用保留名称 index');
    if (phase.href && phase.href.replace(/\/$/, '').split('/').at(-1) !== phase.id) throw new Error('阶段链接末尾必须与阶段 ID 一致，避免页面文件与导航冲突');
    imports.clear();
    const content = doc.phase_contents.find((item: Value) => item.phase_id === phase.id)!;
    const heading = `<${component('ContentSection')}><div class="review-body"><h1 class="review-heading">${escape(phase.title)}</h1>${phase.subtitle ? `<p>${escape(phase.subtitle)}</p>` : ''}</div></ContentSection>`;
    files.push({ name: `pages/${phase.id}.astro`, content: page(`${heading}\n${content.sections.map(section).join('\n')}`, phase) });
  }
  files.push({ name: 'navigation.json', content: JSON.stringify({ phases: doc.phases.map((phase: Value) => ({ ...phase, mechanics: phase.mechanics.map((mechanic: Value) => ({ ...mechanic, href: mechanic.href ?? `#${mechanic.id}` })) })) }, null, 2) + '\n' });
  files.push({ name: 'README.md', content: `# 攻略站文件使用说明\n\n本包由审核服务生成，目标是 mogworks/xivstrat 的 Astro 源码格式。组件接口核对版本：${upstream}。\n\n1. 将 pages/ 中的页面放入攻略站 src/pages/ 下实际的版本与副本目录，保留文件名。页面使用目标站 BASE_URL 处理部署前缀，再根据实际 URL 推导 dutyId。\n2. 将 public/ 中的目录合并到攻略站 public/，保持路径不变。外部 HTTP(S) 图片仅保留引用，未下载，也未验证可访问性。\n3. 先在 src/data/duties/ 中配置对应的副本元数据。navigation.json 供维护者合并导航时参考；补全各阶段的完整 href 和缺失的 subtitle。上游阶段字段为 href/title/subtitle/name/mechanics，机制字段为 href/name；id/base 和多语言名称作为合并参考保留。已有 phase.href 须与实际部署目录一致。\n4. 副本分类、横幅、日期、状态、首页入口等站点必填字段需维护者配置。index.astro 展示输入中的副本信息、攻略须知与战前准备。\n5. 在攻略站运行原有检查与构建，检查实际浏览器显示、导航、多解法切换、折叠和图片后再发布。\n\n颜色采用输入的六位十六进制色值；背景色、字号和表格跨度等按 JSON 保留。它们不自动切换为 Span 的主题色，也不会随着攻略站精简阅读模式自动去色。代码语言仅标记，不新增语法高亮。多解法的默认 ID 已转换为上游要求的标题；同组标题重复会阻止导出。\n` });
  const allNames = [...files.map(file => file.name), ...assets.values()];
  if (new Set(allNames).size !== allNames.length) throw new Error('攻略站导出文件路径重复');
  for (const name of allNames) {
    const index = name.lastIndexOf('/');
    if (Buffer.byteLength(name) > 100 && (index < 0 || Buffer.byteLength(name.slice(0, index)) > 155 || Buffer.byteLength(name.slice(index + 1)) > 100)) throw new Error('攻略站导出文件名或目录过长，无法放入归档包');
  }
  return { files, assets: [...assets].map(([source, target]) => ({ source, target })) };
}

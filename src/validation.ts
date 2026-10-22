import { readFileSync } from 'node:fs';

type Value = any;
const schema = JSON.parse(readFileSync(new URL('../schemas/strategy.schema.json', import.meta.url), 'utf8'));

// 仅实现仓库契约使用的关键词；新增未知关键词时拒绝启动，避免假通过。
const keywords = new Set(['$defs', '$id', '$ref', '$schema', 'additionalProperties', 'allOf', 'anyOf', 'const', 'description', 'enum', 'exclusiveMinimum', 'format', 'if', 'items', 'maximum', 'minItems', 'minLength', 'minimum', 'not', 'oneOf', 'pattern', 'properties', 'required', 'then', 'title', 'type', 'uniqueItems']);
function checkKeywords(s: Value): void {
  for (const key of Object.keys(s)) if (!keywords.has(key)) throw new Error(`契约出现尚未支持的校验规则：${key}`);
  for (const key of ['$defs', 'properties']) for (const child of Object.values(s[key] ?? {})) checkKeywords(child);
  for (const key of ['allOf', 'anyOf', 'oneOf']) for (const child of s[key] ?? []) checkKeywords(child);
  for (const key of ['if', 'then', 'not', 'items']) if (s[key]) checkKeywords(s[key]);
}
checkKeywords(schema);

function errors(s: Value, value: Value, path: string): string[] {
  if (s.$ref) return errors(schema.$defs[s.$ref.replace('#/$defs/', '')], value, path);
  const out: string[] = [];
  const fail = (reason: string) => out.push(`${path}：${reason}`);
  if (s.oneOf && s.oneOf.filter((x: Value) => errors(x, value, path).length === 0).length !== 1) fail('不符合任一唯一字段结构');
  if (s.anyOf && !s.anyOf.some((x: Value) => errors(x, value, path).length === 0)) fail('字段取值不符合约定');
  for (const child of s.allOf ?? []) out.push(...errors(child, value, path));
  if (s.not && errors(s.not, value, path).length === 0) fail('包含禁止的字段组合');
  if (s.if && errors(s.if, value, path).length === 0 && s.then) out.push(...errors(s.then, value, path));
  if ('const' in s && value !== s.const) fail('固定值不匹配');
  if (s.enum && !s.enum.includes(value)) fail('不在允许值中');
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if (s.type && (s.type === 'integer' ? !Number.isInteger(value) : s.type !== type)) { fail('字段类型不正确'); return out; }
  if (typeof value === 'string') {
    if (s.minLength && [...value].length < s.minLength) fail('文字长度不足');
    if (s.pattern && !new RegExp(s.pattern, 'u').test(value)) fail('文字格式不正确');
    if (s.format === 'uri') { try { new URL(value); } catch { fail('地址格式不正确'); } }
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (s.minimum !== undefined && value < s.minimum) || (s.maximum !== undefined && value > s.maximum) || (s.exclusiveMinimum !== undefined && value <= s.exclusiveMinimum)) fail('数值超出范围');
  }
  if (Array.isArray(value)) {
    if (s.minItems && value.length < s.minItems) fail('缺少必填内容');
    if (s.uniqueItems && new Set(value.map(x => JSON.stringify(x))).size !== value.length) fail('数组存在重复项');
    if (s.items) value.forEach((x, i) => out.push(...errors(s.items, x, `${path}[${i}]`)));
  } else if (value && typeof value === 'object') {
    for (const key of s.required ?? []) if (!(key in value)) fail(`缺少 ${key}`);
    for (const [key, child] of Object.entries(value)) {
      if (s.properties?.[key]) out.push(...errors(s.properties[key], child, `${path}.${key}`));
      else if (s.additionalProperties === false) fail(`不允许字段 ${key}`);
    }
  }
  return out;
}

export function validateStrategy(doc: Value): string[] {
  const out = errors(schema, doc, '$');
  if (out.length) return out;
  const phaseIds = new Set<string>();
  const fail = (s: string) => out.push(s);
  for (const phase of doc.phases) {
    if (phaseIds.has(phase.id)) fail('阶段 ID 重复');
    phaseIds.add(phase.id);
    const bodies = doc.phase_contents.filter((x: Value) => x.phase_id === phase.id);
    if (bodies.length !== 1) { fail('阶段必须恰好对应一份正文'); continue; }
    const ids = new Set<string>(), separators = new Set<string>();
    for (const section of bodies[0].sections) {
      for (const item of [section, ...(section.solutions ?? [])]) {
        if (ids.has(item.id)) fail('区块或方案 ID 重复');
        ids.add(item.id);
      }
      if (section.type === 'separator') separators.add(section.id);
      if (section.defaultSolution && !section.solutions.some((s: Value) => s.id === section.defaultSolution)) fail('默认解法不存在');
    }
    const nav = new Set<string>();
    for (const mechanic of phase.mechanics) {
      if (nav.has(mechanic.id) || !separators.has(mechanic.id) || (mechanic.href && mechanic.href !== `#${mechanic.id}`)) fail('机制导航和正文不一致');
      nav.add(mechanic.id);
    }
    walk(bodies[0], ids);
    function hasBody(value: Value): boolean {
      if (!value || typeof value !== 'object') return false;
      if (value.type === 'text') return Boolean(value.text.trim());
      if (value.type === 'code') return Boolean(value.text.trim());
      if (value.type === 'image') return true;
      return Object.entries(value).some(([key, child]) => key !== 'title' && (Array.isArray(child) ? child.some(hasBody) : hasBody(child)));
    }
    if (!hasBody(bodies[0])) fail('阶段只有标题或空段落，缺少可用正文');
  }
  if (doc.phase_contents.some((x: Value) => !phaseIds.has(x.phase_id))) fail('正文引用了不存在的阶段');
  walk(doc.duty, new Set());
  return out;

  function walk(value: Value, ids: Set<string>): void {
    if (!value || typeof value !== 'object') return;
    if (value.href?.startsWith('#') && !ids.has(value.href.slice(1))) fail('正文锚点不存在或缺少页面上下文');
    if (typeof value.href === 'string' || typeof value.src === 'string') {
      for (const link of [value.href, value.src]) if (typeof link === 'string' && /^https?:/.test(link)) {
        try { const u = new URL(link); if (u.username || u.password) fail('地址不得包含凭据'); } catch { fail('地址无效'); }
      }
    }
    if (value.type === 'table') {
      const occupied: boolean[][] = value.rows.map(() => []);
      value.rows.forEach((row: Value, r: number) => {
        let c = 0;
        for (const cell of row.cells) {
          while (occupied[r][c]) c++;
          const height = cell.row_span ?? 1, width = cell.col_span ?? 1;
          if (r + height > occupied.length || width > 10000) { fail('表格跨度越界'); continue; }
          for (let y = r; y < r + height; y++) for (let x = c; x < c + width; x++) {
            if (occupied[y][x]) fail('表格单元格重叠');
            occupied[y][x] = true;
          }
          c += width;
        }
      });
      const width = Math.max(...occupied.map(row => row.length));
      if (!width || occupied.some(row => row.length !== width || Array.from({ length: width }, (_, i) => row[i]).some(x => !x))) fail('表格存在孔洞');
      if (value.column_widths_px && value.column_widths_px.length !== width) fail('表格列宽数量不匹配');
    }
    for (const child of Object.values(value)) if (Array.isArray(child)) child.forEach(x => walk(x, ids)); else walk(child, ids);
  }
}

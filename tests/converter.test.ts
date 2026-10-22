import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { convert, parseXml } from '../src/converter.ts';
import type { Snapshot } from '../src/converter.ts';
import { validateStrategy } from '../src/validation.ts';
import { sheetTable, imageExtension, documentUrl } from '../src/feishu.ts';

const options = { dutyId: 'demo', dutyName: '测试副本', profile: 'standard' as const };
const snapshot = (content: string): Snapshot => ({ documentId: 'doc', revision: 1, title: '测试攻略', url: 'https://example.feishu.cn/docx/doc', content, images: {}, sheets: {} });
const stage = '<h1 id="phase">P1</h1><h2 id="mechanic">机制</h2>';
const para = '<p id="description">说明正文</p>';

test('当前两个完整示例通过结构与关联校验', () => {
  for (const name of ['enou-strategy', 'strategy-all-fields']) {
    const d = JSON.parse(readFileSync(new URL(`../docs/examples/${name}.v0.1.json`, import.meta.url), 'utf8'));
    assert.deepEqual(validateStrategy(d), []);
  }
});
test('富文本、顺序、多解法、内部备注及稳定标识', () => {
  const input = snapshot(stage + '<p id="text"><b><span text-color="rgb(255,0,0)">红色</span></b><br/><del>旧文字</del></p><h3 id="s1">解法：A（推荐）</h3><p id="a">A正文</p><h4 id="note">治疗职能注意</h4><p id="n">留在A</p><h3 id="s2">解法：B（Beta）</h3><p id="b">B正文</p>');
  const r = convert(input, options); assert.deepEqual(r.blockers, []); assert.deepEqual(r.unsupported, []);
  const sections = r.document.phase_contents[0].sections;
  assert.equal(sections[1].content[0].content[0].style.color, '#ff0000');
  assert.equal(sections[2].type, 'multi_solution');
  assert.equal(sections[2].solutions[0].content[1].type, 'heading');
  assert.equal(sections[2].solutions[1].beta, true);
  assert.equal(sections[2].defaultSolution, sections[2].solutions[0].id);
  const renamed = convert({ ...input, content: input.content.replace('机制</h2>', '改名</h2>') }, options);
  assert.equal(renamed.document.phases[0].mechanics[0].id, r.document.phases[0].mechanics[0].id);
});
test('不支持组件、视频、裁剪图片均列清单；普通文字时间轴保留', () => {
  const r = convert(snapshot(stage + para + '<readonly-block id="timeline" type="isv"/><video id="v"/><img id="crop" crop="0,0,1,1"/><p id="time">时间轴：00:10 全屏攻击</p>'), options);
  assert.equal(r.unsupported.length, 3); assert.deepEqual(r.blockers, []);
  assert.ok(JSON.stringify(r.document).includes('00:10'));
  assert.ok(!JSON.stringify(r.document).includes('embed'));
});
test('容器整体排除必须扩大明确清单，不留下空表格或单列分栏', () => {
  const r = convert(snapshot(stage + para + '<grid id="grid"><column id="col1"><video id="v"/></column><column id="col2"><p>其他</p></column></grid>'), options);
  assert.ok(r.unsupported.some(x => x.source === 'grid'));
  assert.deepEqual(r.blockers, []);
});
test('无阶段、阶段重复、全局内容交错会阻断', () => {
  for (const content of [para, stage + para + '<h1 id="again">P1</h1>', stage + para + '<h1 id="intro">攻略须知</h1><p>结尾</p>']) assert.ok(convert(snapshot(content), options).blockers.length);
});
test('历史兼容不把普通二级标题误判为机制', () => {
  const r = convert(snapshot('<h2 id="p">P1阶段</h2><h3 id="m">P1·机制A</h3><p>正文</p><h2 id="sub">真假火雷</h2><p>子说明</p><h7 id="s">解法1</h7><p>操作</p>'), { ...options, profile: 'legacy' });
  assert.equal(r.document.phases[0].mechanics.length, 1);
  assert.ok(JSON.stringify(r.document).includes('真假火雷'));
  assert.deepEqual(r.blockers, []);
});
test('严格解析拒绝外部实体、截断及标签错位', () => {
  for (const xml of ['<!DOCTYPE root><p>x</p>', '<p>缺失', '<p><b>x</p></b>', '<p>&unknown;</p>']) assert.throws(() => parseXml(xml));
  assert.equal((parseXml('<p>&lt;文字&gt;&amp;&#10;</p>').children[0] as any).children[0], '<文字>&\n');
});
test('电子表格按显式坐标定位，不按数组顺序猜测', () => {
  const info = { range: 'A1:B2', column_widths: [{ cols: 'A:B', width: 100 }] };
  const data = { has_more: false, ranges: [{ actual_range: 'A1:B2', row_indices: [2, 1], col_indices: ['B', 'A'], cells: [[{ value: 'B2' }, { value: 'A2' }], [{ value: 'B1' }, { value: 'A1' }]] }] };
  const table = sheetTable(info, data);
  assert.equal(table.rows[0].cells[0].content[0].content[0].text, 'A1');
  assert.throws(() => sheetTable(info, { ...data, has_more: true }));
});
test('禁止媒体、未知字段、失效锚点和表格重叠', () => {
  const base = convert(snapshot(stage + para), options).document;
  for (const kind of ['video', 'audio', 'attachment']) {
    const d = structuredClone(base); d.duty.introduction = [{ type: 'media', kind, src: 'assets/a.mp4' }];
    assert.ok(validateStrategy(d).length);
  }
  const d = structuredClone(base); d.phases[0].mechanics[0].id = 'missing'; assert.ok(validateStrategy(d).length);
  const x = structuredClone(base); x.duty.extra = true; assert.ok(validateStrategy(x).length);
  const y = structuredClone(base); y.duty.introduction = [{ type: 'table', rows: [{ cells: [{ row_span: 2, content: [{ type: 'paragraph', content: [] }] }] }] }]; assert.ok(validateStrategy(y).length);
});
test('地址与图片签名检查拒绝非法来源', () => {
  assert.throws(() => documentUrl('https://feishu.cn.evil.example/wiki/abc'));
  assert.throws(() => documentUrl('http://example.feishu.cn/wiki/abc'));
  assert.throws(() => imageExtension(Buffer.from('<html>登录</html>')));
  assert.equal(imageExtension(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'png');
});
test('嵌套列表的富文本和原始代码空白保留', () => {
  const r = convert(snapshot(stage + '<ul id="l"><li><b>加粗</b><ul><li>下一层</li></ul>后续</li></ul><pre id="code"><code>  /echo 原文\n\n</code></pre>'), options);
  assert.deepEqual(r.unsupported, []); assert.deepEqual(r.blockers, []);
  const body = r.document.phase_contents[0].sections[1].content;
  assert.equal(body[0].items[0][0].content[0].style.bold, true);
  assert.equal(body[0].items[0][1].type, 'list');
  assert.equal(body[1].text, '  /echo 原文\n\n');
});
test('完整命令链使用模拟飞书拉取、下载、输出；验证分页与版本调用', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mmw-e2e-'));
  const script = path.join(dir, 'fake-cli.js'), out = path.join(dir, 'output');
  const xml = '<title id="doc">测试攻略</title>' + stage + para + '<img id="pic" src="token"/>';
  writeFileSync(script, `const fs = require('node:fs'); const a = process.argv.slice(2); let data;
if (a[0] === 'docs' && a[1] === '+fetch') data = { document: { document_id: 'doc', revision_id: 1, content: ${JSON.stringify(xml)} } };
else if (a[0] === 'api' && a[2].endsWith('/blocks')) data = { items: ['doc','phase','mechanic','description','pic'].map(block_id => ({block_id})), has_more: false };
else if (a[0] === 'api') data = { document: { revision_id: 1 } };
else if (a[1] === '+media-download') { fs.writeFileSync(a[a.indexOf('--output') + 1], Buffer.from([137,80,78,71,13,10,26,10])); data = { success: true }; }
else process.exit(1);
console.log(JSON.stringify({ok:true,data}));`);
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'https://example.feishu.cn/docx/doc', '--duty-id', 'demo', '--duty-name', '测试副本', '--profile', 'standard', '--output', out, '--cli-path', script, '--media-workdir', dir], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const runDir = path.join(out, readdirSync(out)[0]);
  const doc = JSON.parse(readFileSync(path.join(runDir, 'strategy.json'), 'utf8'));
  assert.deepEqual(validateStrategy(doc), []);
  const img = doc.phase_contents[0].sections[1].content[1];
  assert.ok(existsSync(path.join(runDir, img.src)));
});
test('快照改变后旧摘要失效；重新预检不能借旧授权导出', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mmw-digest-'));
  const input = snapshot(stage + para + '<video id="v"/>'), r = convert(input, options);
  writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ options, digest: r.digest, status: 'pending' }));
  input.content += '<audio id="a"/>';
  writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify(input));
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, '--resume', dir, ...args], { encoding: 'utf8' });
  assert.equal(run('--discard', r.digest).status, 1);
  assert.equal(run('--prepare').status, 2);
  assert.equal(run('--discard', r.digest).status, 1);
  assert.equal(existsSync(path.join(dir, 'strategy.json')), false);
});
test('命令行没有授权不输出，错误摘要拒绝，确认后输出且不覆盖', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mmw-cli-test-'));
  const input = snapshot(stage + para + '<video id="video"/>');
  const result = convert(input, options);
  writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify(input));
  writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ options, digest: result.digest, status: 'pending' }));
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, '--resume', dir, ...args], { encoding: 'utf8' });
  assert.equal(run().status, 2);
  assert.equal(existsSync(path.join(dir, 'strategy.json')), false);
  assert.equal(run('--discard', 'wrong').status, 1);
  const success = run('--discard', result.digest); assert.equal(success.status, 0, success.stderr);
  assert.deepEqual(validateStrategy(JSON.parse(readFileSync(path.join(dir, 'strategy.json'), 'utf8'))), []);
  assert.equal(run('--discard', result.digest).status, 1);
});

import { mkdir, mkdtemp, readFile, writeFile, link, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { convert, fingerprint } from './converter.ts';
import type { Options, Snapshot } from './converter.ts';
import { Feishu, documentUrl } from './feishu.ts';
import { validateStrategy } from './validation.ts';

const help = `飞书攻略 JSON 转换器

用法：node src/cli.ts <飞书地址> --duty-id <副本短ID> --duty-name <副本名称>
  --profile legacy|standard  标题识别方式，默认历史兼容 legacy
  --duty-type <类型>         可选副本分类
  --output <目录>            新任务的保存位置，默认 data/runs
  --prepare                  只获取、预检，不生成正式 JSON
  --resume <任务目录>        使用原快照继续，不重新读取飞书
  --confirm-presentation <摘要>  确认该次表现待确认清单，必须配合 --resume
  --cli-path <路径>          已安装飞书 CLI 或其 run.js
  --media-workdir <目录>     CLI 图片下载目录；Windows 下须为已存在的本地目录
  --identity user|bot        CLI 身份，默认 user

仅维护白名单；无法解析的内容必须修改原文，不能丢弃后导出。
表现待确认项需对照预览确认；非交互模式不会自动确认。
`;
function argsOf(argv: string[]) {
  const flags: Record<string, string | boolean> = {}, positional: string[] = [];
  const valued = ['duty-id', 'duty-name', 'duty-type', 'profile', 'output', 'resume', 'confirm-presentation', 'cli-path', 'media-workdir', 'identity'];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const key = arg.slice(2);
    if (key in flags) throw new Error('参数重复，请检查命令');
    if (['help', 'prepare'].includes(key)) flags[key] = true;
    else if (valued.includes(key) && argv[i + 1] && !argv[i + 1].startsWith('--')) flags[key] = argv[++i];
    else throw new Error('未知参数或缺少参数值；使用 --help 查看用法');
  }
  if (positional.length > 1) throw new Error('一次只接受一个文档地址');
  return { flags, url: positional[0] };
}
async function save(file: string, value: unknown) { await writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); }

async function main(): Promise<number> {
  const { flags, url } = argsOf(process.argv.slice(2));
  if (flags.help) { console.log(help); return 0; }
  let snapshot: Snapshot, options: Options, runDir: string, previous: any;
  if (flags.resume) {
    if (url || ['duty-id', 'duty-name', 'duty-type', 'profile', 'output', 'identity', 'cli-path', 'media-workdir'].some(k => flags[k])) throw new Error('继续任务时不能修改来源、字段或读取配置；请重新发起任务');
    runDir = path.resolve(String(flags.resume));
    try {
      previous = JSON.parse(await readFile(path.join(runDir, 'report.json'), 'utf8'));
      snapshot = JSON.parse(await readFile(path.join(runDir, 'snapshot.json'), 'utf8'));
      options = previous.options;
    } catch { throw new Error('无法读取任务快照或报告，请检查任务目录'); }
    if (previous.status === 'cancelled') throw new Error('本次转换已取消，请重新发起任务');
  } else {
    if (flags['confirm-presentation']) throw new Error('请先查看预检清单，再使用 --resume 和 --confirm-presentation 确认表现');
    if (!url || !flags['duty-id'] || !flags['duty-name']) throw new Error('需要文档地址、副本短 ID 和副本名称；使用 --help 查看用法');
    documentUrl(url);
    if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(String(flags['duty-id'])) || !String(flags['duty-name']).trim()) throw new Error('副本 ID 或名称格式无效');
    const profile = String(flags.profile ?? 'legacy');
    if (!['legacy', 'standard'].includes(profile)) throw new Error('标题方式只能为 legacy 或 standard');
    options = { dutyId: String(flags['duty-id']), dutyName: String(flags['duty-name']), profile: profile as Options['profile'], ...(flags['duty-type'] ? { dutyType: String(flags['duty-type']) } : {}) };
    const output = path.resolve(String(flags.output ?? 'data/runs')); await mkdir(output, { recursive: true });
    runDir = await mkdtemp(path.join(output, 'conversion-'));
    console.log(`任务目录：${runDir}`);
    const client = new Feishu(flags['cli-path'] as string | undefined, flags.identity as string | undefined);
    console.log('正在读取飞书正文……');
    snapshot = await client.document(url);
    await save(path.join(runDir, 'snapshot.json'), snapshot);
    console.log('正文已获取，正在检查图片和表格……');
    await client.resources(snapshot, runDir, flags['media-workdir'] as string | undefined, console.log);
  }
  // 所有决策绑定不可变内容摘要；继续任务时核对资源，不能把旧同意应用到新内容。
  for (const image of Object.values(snapshot.images)) if (image.src) {
    if (!/^assets\/[a-z0-9]+\.(png|jpg|gif|webp)$/.test(image.src)) throw new Error('快照中的资源路径不符合约定');
    let bytes: Buffer;
    try { bytes = await readFile(path.join(runDir, image.src)); } catch { throw new Error('快照图片缺失，请重新获取；旧清单不再适用'); }
    if (createHash('sha256').update(bytes).digest('hex') !== image.sha256) throw new Error('快照图片已变化，请重新获取');
  }
  const result = convert(snapshot, options);
  if (previous && previous.digest !== result.digest && !flags.prepare) throw new Error('快照、规则或清单已变化，旧选择无效；可使用 --resume 配合 --prepare 重新预检并确认新清单');
  const report: any = { version: 1, createdAt: previous?.createdAt ?? new Date().toISOString(), options, digest: result.digest, snapshotHash: fingerprint(snapshot), notices: result.notices, blockers: result.blockers, status: 'pending' };
  if (await stat(path.join(runDir, 'strategy.json')).then(() => true, () => false)) throw new Error('此任务已有正式产物，不覆盖已有文件');
  await save(path.join(runDir, 'report.json'), report);
  await save(path.join(runDir, 'candidate.json'), result.document);
  console.log(`预检：${result.notices.length} 项表现待确认，${result.blockers.length} 项必须修正。`);
  for (const item of result.notices) console.log(`表现待确认：${item.location}；来源 ${item.source}；${item.reason}`);
  for (const item of result.blockers) console.log(`必须修正：${item.location}；来源 ${item.source}；${item.reason}`);
  if (result.blockers.length) { report.status = 'blocked'; await save(path.join(runDir, 'report.json'), report); return 1; }
  if (flags.prepare) { console.log(`预检完成；尚未生成正式 JSON。清单摘要：${result.digest}`); return 2; }
  let decision = 'no-presentation-notices';
  if (result.notices.length) {
    if (flags['confirm-presentation']) {
      if (flags['confirm-presentation'] !== result.digest) throw new Error('确认摘要与当前清单不一致');
      decision = 'presentation-confirmed';
    } else if (stdin.isTTY && stdout.isTTY) {
      const terminal = createInterface({ input: stdin, output: stdout });
      try {
        const answer = await terminal.question('请选择：1 已核对表现并确认可接受；2 放弃本次转换。其他输入保持等待：');
        if (answer.trim() === '1') decision = 'presentation-confirmed';
        else if (answer.trim() === '2') {
          report.status = 'cancelled'; report.decisionAt = new Date().toISOString(); await save(path.join(runDir, 'report.json'), report);
          console.log('已放弃本次转换，未生成正式 JSON。'); return 2;
        } else { console.log('尚未确认，保留预检记录。'); return 2; }
      } finally { terminal.close(); }
    } else { console.log(`请先核对表现，再使用 --resume <任务目录> --confirm-presentation <摘要> 继续。摘要：${result.digest}`); return 2; }
  }
  const failures = validateStrategy(result.document);
  if (failures.length) throw new Error('最终校验未通过，未输出攻略');
  report.decision = decision; report.decisionAt = new Date().toISOString();
  report.actor = process.env.USERNAME ?? process.env.USER ?? 'local-operator';
  report.status = 'publishing';
  await save(path.join(runDir, 'report.json'), report);
  await save(path.join(runDir, 'strategy.pending.json'), result.document);
  // 硬链接发布已经完整写好的文件，目标存在时失败，不覆盖以往输出。
  try { await link(path.join(runDir, 'strategy.pending.json'), path.join(runDir, 'strategy.json')); }
  catch { throw new Error('无法安全发布文件，完整候选已保留；未覆盖已有正式产物'); }
  report.status = 'completed';
  await save(path.join(runDir, 'report.json'), report);
  console.log(`转换完成：${path.join(runDir, 'strategy.json')}`);
  return 0;
}

main().then(code => { process.exitCode = code; }).catch(error => {
  const message = error instanceof Error && !('code' in error) ? error.message : '本地文件操作失败，请检查路径和权限；未输出原始错误';
  console.error(`转换未完成：${message}`); process.exitCode = 1;
});

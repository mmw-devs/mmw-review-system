import { mkdir, writeFile, readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fingerprint } from './converter.ts';
import { AppError } from './review-auth.ts';

export type ContentIndex = {
  identity: string; final: boolean; source: any; title: string; revision: number;
  units: { id: string; title: string; hash: string; pending: string[] }[];
  report: string; counts: Record<string, number>; assets: Record<string, { sha256: string }>;
  anchors?: string[];
};
const categories = ['unsupported', 'warnings', 'blockers'];
export async function fileStamp(file: string) {
  try {
    const stat = await lstat(file, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  } catch { throw new AppError(409, '任务快照或报告不完整，请重新获取'); }
}
async function save(dir: string, value: any) {
  const hash = fingerprint(value), file = path.join(dir, hash + '.json');
  try { await writeFile(file, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); }
  catch (e: any) {
    if (e.code !== 'EEXIST') throw new AppError(500, '保存分页内容失败，请重新获取');
    await readContent(dir, hash);
  }
  return hash;
}
export async function readContent(dir: string, hash: string): Promise<any> {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new AppError(409, '分页内容索引无效，请重新获取');
  try {
    const file = path.join(dir, hash + '.json'); await fileStamp(file);
    const value = JSON.parse(await readFile(file, 'utf8'));
    if (fingerprint(value) !== hash) throw new Error();
    return value;
  } catch { throw new AppError(409, '分页内容已变化或不完整，请重新获取'); }
}
/** 生成不可覆盖的单元文件；未闭合的最后一个 P 不发布，正式结果使用全文校验后的转换结果。 */
export async function publishContent(dir: string, snapshot: any, result: any, identity: string, final: boolean, phases: boolean): Promise<ContentIndex> {
  const unitsDir = path.join(dir, 'units');
  await mkdir(unitsDir, { recursive: true, mode: 0o700 });
  const document = result.document;
  const list = phases ? [{ id: 'basic', title: '副本基本信息' }, ...document.phases.map((p: any) => ({ id: p.id, title: p.title }))] : [{ id: 'whole', title: '整篇攻略' }];
  if (!final && !snapshot.completeness.content) list.pop();
  const units: ContentIndex['units'] = [];
  for (const unit of list) {
    const { introduction, preparation, ...duty } = document.duty;
    const part = unit.id === 'whole' ? document : {
      ...document, duty: unit.id === 'basic' ? document.duty : duty,
      phases: document.phases.filter((p: any) => p.id === unit.id),
      phase_contents: document.phase_contents.filter((p: any) => p.phase_id === unit.id),
    };
    const pending: string[] = [];
    const walk = (v: any) => { if (!v || typeof v !== 'object') return; if (v.type === 'image_pending') pending.push(v.source); Object.values(v).forEach(walk); };
    walk(part);
    const issues = Object.fromEntries(categories.map(k => [k, result[k].filter((i: any) => !i.unitId || i.unitId === unit.id)]));
    units.push({ ...unit, hash: await save(unitsDir, { document: part, ...issues }), pending });
  }
  const report = Object.fromEntries(categories.map(k => [k, result[k]]));
  return {
    identity, final, source: { url: snapshot.url, documentId: snapshot.documentId }, title: snapshot.title, revision: snapshot.revision,
    units, report: await save(unitsDir, report), counts: Object.fromEntries(categories.map(k => [k, result[k].length])),
    assets: Object.fromEntries(Object.values(snapshot.images).filter((i: any) => i.src).map((i: any) => [i.src, { sha256: i.sha256 }])),
    ...(final ? { anchors: await Promise.all(['snapshot.json', 'report.json'].map(name => fileStamp(path.join(dir, name)))) } : {}),
  };
}

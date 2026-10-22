import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { linkSync } from 'node:fs';
import path from 'node:path';
import { Auth, AppError, hash, random } from './review-auth.ts';
import { FeishuApi, ApiError, READER_VERSION } from './feishu-api.ts';
import type { ApiSnapshot } from './feishu-api.ts';
import { convert, fingerprint } from './converter.ts';
import type { Options } from './converter.ts';
import { documentUrl } from './feishu.ts';

const CONVERTER_VERSION = 'review-1';
export class ReviewService {
  auth: Auth; apiFactory: (actor: string, check: () => void) => FeishuApi;
  jobs = new Map<string, Promise<void>>(); busy = new Set<string>();
  constructor(auth: Auth, apiFactory?: (actor: string, check: () => void) => FeishuApi) {
    this.auth = auth; this.apiFactory = apiFactory ?? ((actor, check) => new FeishuApi(() => auth.token(actor), auth.fetcher, check));
    for (const task of auth.store.all('task')) if (['queued', 'reading'].includes(task.reading) || task.conversion === 'running') {
      task.reading = task.reading === 'ready' ? 'ready' : 'failed'; task.conversion = task.conversion === 'running' ? 'failed' : task.conversion; task.error = '服务重启中断任务，请重新获取或检查产物后重试'; task.version++; auth.store.put('task', task.id, task);
    }
  }
  checkpoint(actor: string, memberVersion?: number) {
    const m = this.auth.reviewer(actor); if (memberVersion != null && m.version !== memberVersion) throw new AppError(403, '角色状态已变化，请重新操作');
    if (!this.auth.store.get('credential', actor)) throw new AppError(401, '请重新授权飞书读取权限');
  }
  task(actor: string, id: string) { this.auth.reviewer(actor); const t = this.auth.store.get('task', id); if (!t || t.owner !== actor) throw new AppError(404, '任务不存在或无权访问'); return t; }
  dir(id: string) { if (!/^[a-zA-Z0-9_-]{43}$/.test(id)) throw new AppError(400, '任务标识无效'); return path.join(this.auth.config.dataDir, 'runs', id); }
  list(actor: string) { this.auth.reviewer(actor); return this.auth.store.all('task').filter(t => t.owner === actor).map(t => ({ id: t.id, reading: t.reading, review: t.review, conversion: t.conversion, created: t.created, generation: t.generation })); }
  create(actor: string, input: any, parent?: any) {
    const m = this.auth.reviewer(actor); this.checkpoint(actor);
    if (this.jobs.size >= 4) throw new AppError(429, '当前任务较多，请稍后重试');
    const url = documentUrl(input.url);
    if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(input.dutyId ?? '') || typeof input.dutyName !== 'string' || !input.dutyName.trim() || input.dutyName.length > 200 || !['legacy', 'standard'].includes(input.profile ?? 'legacy')) throw new AppError(400, '副本 ID、名称或标题模式无效');
    if (input.dutyType != null && (typeof input.dutyType !== 'string' || input.dutyType.length > 100)) throw new AppError(400, '副本类型无效');
    const options: Options = { dutyId: input.dutyId, dutyName: input.dutyName.trim(), profile: input.profile ?? 'legacy', ...(input.dutyType ? { dutyType: input.dutyType } : {}) };
    const id = random(), task = { id, owner: actor, url, options, version: 1, generation: parent ? parent.generation + 1 : 1, parent: parent?.id, created: new Date().toISOString(), reading: 'queued', review: 'pending', conversion: 'not_started' };
    this.auth.store.put('task', id, task); this.auth.store.audit(actor, 'task-create', id);
    const job = this.read(actor, id, m.version).finally(() => this.jobs.delete(id)); this.jobs.set(id, job);
    return task;
  }
  async read(actor: string, id: string, memberVersion: number) {
    const store = this.auth.store; let task = store.get('task', id);
    try {
      const check = () => this.checkpoint(actor, memberVersion); check(); task.reading = 'reading'; store.put('task', id, task);
      const dir = this.dir(id); await mkdir(dir, { recursive: true, mode: 0o700 });
      const snapshot = await this.apiFactory(actor, check).read(task.url, dir); check();
      const result = convert(snapshot, task.options); const snapshotHash = fingerprint(snapshot);
      const consent = fingerprint({ snapshotHash, options: task.options, reader: READER_VERSION, converter: CONVERTER_VERSION, result });
      await writeFile(path.join(dir, 'candidate.json'), JSON.stringify(result.document, null, 2), { flag: 'wx', mode: 0o600 });
      await writeFile(path.join(dir, 'report.json'), JSON.stringify({ ...result, digest: consent, snapshotHash, converter: CONVERTER_VERSION }, null, 2), { flag: 'wx', mode: 0o600 });
      check(); task = { ...task, reading: 'ready', snapshotHash, digest: consent, conversion: result.unsupported.length ? 'needs_confirmation' : 'not_started', version: task.version + 1 };
      store.put('task', id, task);
    } catch (e) {
      if (e instanceof ApiError && e.kind === 'authorization') this.auth.store.remove('credential', actor);
      task.reading = (e instanceof AppError && e.status === 401) || (e instanceof ApiError && ['authorization', 'scope'].includes(e.kind)) ? 'waiting_authorization' : 'failed';
      task.error = e instanceof AppError || e instanceof ApiError ? e.message : '读取或本地保存失败，请重新获取；未输出正式文件'; task.version++;
      store.put('task', id, task); store.audit(actor, 'task-read-failed', id, { reason: task.reading });
    }
  }
  async files(task: any, verifyImages = true) {
    let snapshot: ApiSnapshot, report: any;
    try { snapshot = JSON.parse(await readFile(path.join(this.dir(task.id), 'snapshot.json'), 'utf8')); report = JSON.parse(await readFile(path.join(this.dir(task.id), 'report.json'), 'utf8')); }
    catch { throw new AppError(409, '任务快照或报告不完整，请重新获取'); }
    if (snapshot.snapshot_version !== 2 || fingerprint(snapshot) !== task.snapshotHash) throw new AppError(409, '快照已变化，请重新获取并审核');
    const result = convert(snapshot, task.options);
    const digest = fingerprint({ snapshotHash: task.snapshotHash, options: task.options, reader: READER_VERSION, converter: CONVERTER_VERSION, result });
    if (digest !== task.digest || report.digest !== digest || report.converter !== CONVERTER_VERSION) throw new AppError(409, '规则、配置或清单已变化，请重新获取并审核');
    for (const value of Object.values(snapshot.images)) if (verifyImages && value.src) {
      const bytes = await this.assetFile(task, value.src); if (hash(bytes) !== value.sha256) throw new AppError(409, '本地图片已变化，请重新获取');
    }
    return { snapshot, result, report };
  }
  async assetFile(task: any, relative: string) {
    if (!/^assets\/[a-f0-9]{24}\.(png|jpg|gif|webp)$/.test(relative)) throw new AppError(400, '图片路径无效');
    const file = path.join(this.dir(task.id), relative);
    try { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.size > 50 * 1024 * 1024) throw new Error(); return await readFile(file); }
    catch { throw new AppError(409, '图片文件缺失或无效，请重新获取'); }
  }
  async checked(actor: string, id: string, sameVersion = false, asset?: string) {
    const task = this.task(actor, id); if (task.reading !== 'ready') throw new AppError(409, '读取尚未就绪');
    const memberVersion = this.auth.reviewer(actor).version; const files = await this.files(task, !asset);
    const check = () => { this.checkpoint(actor, memberVersion); const current = this.task(actor, id); if (current.version !== task.version) throw new AppError(409, '任务状态已变化，请刷新'); };
    const references = new Set<string>();
    const visit = (v: any) => { if (!v || typeof v !== 'object') return; if (v.type === 'image' && v.src) references.add(v.src); Object.values(v).forEach(visit); }; visit(files.result.document);
    if (asset && !references.has('assets/' + asset)) throw new AppError(404, '图片不在当前预览中');
    const imageIds = Object.entries(files.snapshot.images).filter(([, i]) => i.src && (asset ? i.src === 'assets/' + asset : references.has(i.src))).map(([id]) => id);
    await this.apiFactory(actor, check).check(files.snapshot, imageIds, sameVersion); check();
    return { task, ...files, check };
  }
  async detail(actor: string, id: string) {
    const task = this.task(actor, id);
    if (task.reading !== 'ready') return { id, version: task.version, reading: task.reading, review: task.review, conversion: task.conversion, error: task.error };
    const value = await this.checked(actor, id);
    return { ...task, snapshotRevision: value.snapshot.revision, title: value.snapshot.title, result: value.result };
  }
  async locked<T>(id: string, action: () => Promise<T>): Promise<T> { if (this.busy.has(id)) throw new AppError(409, '此任务正在处理，请稍后刷新'); this.busy.add(id); try { return await action(); } finally { this.busy.delete(id); } }
  async review(actor: string, id: string, input: any) {
    return this.locked(id, async () => {
      if (!['approved', 'rejected'].includes(input.decision) || typeof input.comment !== 'string' || input.comment.length > 2000) throw new AppError(400, '审核参数无效');
      const { task, check } = await this.checked(actor, id, input.decision === 'approved');
      if (input.snapshotHash !== task.snapshotHash) throw new AppError(409, '审核内容已变化');
      if (task.review === input.decision && task.comment === input.comment) return task;
      if (task.version !== input.version || task.review !== 'pending') throw new AppError(409, '审核状态已变化，请刷新；修改原文请重新获取');
      check(); task.review = input.decision; task.comment = input.comment; task.reviewedAt = new Date().toISOString(); task.version++;
      this.auth.store.transaction(() => { this.auth.store.put('task', id, task); this.auth.store.audit(actor, 'review-' + input.decision, id, { snapshotHash: task.snapshotHash }); }); return task;
    });
  }
  async conversion(actor: string, id: string, input: any) {
    return this.locked(id, async () => {
      const { task, result, check } = await this.checked(actor, id);
      if (task.review !== 'approved') throw new AppError(409, '需要先人工审核通过');
      if (input.digest !== task.digest) throw new AppError(409, '排除清单或转换规则已变化，请刷新');
      if (task.conversion === 'completed' && input.action === 'export') return task;
      if (task.conversion === 'cancelled' && input.action === 'cancel') return task;
      if (task.version !== input.version || ['completed', 'cancelled'].includes(task.conversion)) throw new AppError(409, '此版本已完成或取消；请重新获取后再转换');
      if (!['cancel', 'export'].includes(input.action)) throw new AppError(400, '转换操作无效');
      if (input.action === 'export' && (result.blockers.length || (result.unsupported.length && input.discard !== true))) throw new AppError(409, '仍有阻断问题或未明确确认排除清单');
      check();
      if (input.action === 'export') {
        const bytes = Buffer.from(JSON.stringify(result.document, null, 2) + '\n');
        const pending = path.join(this.dir(id), `pending-${random()}.json`); await writeFile(pending, bytes, { flag: 'wx', mode: 0o600 }); check();
        // 最后的角色检查、不可覆盖发布及状态提交无异步间隙，单进程下不插入其他角色变更。
        this.auth.store.transaction(() => {
          try { linkSync(pending, path.join(this.dir(id), 'strategy.json')); } catch (e: any) { if (e.code === 'EEXIST') throw new AppError(409, '已有产物但状态未完整提交；请重新获取为新版本，旧文件不会覆盖'); throw e; }
          task.conversion = 'completed'; task.artifactHash = hash(bytes); task.discard = result.unsupported.length > 0; task.version++;
          this.auth.store.put('task', id, task); this.auth.store.audit(actor, 'export', id, { digest: task.digest, artifactHash: task.artifactHash, discarded: task.discard });
        });
      } else { task.conversion = 'cancelled'; task.version++; this.auth.store.put('task', id, task); this.auth.store.audit(actor, 'conversion-cancel', id); }
      return task;
    });
  }
  async image(actor: string, id: string, name: string) {
    const { task, snapshot, check } = await this.checked(actor, id, false, name);
    const src = `assets/${name}`; if (!Object.values(snapshot.images).some(i => i.src === src)) throw new AppError(404, '图片不存在');
    const bytes = await this.assetFile(task, src); if (hash(bytes) !== Object.values(snapshot.images).find(i => i.src === src)?.sha256) throw new AppError(409, '图片已变化'); check(); return bytes;
  }
  async export(actor: string, id: string) {
    const { task, result, snapshot, check } = await this.checked(actor, id);
    if (task.conversion !== 'completed' || task.review !== 'approved') throw new AppError(409, '暂无正式产物');
    const json = await readFile(path.join(this.dir(id), 'strategy.json')); if (hash(json) !== task.artifactHash) throw new AppError(409, '正式产物已变化');
    const names = new Set<string>(); const walk = (v: any) => { if (!v || typeof v !== 'object') return; if (v.type === 'image' && typeof v.src === 'string') names.add(v.src); Object.values(v).forEach(walk); }; walk(result.document);
    const entries = [{ name: 'strategy.json', bytes: json }]; let total = json.length;
    for (const name of names) { const bytes = await this.assetFile(task, name); if (hash(bytes) !== Object.values(snapshot.images).find(i => i.src === name)?.sha256) throw new AppError(409, '图片已变化'); total += bytes.length; if (total > 200 * 1024 * 1024) throw new AppError(413, '产物超过单次下载上限，请联系管理员'); entries.push({ name, bytes }); }
    check(); return tar(entries);
  }
}
// 无依赖的标准 ustar 包，只包含内部生成的安全相对路径。
export function tar(entries: { name: string; bytes: Buffer }[]) {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const h = Buffer.alloc(512); h.write(entry.name, 0, 100); h.write('0000600\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116); h.write(entry.bytes.length.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136); h.fill(32, 148, 156); h.write('0', 156); h.write('ustar\0', 257); h.write('00', 263);
    const sum = [...h].reduce((a, b) => a + b, 0); h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148); parts.push(h, entry.bytes, Buffer.alloc((512 - entry.bytes.length % 512) % 512));
  }
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
}

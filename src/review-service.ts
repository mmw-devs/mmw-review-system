import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { linkSync } from 'node:fs';
import path from 'node:path';
import { Auth, AppError, hash, random } from './review-auth.ts';
import { FeishuApi, ApiError, READER_VERSION } from './feishu-api.ts';
import type { ApiSnapshot } from './feishu-api.ts';
import { convert, fingerprint } from './converter.ts';
import type { Options } from './converter.ts';
import { documentUrl } from './feishu.ts';
import { generateAstro, ASTRO_EXPORT_VERSION, isReviewAssetPath } from './astro-export.ts';

const CONVERTER_VERSION = 'review-3';
const converterVersion = (task: any) => task.storageVersion >= 3 ? CONVERTER_VERSION : task.reviewMode === 'phases' ? 'review-2' : 'review-1';
// 审核绑定固定内容，导出诊断与源码字节单独保存、校验。
function reviewDigest(task: any, snapshotHash: string, result: any, reader: string, converter: string) {
  return fingerprint({ snapshotHash, options: task.options, reader, converter, document: result.document, ...(task.storageVersion === 2 ? { unsupported: result.unsupported } : {}) });
}
// 副本信息和各 P 独立审核；整篇通过必须由服务端按完整单元清单汇总。
function reviewUnits(document: any) {
  return [{ id: 'basic', title: '副本基本信息' }, ...document.phases.map((p: any) => ({ id: p.id, title: p.title }))];
}
// 导出资格与整篇审核状态分开：新任务至少一个 P 通过即可，副本基本信息不计入。
function canExport(task: any, document: any) {
  return task.reviewMode === 'phases'
    ? document.phases.some((p: any) => task.unitReviews?.[p.id]?.review === 'approved' && task.unitReviews[p.id].digest === task.digest)
    : task.review === 'approved';
}
export type ActionState = { allowed: boolean; reason?: string };
type TaskActions = { approve: Record<string, ActionState>; review: Record<string, ActionState>; export: ActionState; cancel: ActionState; download: ActionState };
// 任务和转换结果是动作规则的唯一输入；返回值仅供响应与执行校验，不另行持久化。
function taskActions(task: any, result?: any): TaskActions {
  const denied = (reason: string): ActionState => ({ allowed: false, reason });
  if (task.reading !== 'ready' || !result) {
    const unavailable = denied('读取尚未就绪');
    return { approve: {}, review: {}, export: unavailable, cancel: unavailable, download: unavailable };
  }
  const units = task.reviewMode === 'phases' ? reviewUnits(result.document) : [{ id: 'whole' }];
  const review = Object.fromEntries(units.map((unit: any) => {
    const decided = task.reviewMode === 'phases' ? !!task.unitReviews?.[unit.id] : task.review !== 'pending';
    return [unit.id, task.conversion === 'cancelled' ? denied('此版本已取消转换；请重新获取后再审核')
      : decided ? denied('审核状态已变化，请刷新；修改原文请重新获取') : { allowed: true }];
  }));
  const mustFix = result.blockers.length > 0;
  const approve = Object.fromEntries(Object.entries(review).map(([id, action]) => [id, action.allowed && mustFix && task.storageVersion >= 3 ? denied('存在必须修正项，请回飞书修改后重新获取') : action]));
  const approved = canExport(task, result.document);
  const conversion = !approved ? denied('需要先人工审核通过至少一个 P；旧任务仍需整篇通过')
    : ['completed', 'cancelled'].includes(task.conversion) ? denied('此版本已完成或取消；请重新获取后再转换') : { allowed: true };
  return {
    review, approve,
    export: mustFix ? denied('存在必须修正项，请回飞书修改后重新获取')
      : conversion.allowed && (!task.exportPlanHash || task.exportFormat !== ASTRO_EXPORT_VERSION) ? denied('此任务使用旧版导出规则；请重新获取后生成攻略站文件') : conversion,
    cancel: mustFix && !['completed', 'cancelled'].includes(task.conversion) ? { allowed: true } : conversion,
    download: task.conversion === 'completed' && approved ? { allowed: true } : denied('暂无正式产物'),
  };
}
function taskResponse(task: any, result?: any) { return { ...task, actions: taskActions(task, result) }; }
function requireAction(action: ActionState) { if (!action.allowed) throw new AppError(409, action.reason ?? '当前任务不允许此操作'); }
export class ReviewService {
  auth: Auth; apiFactory: (actor: string, check: () => void) => FeishuApi;
  generate = generateAstro;
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
    const id = random(), task = { id, owner: actor, url, options, storageVersion: 3, exportFormat: ASTRO_EXPORT_VERSION, version: 1, generation: parent ? parent.generation + 1 : 1, parent: parent?.id, created: new Date().toISOString(), reading: 'queued', reviewMode: 'phases', unitReviews: {}, review: 'pending', conversion: 'not_started' };
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
      const result = convert(snapshot, task.options, task.reviewMode === 'phases'), snapshotHash = fingerprint(snapshot);
      const consent = reviewDigest(task, snapshotHash, result, READER_VERSION, converterVersion(task));
      let exportPlanHash: string | undefined;
      if (!result.blockers.length) {
        let output;
        try {
          output = this.generate(result.document);
          for (const asset of output.assets) if (!isReviewAssetPath(asset.source) || !Object.values(snapshot.images).some(image => image.src === asset.source && image.sha256)) throw new Error('导出图片不属于已验证的审核快照，请重新获取');
        } catch (e) {
          result.blockers.push({ code: 'ASTRO_EXPORT', source: snapshot.documentId, location: '攻略站导出', reason: e instanceof Error ? e.message : '攻略站文件无法生成，请核对内容格式' });
        }
        if (!result.blockers.length && output) {
          const plan = Buffer.from(JSON.stringify({ format: task.exportFormat, reviewDigest: consent, ...output }));
          exportPlanHash = hash(plan);
          await writeFile(path.join(dir, 'export-plan.json'), plan, { flag: 'wx', mode: 0o600 });
        }
      }
      await writeFile(path.join(dir, 'candidate.json'), JSON.stringify(result.document, null, 2), { flag: 'wx', mode: 0o600 });
      const report = Buffer.from(JSON.stringify({ ...result, contentDigest: result.digest, digest: consent, snapshotHash, reader: READER_VERSION, converter: converterVersion(task) }, null, 2));
      await writeFile(path.join(dir, 'report.json'), report, { flag: 'wx', mode: 0o600 });
      check(); task = { ...task, reading: 'ready', snapshotHash, digest: consent, reportHash: hash(report), exportPlanHash, conversion: 'not_started', version: task.version + 1 };
      store.put('task', id, task);
    } catch (e) {
      if (e instanceof ApiError && e.kind === 'authorization') this.auth.store.remove('credential', actor);
      task.reading = (e instanceof AppError && e.status === 401) || (e instanceof ApiError && ['authorization', 'scope'].includes(e.kind)) ? 'waiting_authorization' : 'failed';
      task.error = e instanceof AppError || e instanceof ApiError ? e.message : '读取或本地保存失败，请重新获取；未输出正式文件'; task.version++;
      store.put('task', id, task); store.audit(actor, 'task-read-failed', id, { reason: task.reading });
    }
  }
  async snapshotFile(task: any): Promise<ApiSnapshot> {
    let snapshot: ApiSnapshot;
    try { snapshot = JSON.parse(await readFile(path.join(this.dir(task.id), 'snapshot.json'), 'utf8')); }
    catch { throw new AppError(409, '任务快照不完整，请重新获取'); }
    if (snapshot?.snapshot_version !== 2 || fingerprint(snapshot) !== task.snapshotHash) throw new AppError(409, '快照已变化，请重新获取并审核');
    return snapshot;
  }
  async files(task: any, verifyImages = true) {
    const snapshot = await this.snapshotFile(task);
    let report: any, reportBytes: Buffer;
    try { reportBytes = await readFile(path.join(this.dir(task.id), 'report.json')); report = JSON.parse(reportBytes.toString()); }
    catch { throw new AppError(409, '任务报告不完整，请重新获取'); }
    if (task.storageVersion >= 2 && hash(reportBytes) !== task.reportHash) throw new AppError(409, '任务报告已变化，请重新获取');
    if (!report?.document || !Array.isArray(report.document.phases) || !Array.isArray(report.blockers)) throw new AppError(409, '任务报告不完整，请重新获取');
    let result: any, digest: string;
    if (task.storageVersion >= 3) {
      if (!Array.isArray(report.notices)) throw new AppError(409, '任务报告不完整，请重新获取');
      result = { document: report.document, notices: report.notices, blockers: report.blockers, digest: report.contentDigest };
      digest = reviewDigest(task, task.snapshotHash, result, report.reader, report.converter);
    } else {
      // 旧摘要只按保存的旧结构验证；向页面统一投影为两类问题，不修改历史文件。
      if (!Array.isArray(report.unsupported) || !Array.isArray(report.warnings)) throw new AppError(409, '旧任务报告不完整，请重新获取');
      const legacy = { document: report.document, unsupported: report.unsupported, warnings: report.warnings, blockers: report.blockers, digest: report.contentDigest };
      if (task.storageVersion === 2) digest = reviewDigest(task, task.snapshotHash, legacy, report.reader, report.converter);
      else {
        legacy.digest = fingerprint({ snapshot, options: task.options, unsupported: legacy.unsupported, document: legacy.document, warnings: legacy.warnings, blockers: legacy.blockers.filter((issue: any) => issue.code !== 'ASTRO_EXPORT') });
        digest = fingerprint({ snapshotHash: task.snapshotHash, options: task.options, reader: snapshot.reader ?? 'openapi-1', converter: report.converter, ...(task.exportFormat ? { exporter: task.exportFormat } : {}), result: legacy });
      }
      result = { document: legacy.document, notices: legacy.warnings, blockers: [...legacy.blockers, ...legacy.unsupported, ...(report.exportBlockers ?? [])], digest: legacy.digest };
    }
    if (digest !== task.digest || report.digest !== digest) throw new AppError(409, '任务内容或清单已变化，请重新获取并审核');
    for (const value of Object.values(snapshot.images)) if (verifyImages && value.src) {
      const bytes = await this.assetFile(task, value.src); if (hash(bytes) !== value.sha256) throw new AppError(409, '本地图片已变化，请重新获取');
    }
    return { snapshot, result, report };
  }
  async exportPlan(task: any) {
    try {
      const bytes = await readFile(path.join(this.dir(task.id), 'export-plan.json'));
      if (hash(bytes) !== task.exportPlanHash) throw new Error();
      const plan = JSON.parse(bytes.toString());
      if (plan.format !== task.exportFormat || plan.reviewDigest !== task.digest) throw new Error();
      return plan as { files: {name:string;content:string}[]; assets: {source:string;target:string}[] };
    } catch { throw new AppError(409, '导出计划缺失或已变化，请重新获取；未生成新产物'); }
  }
  async assetFile(task: any, relative: string) {
    if (!isReviewAssetPath(relative)) throw new AppError(400, '图片路径无效');
    const file = path.join(this.dir(task.id), relative);
    try { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink()) throw new Error(); return await readFile(file); }
    catch { throw new AppError(409, '图片文件缺失或无效，请重新获取'); }
  }
  async checked(actor: string, id: string) {
    const task = this.task(actor, id); if (task.reading !== 'ready') throw new AppError(409, '读取尚未就绪');
    const memberVersion = this.auth.reviewer(actor).version; const files = await this.files(task, false);
    const check = () => { this.checkpoint(actor, memberVersion); const current = this.task(actor, id); if (current.version !== task.version) throw new AppError(409, '任务状态已变化，请刷新'); };
    await this.apiFactory(actor, check).check(files.snapshot); check();
    return { task, ...files, check };
  }
  async detail(actor: string, id: string) {
    const task = this.task(actor, id);
    if (task.reading !== 'ready') return { id, version: task.version, reading: task.reading, review: task.review, conversion: task.conversion, error: task.error, actions: taskActions(task) };
    const value = await this.checked(actor, id);
    return { ...taskResponse(task, value.result), snapshotRevision: value.snapshot.revision, title: value.snapshot.title, result: value.result, ...(task.reviewMode === 'phases' ? { units: reviewUnits(value.result.document).map((u: any) => ({ ...u, ...(task.unitReviews?.[u.id] ?? { review: 'pending' }) })) } : {}) };
  }
  async locked<T>(id: string, action: () => Promise<T>): Promise<T> { if (this.busy.has(id)) throw new AppError(409, '此任务正在处理，请稍后刷新'); this.busy.add(id); try { return await action(); } finally { this.busy.delete(id); } }
  async review(actor: string, id: string, input: any) {
    return this.locked(id, async () => {
      if (!['approved', 'rejected'].includes(input.decision) || typeof input.comment !== 'string' || input.comment.length > 2000) throw new AppError(400, '审核参数无效');
      const { task, result, check } = await this.checked(actor, id);
      if (input.snapshotHash !== task.snapshotHash) throw new AppError(409, '审核内容已变化');
      if (task.reviewMode === 'phases') {
        const units = reviewUnits(result.document);
        if (!units.some((u: any) => u.id === input.unitId)) throw new AppError(400, '审核页面不存在，请选择副本基本信息或一个 P');
        if (input.digest !== task.digest) throw new AppError(409, '切分内容或转换规则已变化，请刷新');
        const previous = task.unitReviews?.[input.unitId];
        if (previous?.review === input.decision && previous.comment === input.comment) return taskResponse(task, result);
        if (task.version !== input.version) throw new AppError(409, '审核状态已变化，请刷新；修改原文请重新获取');
        requireAction((input.decision === 'approved' ? taskActions(task, result).approve : taskActions(task, result).review)[input.unitId]);
        check();
        task.unitReviews = { ...task.unitReviews, [input.unitId]: { review: input.decision, comment: input.comment, reviewer: actor, reviewedAt: new Date().toISOString(), digest: task.digest, snapshotHash: task.snapshotHash } };
        task.review = units.some((u: any) => task.unitReviews[u.id]?.review === 'rejected') ? 'rejected' : units.every((u: any) => task.unitReviews[u.id]?.review === 'approved') ? 'approved' : 'pending';
        task.version++;
        this.auth.store.transaction(() => { this.auth.store.put('task', id, task); this.auth.store.audit(actor, 'review-' + input.decision, id, { unitId: input.unitId, snapshotHash: task.snapshotHash, digest: task.digest }); });
        return taskResponse(task, result);
      }
      if (task.review === input.decision && task.comment === input.comment) return taskResponse(task, result);
      if (task.version !== input.version) throw new AppError(409, '审核状态已变化，请刷新；修改原文请重新获取');
      requireAction((input.decision === 'approved' ? taskActions(task, result).approve : taskActions(task, result).review).whole);
      check(); task.review = input.decision; task.comment = input.comment; task.reviewedAt = new Date().toISOString(); task.version++;
      this.auth.store.transaction(() => { this.auth.store.put('task', id, task); this.auth.store.audit(actor, 'review-' + input.decision, id, { snapshotHash: task.snapshotHash }); }); return taskResponse(task, result);
    });
  }
  async conversion(actor: string, id: string, input: any) {
    return this.locked(id, async () => {
      const { task, result, snapshot, check } = await this.checked(actor, id);
      if (input.action === 'export' && result.blockers.length) throw new AppError(409, '存在必须修正项，请回飞书修改后重新获取');
      if (input.action === 'export' && !canExport(task, result.document)) throw new AppError(409, '需要先人工审核通过至少一个 P；旧任务仍需整篇通过');
      if (input.digest !== task.digest) throw new AppError(409, '内容或转换规则已变化，请刷新');
      if (task.conversion === 'completed' && input.action === 'export') return taskResponse(task, result);
      if (task.conversion === 'cancelled' && input.action === 'cancel') return taskResponse(task, result);
      if (task.version !== input.version) throw new AppError(409, '此版本已完成或取消；请重新获取后再转换');
      if (!['cancel', 'export'].includes(input.action)) throw new AppError(400, '转换操作无效');
      const actions = taskActions(task, result);
      requireAction(input.action === 'export' ? actions.export : actions.cancel);
      if (input.action === 'export' && result.notices.length && input.confirmPresentation !== true) throw new AppError(409, '请先核对全部表现待确认项，并确认预览表现可接受');
      check();
      if (input.action === 'export') {
        const output = await this.exportPlan(task);
        const entries = output.files.map(file => ({ name: file.name, bytes: Buffer.from(file.content, 'utf8') }));
        for (const asset of output.assets) {
          const bytes = await this.assetFile(task, asset.source);
          if (hash(bytes) !== Object.values(snapshot.images).find(image => image.src === asset.source)?.sha256) throw new AppError(409, '图片已变化，请重新获取');
          entries.push({ name: asset.target, bytes });
        }
        const bytes = tar(entries);
        const pending = path.join(this.dir(id), `pending-${random()}.tar`); await writeFile(pending, bytes, { flag: 'wx', mode: 0o600 }); check();
        // 最后的角色检查、不可覆盖发布及状态提交无异步间隙，单进程下不插入其他角色变更。
        this.auth.store.transaction(() => {
          try { linkSync(pending, path.join(this.dir(id), 'strategy-site.tar')); } catch (e: any) { if (e.code === 'EEXIST') throw new AppError(409, '已有产物但状态未完整提交；请重新获取为新版本，旧文件不会覆盖'); throw e; }
          task.artifactFile = 'strategy-site.tar'; task.conversion = 'completed'; task.artifactHash = hash(bytes); task.presentationConfirmed = result.notices.length > 0; task.version++;
          this.auth.store.put('task', id, task); this.auth.store.audit(actor, 'export', id, { digest: task.digest, exporter: task.exportFormat, exportPlanHash: task.exportPlanHash, artifactHash: task.artifactHash, presentationConfirmed: task.presentationConfirmed, reportHash: task.reportHash });
        });
      } else { task.conversion = 'cancelled'; task.version++; this.auth.store.put('task', id, task); this.auth.store.audit(actor, 'conversion-cancel', id); }
      return taskResponse(task, result);
    });
  }
  async image(actor: string, id: string, name: string) {
    const task = this.task(actor, id);
    if (task.reading !== 'ready') throw new AppError(409, '读取尚未就绪');
    let snapshot: any;
    try { snapshot = JSON.parse(await readFile(path.join(this.dir(id), 'snapshot.json'), 'utf8')); }
    catch { throw new AppError(409, '任务快照不完整，请重新获取'); }
    if (snapshot?.snapshot_version !== 2 || fingerprint(snapshot) !== task.snapshotHash) throw new AppError(409, '快照已变化，请重新获取');
    const src = `assets/${name}`;
    const image = Object.values(snapshot.images).find((i: any) => i.src === src);
    if (!image) throw new AppError(404, '图片不存在');
    const bytes = await this.assetFile(task, src);
    if (hash(bytes) !== image.sha256) throw new AppError(409, '图片已变化，请重新获取');
    return bytes;
  }
  async export(actor: string, id: string) {
    // 已完成产物的下载保留权限与哈希校验，独立于当前转换器和报告。
    const task = this.task(actor, id), memberVersion = this.auth.reviewer(actor).version;
    const approved = task.reviewMode === 'phases' ? Object.entries(task.unitReviews ?? {}).some(([unit, value]: [string, any]) => unit !== 'basic' && value.review === 'approved' && value.digest === task.digest) : task.review === 'approved';
    if (task.conversion !== 'completed' || !approved) throw new AppError(409, '暂无正式产物');
    const snapshot = await this.snapshotFile(task);
    const check = () => { this.checkpoint(actor, memberVersion); if (this.task(actor, id).version !== task.version) throw new AppError(409, '任务状态已变化，请刷新'); };
    await this.apiFactory(actor, check).check(snapshot); check();
    if (task.artifactFile === 'strategy-site.tar' || (!task.artifactFile && task.exportFormat)) {
      let bytes: Buffer;
      try { bytes = await readFile(path.join(this.dir(id), 'strategy-site.tar')); }
      catch { throw new AppError(409, '正式产物缺失或无法读取，请重新获取'); }
      if (hash(bytes) !== task.artifactHash) throw new AppError(409, '正式产物已变化');
      check(); return bytes;
    }
    if (task.artifactFile) throw new AppError(409, '无法识别正式产物文件');
    let json: Buffer;
    try { json = await readFile(path.join(this.dir(id), 'strategy.json')); } catch { throw new AppError(409, '正式产物缺失或无法读取'); }
    if (hash(json) !== task.artifactHash) throw new AppError(409, '正式产物已变化');
    const names = new Set<string>(); const walk = (v: any) => { if (!v || typeof v !== 'object') return; if (v.type === 'image' && typeof v.src === 'string') names.add(v.src); Object.values(v).forEach(walk); }; walk(JSON.parse(json.toString()));
    const entries = [{ name: 'strategy.json', bytes: json }];
    for (const name of names) { const bytes = await this.assetFile(task, name); if (hash(bytes) !== Object.values(snapshot.images).find(i => i.src === name)?.sha256) throw new AppError(409, '图片已变化'); entries.push({ name, bytes }); }
    check(); return tar(entries);
  }
}
// 无依赖的标准 ustar 包，只包含内部生成的安全相对路径。
export function tar(entries: { name: string; bytes: Buffer }[]) {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    if (!/^[A-Za-z0-9_-]+(?:[./][A-Za-z0-9_-]+)*$/.test(entry.name) || entry.bytes.length > 0o77777777777) throw new AppError(409, '导出文件路径或大小超出归档范围');
    let name = entry.name, prefix = '';
    if (Buffer.byteLength(name) > 100) {
      const split = [...name.matchAll(/\//g)].map(match => match.index).find(index => Buffer.byteLength(name.slice(0, index)) <= 155 && Buffer.byteLength(name.slice(index + 1)) <= 100);
      if (split == null) throw new AppError(409, '导出文件路径过长，请缩短副本标识');
      prefix = name.slice(0, split); name = name.slice(split + 1);
    }
    const h = Buffer.alloc(512); h.write(name, 0, 100); h.write(prefix, 345, 155); h.write('0000600\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116); h.write(entry.bytes.length.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136); h.fill(32, 148, 156); h.write('0', 156); h.write('ustar\0', 257); h.write('00', 263);
    const sum = [...h].reduce((a, b) => a + b, 0); h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148); parts.push(h, entry.bytes, Buffer.alloc((512 - entry.bytes.length % 512) % 512));
  }
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
}

import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { ApiError, readLimited } from './feishu-api.ts';

export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const random = () => randomBytes(32).toString('base64url');
export class AppError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export function equal(a: string, b: string) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
export type Config = { appId: string; appSecret: string; tenant: string; admin: string; origin: string; scopes: string; key: Buffer; dataDir: string; port: number };
export function configFromEnv(env = process.env): Config {
  const required = ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_TENANT_KEY', 'REVIEW_ADMIN_OPEN_ID', 'REVIEW_ORIGIN', 'REVIEW_ENCRYPTION_KEY'];
  if (required.some(k => !env[k]?.trim())) throw new AppError(500, '缺少启动配置，请按 docs/review-server.md 配置本地环境文件');
  const u = new URL(env.REVIEW_ORIGIN!);
  if (u.origin !== env.REVIEW_ORIGIN || u.username || u.password || (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname)))) throw new AppError(500, '应用地址必须为 HTTPS；本地开发仅允许回环 HTTP');
  const key = Buffer.from(env.REVIEW_ENCRYPTION_KEY!, 'base64');
  if (key.length !== 32) throw new AppError(500, '凭证加密密钥必须为 32 字节的 Base64 值');
  const port = Number(env.REVIEW_PORT ?? 4325); if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AppError(500, '服务端口无效');
  return { appId: env.FEISHU_APP_ID!, appSecret: env.FEISHU_APP_SECRET!, tenant: env.FEISHU_TENANT_KEY!, admin: env.REVIEW_ADMIN_OPEN_ID!, origin: u.origin, key,
    scopes: env.FEISHU_USER_SCOPES ?? 'docx:document:readonly wiki:wiki:readonly drive:drive:readonly offline_access', dataDir: path.resolve(env.REVIEW_DATA_DIR ?? 'data/review'), port };
}

/** 小规模单进程服务使用同步事务，角色和任务版本在提交瞬间核对。 */
export class Store {
  db: DatabaseSync;
  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file); chmodSync(file, 0o600);
    this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id));');
  }
  get(kind: string, id: string): any { const row = this.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind, id); return row ? JSON.parse(row.data as string) : undefined; }
  all(kind: string): any[] { return this.db.prepare('SELECT data FROM records WHERE kind=?').all(kind).map(r => JSON.parse(r.data as string)); }
  put(kind: string, id: string, value: any) { this.db.prepare('INSERT INTO records VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').run(kind, id, JSON.stringify(value)); }
  remove(kind: string, id: string) { this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, id); }
  transaction<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  audit(actor: string, action: string, target: string, details: any = {}) { const id = random(); this.put('audit', id, { id, actor, action, target, details, at: new Date().toISOString() }); }
  close() { this.db.close(); }
}
export function encrypt(key: Buffer, value: any, context: string) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}
export function decrypt(key: Buffer, value: string, context: string) {
  try { const b = Buffer.from(value, 'base64'), cipher = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); cipher.setAAD(Buffer.from(context)); cipher.setAuthTag(b.subarray(12, 28)); return JSON.parse(Buffer.concat([cipher.update(b.subarray(28)), cipher.final()]).toString('utf8')); }
  catch { throw new AppError(401, '授权凭证无法读取，请重新授权'); }
}
export class Auth {
  store: Store; config: Config; fetcher: typeof fetch; refreshing = new Map<string, Promise<string>>();
  constructor(store: Store, config: Config, fetcher = fetch) { this.store = store; this.config = config; this.fetcher = fetcher; }
  member(id: string) { const m = this.store.get('member', id); if (!m || !m.enabled || m.tenant !== this.config.tenant) throw new AppError(403, '账号无权使用此功能或已停用'); return m; }
  reviewer(id: string) { const m = this.member(id); if (!m.reviewer) throw new AppError(403, '需要审核人员权限'); return m; }
  admin(id: string) { const m = this.member(id); if (!m.admin) throw new AppError(403, '需要权限管理员权限'); return m; }
  start(expectedActor?: string) {
    const state = random(), browser = random(), verifier = random();
    for (const old of this.store.all('oauth')) if (old.expires < Date.now()) this.store.remove('oauth', old.id);
    const id = hash(state); this.store.put('oauth', id, { id, browser: hash(browser), verifier, expectedActor, expires: Date.now() + 5 * 60_000 });
    const url = new URL('https://accounts.feishu.cn/open-apis/authen/v1/authorize');
    url.search = new URLSearchParams({ client_id: this.config.appId, response_type: 'code', redirect_uri: this.config.origin + '/auth/feishu/callback', scope: this.config.scopes, state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
    return { url: url.href, browser };
  }
  async oauth(data: any) {
    let response: Response;
    try { response = await this.fetcher('https://open.feishu.cn/open-apis/authen/v2/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: this.config.appId, client_secret: this.config.appSecret, ...data }), redirect: 'error', signal: AbortSignal.timeout(30_000) }); }
    catch { throw new AppError(503, '飞书授权服务暂不可用，请重新发起授权'); }
    let result: any; try { result = JSON.parse((await readLimited(response, 128 * 1024)).toString()); } catch { throw new AppError(401, '飞书授权响应无效，请重新授权'); }
    if (!response.ok || (result.code != null && result.code !== 0) || !result.access_token || !(result.expires_in > 0)) throw new AppError(401, '飞书授权失败，请检查应用配置或重新授权');
    return { access: result.access_token, refresh: result.refresh_token, expires: Date.now() + result.expires_in * 1000, refreshExpires: result.refresh_expires_in ? Date.now() + result.refresh_expires_in * 1000 : undefined, scope: result.scope ?? '' };
  }
  async callback(state: string, browser: string, code: string) {
    const id = hash(state), transaction = this.store.get('oauth', id);
    if (!transaction || transaction.expires < Date.now() || !equal(transaction.browser, hash(browser))) throw new AppError(400, '授权会话无效或已过期，请重新登录');
    this.store.remove('oauth', id);
    if (!code || code.length > 2048) throw new AppError(400, '授权未完成，请重新发起');
    const credentials = await this.oauth({ grant_type: 'authorization_code', code, redirect_uri: this.config.origin + '/auth/feishu/callback', code_verifier: transaction.verifier });
    let response: Response;
    try { response = await this.fetcher('https://open.feishu.cn/open-apis/authen/v1/user_info', { headers: { Authorization: `Bearer ${credentials.access}` }, redirect: 'error', signal: AbortSignal.timeout(30_000) }); }
    catch { throw new AppError(503, '无法获取飞书身份，请重新登录'); }
    const info = JSON.parse((await readLimited(response, 128 * 1024)).toString()); const user = info.data;
    if (!response.ok || info.code !== 0 || user?.tenant_key !== this.config.tenant || !user.open_id) throw new AppError(403, '仅允许指定飞书组织的成员登录');
    const actor = hash(user.tenant_key + ':' + user.open_id);
    if (transaction.expectedActor && transaction.expectedActor !== actor) throw new AppError(403, '重新授权的账号与当前账号不一致');
    this.store.transaction(() => {
      const old = this.store.get('member', actor);
      if (old && !old.enabled) throw new AppError(403, '账号已停用');
      const isBootstrap = !this.store.get('config', 'bootstrapped') && user.open_id === this.config.admin;
      const member = old ?? { id: actor, tenant: user.tenant_key, openId: user.open_id, admin: false, reviewer: false, enabled: true, version: 1 };
      if (isBootstrap) { member.admin = true; this.store.put('config', 'bootstrapped', true); }
      member.name = typeof user.name === 'string' ? user.name : '飞书成员';
      this.store.put('member', actor, member); this.store.put('credential', actor, encrypt(this.config.key, credentials, actor));
      this.store.audit(actor, 'login', actor);
    });
    const session = random(), csrf = random(); this.store.put('session', hash(session), { id: hash(session), actor, csrf, expires: Date.now() + 8 * 3600_000 });
    return { session, actor };
  }
  session(raw: string | undefined) { if (!raw) throw new AppError(401, '请先登录'); const session = this.store.get('session', hash(raw)); if (!session || session.expires < Date.now()) throw new AppError(401, '登录已过期，请重新登录'); this.member(session.actor); return session; }
  async token(actor: string): Promise<string> {
    this.member(actor); const saved = this.store.get('credential', actor); if (!saved) throw new AppError(401, '请重新授权飞书文档读取权限');
    const value = decrypt(this.config.key, saved, actor); if (value.expires > Date.now() + 60_000) return value.access;
    if (this.refreshing.has(actor)) return this.refreshing.get(actor)!;
    const promise = (async () => {
      try {
        if (!value.refresh || (value.refreshExpires && value.refreshExpires <= Date.now())) throw new AppError(401, '飞书授权已过期，请重新授权');
        const next = await this.oauth({ grant_type: 'refresh_token', refresh_token: value.refresh });
        this.member(actor);
        if (this.store.get('credential', actor) !== saved) throw new AppError(401, '授权状态已变化，请重试');
        this.store.put('credential', actor, encrypt(this.config.key, next, actor)); return next.access;
      } catch (e) { if (this.store.get('credential', actor) === saved) this.store.remove('credential', actor); throw e; }
      finally { this.refreshing.delete(actor); }
    })(); this.refreshing.set(actor, promise); return promise;
  }
  revoke(actor: string) { this.member(actor); this.store.remove('credential', actor); this.store.audit(actor, 'disconnect', actor); }
  updateMember(actor: string, id: string, input: any) {
    this.admin(actor);
    if (!Number.isInteger(input.version) || ['admin', 'reviewer', 'enabled'].some(k => typeof input[k] !== 'boolean')) throw new AppError(400, '角色参数不完整');
    return this.store.transaction(() => {
      const m = this.store.get('member', id); if (!m) throw new AppError(404, '成员不存在');
      if (input.version !== m.version) throw new AppError(409, '成员状态已更新，请刷新');
      if (m.admin && m.enabled && (!input.admin || !input.enabled) && this.store.all('member').filter(x => x.admin && x.enabled).length <= 1) throw new AppError(409, '不能停用或移除最后一位管理员');
      const next = { ...m, admin: input.admin, reviewer: input.reviewer, enabled: input.enabled, version: m.version + 1 };
      this.store.put('member', id, next); if (!next.enabled) { this.store.remove('credential', id); for (const session of this.store.all('session')) if (session.actor === id && session.id) this.store.remove('session', session.id); }
      this.store.audit(actor, 'member-update', id, { before: { admin: m.admin, reviewer: m.reviewer, enabled: m.enabled }, after: { admin: next.admin, reviewer: next.reviewer, enabled: next.enabled, version: next.version } }); return next;
    });
  }
}

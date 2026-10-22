import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { Auth, Store, AppError, hash, equal, configFromEnv } from './review-auth.ts';
import { ApiError } from './feishu-api.ts';
import { ReviewService } from './review-service.ts';
import { html, css, js } from './review-ui.ts';

function cookies(req: IncomingMessage) { const result: Record<string,string> = {}; for (const part of (req.headers.cookie ?? '').split(';')) { const i=part.indexOf('=');if(i>0)result[part.slice(0,i).trim()]=part.slice(i+1).trim(); } return result; }
async function input(req: IncomingMessage) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError(415, '请使用 JSON 请求');
  let size=0;const chunks: Buffer[]=[];for await(const chunk of req){size+=chunk.length;if(size>32768)throw new AppError(413,'请求过大');chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString());}catch{throw new AppError(400,'请求内容不是有效 JSON');}
}
export function createReviewServer(auth: Auth, service = new ReviewService(auth)) {
  const rates=new Map<string,{at:number,count:number}>();
  const server=createServer(async(req,res)=>{
    const origin=auth.config.origin, url=new URL(req.url??'/',origin), jar=cookies(req);
    const cookie=(name:string,value:string,seconds:number)=>`${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${seconds}${origin.startsWith('https:')?'; Secure':''}`;
    const send=(status:number,data:any,type='application/json; charset=utf-8')=>{res.writeHead(status,{'Content-Type':type});res.end(type.startsWith('application/json')?JSON.stringify(data):data);};
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try{
      if(req.method==='GET'&&['/','/app.js','/style.css'].includes(url.pathname)){const [value,type]=url.pathname==='/'?[html,'text/html; charset=utf-8']:url.pathname==='/app.js'?[js,'text/javascript; charset=utf-8']:[css,'text/css; charset=utf-8'];return send(200,value,type);}
      if(req.method==='GET'&&url.pathname==='/health')return send(200,{status:'ok'});
      if(req.method==='GET'&&url.pathname==='/auth/feishu/start'){
        const key=req.socket.remoteAddress??'local';const now=Date.now();for(const [k,v]of rates)if(now-v.at>60000)rates.delete(k);const entry=rates.get(key)??{at:now,count:0};if(++entry.count>20)throw new AppError(429,'授权请求过多，请稍后再试');rates.set(key,entry);
        let actor;try{actor=auth.session(jar.mmw_session).actor;}catch{}const start=auth.start(actor);res.setHeader('Set-Cookie',cookie('mmw_oauth',start.browser,300));res.writeHead(302,{Location:start.url});return res.end();
      }
      if(req.method==='GET'&&url.pathname==='/auth/feishu/callback'){
        const login=await auth.callback(url.searchParams.get('state')??'',jar.mmw_oauth??'',url.searchParams.get('code')??'');
        if(jar.mmw_session)auth.store.remove('session',hash(jar.mmw_session));res.setHeader('Set-Cookie',[cookie('mmw_session',login.session,8*3600),cookie('mmw_oauth','',0)]);res.writeHead(303,{Location:'/'});return res.end();
      }
      const session=auth.session(jar.mmw_session), actor=session.actor;
      if(!['GET','HEAD'].includes(req.method??'')){if(req.headers.origin!==origin||typeof req.headers['x-csrf-token']!=='string'||!equal(req.headers['x-csrf-token'],session.csrf))throw new AppError(403,'请求校验失败，请刷新页面');}
      if(req.method==='GET'&&url.pathname==='/api/me')return send(200,{member:auth.member(actor),csrf:session.csrf});
      if(req.method==='POST'&&url.pathname==='/api/logout'){auth.store.remove('session',hash(jar.mmw_session));res.setHeader('Set-Cookie',cookie('mmw_session','',0));return send(200,{ok:true});}
      if(req.method==='POST'&&url.pathname==='/api/disconnect'){auth.revoke(actor);return send(200,{ok:true});}
      if(req.method==='GET'&&url.pathname==='/api/admin/members'){auth.admin(actor);return send(200,auth.store.all('member'));}
      if(req.method==='GET'&&url.pathname==='/api/admin/audit'){auth.admin(actor);return send(200,auth.store.all('audit').slice(-100).reverse());}
      const member=url.pathname.match(/^\/api\/admin\/members\/([a-f0-9]{64})$/);if(req.method==='PATCH'&&member)return send(200,auth.updateMember(actor,member[1],await input(req)));
      if(url.pathname==='/api/tasks'){if(req.method==='GET')return send(200,service.list(actor));if(req.method==='POST')return send(202,service.create(actor,await input(req)));}
      const match=url.pathname.match(/^\/api\/tasks\/([\w-]{43})(?:\/(review|conversion|refetch|export|assets)(?:\/([a-f0-9]{24}\.(?:png|jpg|gif|webp)))?)?$/);
      if(match){const [,id,action,asset]=match;
        if(req.method==='GET'&&!action)return send(200,await service.detail(actor,id));
        if(req.method==='POST'&&action==='review')return send(200,await service.review(actor,id,await input(req)));
        if(req.method==='POST'&&action==='conversion')return send(200,await service.conversion(actor,id,await input(req)));
        if(req.method==='POST'&&action==='refetch'){await input(req);const old=service.task(actor,id);return send(202,service.create(actor,{url:old.url,...old.options},old));}
        if(req.method==='GET'&&action==='assets'&&asset){const bytes=await service.image(actor,id,asset);return send(200,bytes,'image/'+(asset.endsWith('.jpg')?'jpeg':asset.split('.').pop()));}
        if(req.method==='GET'&&action==='export'){const bytes=await service.export(actor,id);res.setHeader('Content-Disposition','attachment; filename="strategy.tar"');return send(200,bytes,'application/x-tar');}
      }
      throw new AppError(404,'接口不存在');
    }catch(error){
      if(error instanceof ApiError && error.kind==='authorization'){try{auth.revoke(auth.session(jar.mmw_session).actor);}catch{}}
      const status=error instanceof AppError?error.status:error instanceof ApiError?(error.kind==='authorization'?401:error.kind==='network'?503:409):500;
      const message=error instanceof AppError||error instanceof ApiError?error.message:'服务处理失败，未输出未确认的正式文件';
      if(!res.headersSent)send(status,{error:message});else res.end();
    }
  });
  server.requestTimeout=60_000;server.headersTimeout=15_000;
  return {server,service};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  if(process.argv.includes('--help'))console.log('启动审核服务：node --env-file=.env.local src/review-server.ts\n配置说明：docs/review-server.md\n服务只监听本机回环地址，正式使用需配置 HTTPS 反向代理。');
  else try{const config=configFromEnv(),store=new Store(path.join(config.dataDir,'review.sqlite'));const {server}=createReviewServer(new Auth(store,config));server.on('error',()=>{console.error('服务启动失败，请检查端口及数据目录');process.exitCode=1;});server.listen(config.port,'127.0.0.1',()=>console.log(`审核服务已启动：http://127.0.0.1:${config.port}`));}
  catch(error){console.error(error instanceof AppError?error.message:'服务配置或本地存储初始化失败');process.exitCode=1;}
}

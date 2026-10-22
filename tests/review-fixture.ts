import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { Auth, Store, random } from '../src/review-auth.ts';
import type { Config } from '../src/review-auth.ts';
import { ReviewService } from '../src/review-service.ts';

export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=', 'base64');
export function rawBlocks() { return [
 {block_id:'doc',block_type:1,children:['p1','mechanic','text','image','timeline']},
 {block_id:'p1',parent_id:'doc',block_type:3,heading1:{elements:[{text_run:{content:'P1阶段'}}]}},
 {block_id:'mechanic',parent_id:'doc',block_type:4,heading2:{elements:[{text_run:{content:'测试机制'}}]}},
 {block_id:'text',parent_id:'doc',block_type:2,text:{elements:[{text_run:{content:'分摊后分散',text_element_style:{bold:true}}}]}},
 {block_id:'image',parent_id:'doc',block_type:27,image:{token:'imageToken',width:100,height:100}},
 {block_id:'timeline',parent_id:'doc',block_type:28,isv:{component_id:'timeline'}}
]; }
export async function fixture() {
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'mmw-review-test-'));
 const config:Config={appId:'test-app',appSecret:random(),tenant:'test-tenant',admin:'admin-user',origin:'http://127.0.0.1:4325',scopes:'docx:document:readonly offline_access',key:randomBytes(32),dataDir,port:0};
 const store=new Store(path.join(dataDir,'review.sqlite'));
 const state:any={revision:1,user:'admin-user',tenant:config.tenant,denied:false,mediaDenied:false,calls:[],token:random(),refresh:random(),refreshCount:0,blocks:rawBlocks()};
 const fetcher:any=async(url:string,init:any={})=>{
  state.calls.push({url,method:init.method??'GET'});
  const ok=(data:any)=>new Response(JSON.stringify({code:0,data}),{headers:{'content-type':'application/json'}});
  if(url.endsWith('/oauth/token')){if(JSON.parse(init.body).grant_type==='refresh_token')state.refreshCount++;if(state.refreshWait)await state.refreshWait;return new Response(JSON.stringify({code:0,access_token:state.token,refresh_token:state.refresh,expires_in:7200,refresh_expires_in:86400,scope:config.scopes}));}
  if(url.endsWith('/user_info'))return ok({open_id:state.user,tenant_key:state.tenant,name:state.user==='admin-user'?'测试管理员':'测试成员'});
  if(state.denied)return new Response('{}',{status:403});
  if(url.includes('/spaces/get_node'))return ok({node:{obj_type:'docx',obj_token:'doc'}});
  if(url.endsWith('/documents/doc'))return ok({document:{document_id:'doc',title:'模拟攻略',revision_id:state.revision}});
  if(url.includes('/documents/doc/blocks'))return ok({items:new URL(url).searchParams.get('page_size')==='1'?state.blocks.slice(0,1):state.blocks,has_more:false});
  if(url.includes('/medias/'))return state.mediaDenied?new Response('{}',{status:403}):new Response(png,{headers:{'content-type':'image/png'}});
  throw new Error('未预期的模拟请求');
 };
 const auth=new Auth(store,config,fetcher);
 async function login(user='admin-user'){state.user=user;const start=auth.start();const code=random();return auth.callback(new URL(start.url).searchParams.get('state')!,start.browser,code);}
 const admin=await login();const m=auth.member(admin.actor);auth.updateMember(admin.actor,m.id,{version:m.version,admin:true,reviewer:true,enabled:true});
 const service=new ReviewService(auth);
 const create=async()=>{const task=service.create(admin.actor,{url:'https://example.feishu.cn/wiki/wikiNode',dutyId:'demo',dutyName:'测试副本',profile:'standard'});await service.jobs.get(task.id);return service.task(admin.actor,task.id);};
 return {config,store,state,auth,admin,service,login,create};
}

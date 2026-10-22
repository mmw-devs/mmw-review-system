import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { Auth, Store, hash, encrypt, decrypt, random } from '../src/review-auth.ts';
import type { Config } from '../src/review-auth.ts';
import { FeishuApi, blocksToTree, ApiError } from '../src/feishu-api.ts';
import { ReviewService } from '../src/review-service.ts';
import { createReviewServer } from '../src/review-server.ts';

import { fixture, rawBlocks } from './review-fixture.ts';

test('OAuth 回调校验浏览器绑定、组织、重放，普通成员不自动获得审核权限',async()=>{
 const f=await fixture();try{
  const start=f.auth.start(),state=new URL(start.url).searchParams.get('state')!;
  await assert.rejects(f.auth.callback(state,'wrong',random()),/授权会话/);
  await f.auth.callback(state,start.browser,random());await assert.rejects(f.auth.callback(state,start.browser,random()),/授权会话/);
  const normal=await f.login('normal');assert.equal(f.auth.member(normal.actor).reviewer,false);assert.throws(()=>f.auth.reviewer(normal.actor),/审核人员/);
  f.state.tenant='external';await assert.rejects(f.login(),/指定飞书组织/);
  const saved=f.store.get('credential',f.admin.actor);assert.ok(!saved.includes(f.state.token));assert.equal(decrypt(f.config.key,saved,f.admin.actor).access,f.state.token);
  assert.throws(()=>decrypt(f.config.key,saved,normal.actor),/无法读取/);
 }finally{f.store.close();}
});
test('刷新令牌按用户合并请求，断开授权后进行中的刷新不能恢复凭证',async()=>{
 const f=await fixture();try{
  const expired={access:random(),refresh:random(),expires:0,refreshExpires:Date.now()+60000};f.store.put('credential',f.admin.actor,encrypt(f.config.key,expired,f.admin.actor));
  await Promise.all([f.auth.token(f.admin.actor),f.auth.token(f.admin.actor)]);assert.equal(f.state.refreshCount,1);
  f.store.put('credential',f.admin.actor,encrypt(f.config.key,expired,f.admin.actor));let release:any;f.state.refreshWait=new Promise(r=>release=r);
  const pending=f.auth.token(f.admin.actor);f.auth.revoke(f.admin.actor);release();await assert.rejects(pending,/状态已变化/);assert.equal(f.store.get('credential',f.admin.actor),undefined);
 }finally{f.store.close();}
});
test('文档块按父子顺序重建，缺失、孤立、循环及未知行内内容不被静默忽略',()=>{
 const blocks=rawBlocks();const tree=blocksToTree([...blocks].reverse(),'doc','标题');assert.equal((tree.children[1]as any).attrs.id,'p1');
 assert.throws(()=>blocksToTree(blocks.filter(b=>b.block_id!=='text'),'doc','标题'),/缺少/);
 assert.throws(()=>blocksToTree([...blocks,{block_id:'orphan',block_type:22}],'doc','标题'),/未归属/);
 const cyclic=structuredClone(blocks);cyclic[0].children!.push('doc');assert.throws(()=>blocksToTree(cyclic,'doc','标题'),/循环/);
 const unknown:any=structuredClone(blocks);unknown[3].text.elements=[{mention_user:{user_id:'u'}}];const result=blocksToTree(unknown,'doc','标题');assert.equal((result.children[3]as any).tag,'unsupported');
});
test('无 CLI 读取保存原始块与图片，审核及排除确认后导出且禁止覆盖',async()=>{
 const f=await fixture();try{
  const task=await f.create();assert.equal(task.reading,'ready');const d=await f.service.detail(f.admin.actor,task.id);assert.equal(d.result.unsupported.length,1);assert.equal(d.result.document.phases[0].id,'p1');
  const snap=JSON.parse(await readFile(path.join(f.service.dir(task.id),'snapshot.json'),'utf8'));assert.equal(snap.snapshot_version,2);assert.equal(snap.blocks.length,6);assert.ok(!JSON.stringify(snap).includes(f.state.token));
  await assert.rejects(f.service.conversion(f.admin.actor,task.id,{action:'export',version:task.version,digest:task.digest,discard:true}),/审核通过/);
  const reviewed=await f.service.review(f.admin.actor,task.id,{decision:'approved',comment:'',version:task.version,snapshotHash:task.snapshotHash});
  await assert.rejects(f.service.conversion(f.admin.actor,task.id,{action:'export',version:reviewed.version,digest:task.digest}),/未明确确认/);
  await assert.rejects(f.service.conversion(f.admin.actor,task.id,{action:'export',version:reviewed.version,digest:'old',discard:true}),/已变化/);
  const done=await f.service.conversion(f.admin.actor,task.id,{action:'export',version:reviewed.version,digest:task.digest,discard:true});assert.equal(done.conversion,'completed');
  const same=await f.service.conversion(f.admin.actor,task.id,{action:'export',version:reviewed.version,digest:task.digest,discard:true});assert.equal(same.artifactHash,done.artifactHash);
  const archive=await f.service.export(f.admin.actor,task.id);assert.equal(archive.subarray(0,13).toString(),'strategy.json');assert.ok(!archive.includes(Buffer.from('snapshot.json')));
  await writeFile(path.join(f.service.dir(task.id),'strategy.json'),'{}');await assert.rejects(f.service.export(f.admin.actor,task.id),/产物已变化/);
 }finally{f.store.close();}
});
test('跨用户、管理角色、撤销审核角色和原文权限不能借缓存访问正文与导出',async()=>{
 const f=await fixture();try{
  const task=await f.create(), other=await f.login('other');let m=f.auth.member(other.actor);f.auth.updateMember(f.admin.actor,m.id,{version:m.version,admin:true,reviewer:false,enabled:true});assert.throws(()=>f.service.task(other.actor,task.id),/审核人员/);
  m=f.auth.member(other.actor);f.auth.updateMember(f.admin.actor,m.id,{version:m.version,admin:true,reviewer:true,enabled:true});await assert.rejects(f.service.detail(other.actor,task.id),/不存在或无权/);
  f.state.denied=true;await assert.rejects(f.service.detail(f.admin.actor,task.id),/无权访问/);f.state.denied=false;
  m=f.auth.member(f.admin.actor);f.auth.updateMember(f.admin.actor,m.id,{version:m.version,admin:true,reviewer:false,enabled:true});await assert.rejects(f.service.detail(f.admin.actor,task.id),/审核人员/);
 }finally{f.store.close();}
});
test('原文更新、图片权限缺失与任务快照篡改的边界',async()=>{
 const f=await fixture();try{
  const task=await f.create();f.state.revision=2;await assert.rejects(f.service.review(f.admin.actor,task.id,{decision:'approved',comment:'',version:task.version,snapshotHash:task.snapshotHash}),/原文已更新/);
  f.state.mediaDenied=true;await assert.rejects(f.service.detail(f.admin.actor,task.id),/无权访问/);
  const newer=await f.create();const detail=await f.service.detail(f.admin.actor,newer.id);assert.ok(detail.result.unsupported.some((i:any)=>i.reason.includes('无权访问')));
  const file=path.join(f.service.dir(newer.id),'snapshot.json');const raw=JSON.parse(await readFile(file,'utf8'));raw.title='changed';await writeFile(file,JSON.stringify(raw));await assert.rejects(f.service.detail(f.admin.actor,newer.id),/快照已变化/);
 }finally{f.store.close();}
});
test('最后管理员不可移除；角色变更使读取中的旧授权检查失效',async()=>{
 const f=await fixture();try{
  const m=f.auth.member(f.admin.actor);assert.throws(()=>f.auth.updateMember(m.id,m.id,{version:m.version,admin:false,reviewer:true,enabled:true}),/最后一位/);
  f.auth.updateMember(m.id,m.id,{version:m.version,admin:true,reviewer:false,enabled:true});assert.throws(()=>f.service.checkpoint(m.id,m.version),/审核人员/);
 }finally{f.store.close();}
});
test('HTTP 接口校验会话与 CSRF，静态数据目录不公开，管理页面不泄漏凭证',async()=>{
 const f=await fixture(),{server}=createReviewServer(f.auth,f.service);try{
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const addr=server.address()as any,base='http://127.0.0.1:'+addr.port;f.config.origin=base;
  const anonymous=await fetch(base+'/api/tasks');assert.equal(anonymous.status,401);
  const headers={Cookie:'mmw_session='+f.admin.session};const who=await(await fetch(base+'/api/me',{headers})).json();assert.ok(!JSON.stringify(who).includes(f.state.token));
  const request={...headers,'Content-Type':'application/json','X-CSRF-Token':who.csrf};
  assert.equal((await fetch(base+'/api/tasks',{method:'POST',headers:request,body:'{}'})).status,403);
  assert.equal((await fetch(base+'/data/review/review.sqlite',{headers})).status,404);
  const page=await(await fetch(base+'/')).text();assert.ok(page.includes('使用飞书授权登录'));assert.ok(!page.includes(f.state.token));
  const logout=await fetch(base+'/api/logout',{method:'POST',headers:{...request,Origin:base},body:'{}'});assert.equal(logout.status,200);assert.equal((await fetch(base+'/api/me',{headers})).status,401);
 }finally{await new Promise<void>(r=>server.close(()=>r()));f.store.close();}
});

test('分页重复、读取中版本变化和中途撤销角色会阻断就绪快照',async()=>{
 const f=await fixture();try{
  const original=f.auth.fetcher;let metadata=0;
  f.auth.fetcher=(async(url:any,init:any)=>{if(String(url).endsWith('/documents/doc')&&++metadata===2)f.state.revision++;return original(url,init);})as any;
  const changed=await f.create();assert.equal(changed.reading,'failed');assert.match(changed.error,/版本变化/);
  f.auth.fetcher=(async(url:any,init:any)=>String(url).includes('/blocks')?new Response(JSON.stringify({code:0,data:{items:rawBlocks(),has_more:true,page_token:'repeated'}})):original(url,init))as any;
  const paged=await f.create();assert.equal(paged.reading,'failed');assert.match(paged.error,/分页/);
  f.auth.fetcher=(async(url:any,init:any)=>{if(String(url).includes('/blocks')){const m=f.auth.member(f.admin.actor);f.auth.updateMember(m.id,m.id,{version:m.version,admin:true,reviewer:false,enabled:true});}return original(url,init);})as any;
  const task=f.service.create(f.admin.actor,{url:'https://example.feishu.cn/docx/doc',dutyId:'demo',dutyName:'测试'});await f.service.jobs.get(task.id);assert.equal(f.store.get('task',task.id).reading,'failed');
 }finally{f.store.close();}
});
test('有序列表连续编号且普通表格保持单元格顺序；未知结构进入清单',()=>{
 const blocks:any[]=[{block_id:'doc',block_type:1,children:['a','b','table']},
  ...['a','b'].map(id=>({block_id:id,parent_id:'doc',block_type:13,ordered:{style:{sequence:'auto'},elements:[{text_run:{content:id}}]}})),
  {block_id:'table',parent_id:'doc',block_type:31,children:['cell1','cell2'],table:{cells:['cell1','cell2'],property:{row_size:1,column_size:2}}},
  {block_id:'cell1',parent_id:'table',block_type:32,children:['c1']},{block_id:'cell2',parent_id:'table',block_type:32,children:['c2']},
  ...['c1','c2'].map((id,i)=>({block_id:id,parent_id:'cell'+(i+1),block_type:2,text:{elements:[{text_run:{content:id}}]}}))];
 const root=blocksToTree(blocks,'doc','标题');const list=root.children[1]as any;assert.equal(list.tag,'ol');assert.equal(list.children.length,2);const table=root.children[2]as any;assert.equal(table.children[0].children[1].children[0].children[0],'c2');
});
test('停用并重新启用成员不会恢复旧会话；管理员配置不会重新赋权',async()=>{
 const f=await fixture();try{
  const user=await f.login('member');const m=f.auth.member(user.actor);f.auth.updateMember(f.admin.actor,m.id,{version:m.version,admin:false,reviewer:true,enabled:false});
  const disabled=f.store.get('member',m.id);f.auth.updateMember(f.admin.actor,m.id,{version:disabled.version,admin:false,reviewer:true,enabled:true});assert.throws(()=>f.auth.session(user.session),/已过期/);
  const other=await f.login('other');const otherMember=f.auth.member(other.actor);f.auth.updateMember(f.admin.actor,other.actor,{version:otherMember.version,admin:true,reviewer:false,enabled:true});
  const admin=f.auth.member(f.admin.actor);f.auth.updateMember(other.actor,admin.id,{version:admin.version,admin:false,reviewer:true,enabled:true});await f.login();assert.equal(f.auth.member(admin.id).admin,false);
 }finally{f.store.close();}
});
test('跨主机跳转被禁止且凭证不会出现在接口错误中',async()=>{
 let requested:any;const secret=random();const api=new FeishuApi(async()=>secret,(async(url:any,init:any)=>{requested={url,init};return new Response(JSON.stringify({code:99991679,msg:secret}));})as any);
 await assert.rejects(api.meta('doc'),e=>e instanceof ApiError&&e.kind==='scope'&&!e.message.includes(secret));assert.equal(requested.init.redirect,'error');assert.ok(requested.url.startsWith('https://open.feishu.cn/open-apis/'));
 await assert.rejects(api.request('https://untrusted.invalid/'),/接口地址无效/);
});

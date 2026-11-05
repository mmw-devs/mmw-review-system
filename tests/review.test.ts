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

import { convert, fingerprint } from '../src/converter.ts';
import { READER_VERSION } from '../src/feishu-api.ts';
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
  const task=await f.create();assert.equal(task.reading,'ready');const d=await f.service.detail(f.admin.actor,task.id);assert.equal(d.issueCounts.unsupported,1);assert.equal(d.result,undefined);assert.equal((await f.service.unit(f.admin.actor,task.id,'p1')).document.phases[0].id,'p1');
  const snap=JSON.parse(await readFile(path.join(f.service.dir(task.id),'snapshot.json'),'utf8'));assert.equal(snap.snapshot_version,2);assert.equal(snap.blocks.length,6);assert.ok(!JSON.stringify(snap).includes(f.state.token));
  await assert.rejects(f.service.conversion(f.admin.actor,task.id,{action:'export',version:task.version,digest:task.digest,discard:true}),/审核通过/);
  const basic=await f.service.review(f.admin.actor,task.id,{unitId:'basic',digest:task.digest,decision:'approved',comment:'',version:task.version,snapshotHash:task.snapshotHash});
  assert.equal(basic.review,'pending');
  await assert.rejects(f.service.conversion(f.admin.actor,task.id,{action:'export',version:basic.version,digest:task.digest,discard:true}),/审核通过/);
  const reviewed=await f.service.review(f.admin.actor,task.id,{unitId:'p1',digest:task.digest,decision:'approved',comment:'',version:basic.version,snapshotHash:task.snapshotHash});
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
  const task=await f.create();f.state.revision=2;const unit=(await f.service.detail(f.admin.actor,task.id)).units[0];const approved=await f.service.review(f.admin.actor,task.id,{decision:'approved',comment:'',version:task.version,snapshotHash:task.snapshotHash,unitId:unit.id,digest:task.digest});assert.equal(approved.unitReviews[unit.id].review,'approved');
  f.state.mediaDenied=true;
  await f.service.detail(f.admin.actor,task.id);
  const snapshot=JSON.parse(await readFile(path.join(f.service.dir(task.id),'snapshot.json'),'utf8'));
  const src=Object.values(snapshot.images).find((i:any)=>i.src)?.src;
  assert.ok(src);
  const localImage=await f.service.image(f.admin.actor,task.id,src.split('/').pop());
  assert.ok(localImage.length>0);
  const newer=await f.create();const detail=await f.service.detail(f.admin.actor,newer.id);assert.ok((await f.service.issues(f.admin.actor,newer.id)).unsupported.some((i:any)=>i.reason.includes('无权访问')));
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


test('分 P 审核校验未知页和过期决定，单 P 通过可导出完整攻略并继续审核',async()=>{
 const f=await fixture();try{
  const root=f.state.blocks[0];root.children.push('half','halfBody','p2','p2Body');
  for(const [id,title] of [['half','P1.5'],['p2','P2']]) f.state.blocks.push({block_id:id,parent_id:'doc',block_type:3,heading1:{elements:[{text_run:{content:title}}]}},{block_id:id+'Body',parent_id:'doc',block_type:2,text:{elements:[{text_run:{content:title+' 正文'}}]}});
  const task=await f.create();const d=await f.service.detail(f.admin.actor,task.id);
  assert.deepEqual(d.units.map((u:any)=>u.id),['basic','p1','p1-5','p2']);
  const input={decision:'approved',comment:'',version:task.version,snapshotHash:task.snapshotHash,digest:task.digest};
  await assert.rejects(f.service.review(f.admin.actor,task.id,input),/页面不存在/);
  await assert.rejects(f.service.review(f.admin.actor,task.id,{...input,unitId:'p3'}),/页面不存在/);
  await assert.rejects(f.service.review(f.admin.actor,task.id,{...input,unitId:'basic',digest:'old'}),/已变化/);
  const basic=await f.service.review(f.admin.actor,task.id,{...input,unitId:'basic'});
  const same=await f.service.review(f.admin.actor,task.id,{...input,unitId:'basic'});assert.equal(same.version,basic.version);
  await assert.rejects(f.service.review(f.admin.actor,task.id,{...input,unitId:'p1'}),/状态已变化/);
  let current=await f.service.review(f.admin.actor,task.id,{...input,unitId:'p1-5',version:basic.version,decision:'rejected'});
  await assert.rejects(f.service.conversion(f.admin.actor,task.id,{action:'export',version:current.version,digest:task.digest,discard:true}),/至少一个 P/);
  current=await f.service.review(f.admin.actor,task.id,{...input,unitId:'p1',version:current.version});
  assert.equal(current.review,'rejected');assert.equal(current.unitReviews['p1-5'].reviewer,f.admin.actor);
  const done=await f.service.conversion(f.admin.actor,task.id,{action:'export',version:current.version,digest:task.digest,discard:true});
  assert.equal(done.conversion,'completed');assert.equal(done.review,'rejected');assert.equal(done.unitReviews.p2,undefined);
  assert.equal(done.actions.review.p2.allowed,true);assert.equal(done.actions.export.allowed,false);assert.equal(done.actions.download.allowed,true);
  const json=JSON.parse(await readFile(path.join(f.service.dir(task.id),'strategy.json'),'utf8'));
  assert.deepEqual(json.phases.map((p:any)=>p.id),['p1','p1-5','p2']);
  assert.ok((await f.service.export(f.admin.actor,task.id)).length>512);
  current=await f.service.review(f.admin.actor,task.id,{...input,unitId:'p2',version:done.version});assert.equal(current.unitReviews.p2.review,'approved');
  const next=f.service.create(f.admin.actor,{url:task.url,...task.options},current);await f.service.jobs.get(next.id);
  const newer=await f.service.detail(f.admin.actor,next.id);assert.ok(newer.units.every((u:any)=>u.review==='pending'));assert.equal(newer.generation,2);
 }finally{f.store.close();}
});

test('旧任务保留整篇审核和原摘要，重新获取才启用分 P',async()=>{
 const f=await fixture();try{
  const task=await f.create(),dir=f.service.dir(task.id);
  const snapshot=JSON.parse(await readFile(path.join(dir,'snapshot.json'),'utf8'));
  const result=convert(snapshot,task.options,false);
  const digest=fingerprint({snapshotHash:task.snapshotHash,options:task.options,reader:READER_VERSION,converter:'review-1',result});
  delete task.reviewMode;delete task.unitReviews;task.digest=digest;
  f.store.put('task',task.id,task);await writeFile(path.join(dir,'report.json'),JSON.stringify({...result,digest,converter:'review-1'}));
  const detail=await f.service.detail(f.admin.actor,task.id);assert.equal(detail.units,undefined);
  assert.equal(detail.actions.review.whole.allowed,true);assert.equal(detail.actions.export.allowed,false);
  const reviewed=await f.service.review(f.admin.actor,task.id,{decision:'approved',comment:'整篇审核',version:task.version,snapshotHash:task.snapshotHash});assert.equal(reviewed.review,'approved');
  assert.equal(reviewed.actions.review.whole.allowed,false);assert.equal(reviewed.actions.export.allowed,true);
  const done=await f.service.conversion(f.admin.actor,task.id,{action:'export',version:reviewed.version,digest,discard:true});assert.equal(done.conversion,'completed');
 }finally{f.store.close();}
});

test('HTTP 权限失效明确要求清空缓存，状态冲突和暂时故障保留缓存',async()=>{
 const f=await fixture(),{server}=createReviewServer(f.auth,f.service);try{
  const task=await f.create();
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+(server.address()as any).port;f.config.origin=base;
  const headers={Cookie:'mmw_session='+f.admin.session};const url=base+'/api/tasks/'+task.id;
  const anonymous=await fetch(url);assert.equal(anonymous.status,401);assert.equal((await anonymous.json()).clearTask,true);
  assert.equal((await fetch(url,{headers})).status,200);
  f.state.denied=true;
  const denied=await fetch(url,{headers}),body=await denied.json();
  assert.equal(denied.status,403);assert.equal(body.code,'SOURCE_PERMISSION_DENIED');assert.equal(body.clearTask,true);assert.ok(!JSON.stringify(body).includes(f.state.token));
  f.state.denied=false;
  const csrf=(await(await fetch(base+'/api/me',{headers})).json()).csrf;
  const stale=await fetch(url+'/review',{method:'POST',headers:{...headers,Origin:base,'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({unitId:'basic',decision:'approved',comment:'',snapshotHash:task.snapshotHash,digest:task.digest,version:task.version-1})});
  assert.equal(stale.status,409);assert.equal((await stale.json()).clearTask,false);
  for(const [kind,status,code,clearTask] of [['scope',403,'SOURCE_SCOPE_REQUIRED',true],['network',503,'UPSTREAM_UNAVAILABLE',false],['structure',409,'SOURCE_STRUCTURE_INVALID',false],['authorization',401,'AUTHORIZATION_REQUIRED',true]] as const){
   f.service.detail=async()=>{throw new ApiError(kind,'模拟接口错误');};
   const response=await fetch(url,{headers});assert.equal(response.status,status);assert.deepEqual(await response.json(),{error:'模拟接口错误',code,clearTask});
  }
 }finally{await new Promise<void>(r=>server.close(()=>r()));f.store.close();}
});

test('详情与操作响应共享动作规则，取消后禁止待审页操作且不持久化派生动作',async()=>{
 const f=await fixture();try{
  const task=await f.create();const initial=await f.service.detail(f.admin.actor,task.id);
  assert.equal(initial.actions.review.basic.allowed,true);assert.equal(initial.actions.review.p1.allowed,true);assert.equal(initial.actions.export.allowed,false);assert.equal(initial.actions.cancel.allowed,false);
  const input={unitId:'p1',decision:'approved',comment:'',version:task.version,snapshotHash:task.snapshotHash,digest:task.digest};
  const reviewed=await f.service.review(f.admin.actor,task.id,input);
  assert.equal(reviewed.actions.export.allowed,true);assert.equal(reviewed.actions.cancel.allowed,true);assert.equal(reviewed.actions.review.basic.allowed,true);
  const cancelInput={action:'cancel',version:reviewed.version,digest:task.digest};
  const cancelled=await f.service.conversion(f.admin.actor,task.id,cancelInput);
  assert.equal(cancelled.actions.review.basic.allowed,false);assert.ok(cancelled.actions.review.basic.reason);assert.equal(cancelled.actions.export.allowed,false);assert.equal(cancelled.actions.cancel.allowed,false);assert.equal(cancelled.actions.download.allowed,false);
  assert.deepEqual((await f.service.detail(f.admin.actor,task.id)).actions,cancelled.actions);
  assert.deepEqual((await f.service.conversion(f.admin.actor,task.id,cancelInput)).actions,cancelled.actions);
  await assert.rejects(f.service.review(f.admin.actor,task.id,{...input,unitId:'basic',version:cancelled.version}),/取消/);
  assert.equal(f.store.get('task',task.id).actions,undefined);
 }finally{f.store.close();}
});

test('阻断问题只禁止导出，过期审核摘要不能取得转换资格',async()=>{
 const f=await fixture();try{
  const task=await f.create();const reviewed=await f.service.review(f.admin.actor,task.id,{unitId:'p1',decision:'approved',comment:'',version:task.version,snapshotHash:task.snapshotHash,digest:task.digest});
  const stored=f.store.get('task',task.id);stored.unitReviews.p1.digest='old';f.store.put('task',task.id,stored);
  const stale=await f.service.detail(f.admin.actor,task.id);assert.equal(stale.actions.export.allowed,false);assert.equal(stale.actions.cancel.allowed,false);
  await assert.rejects(f.service.conversion(f.admin.actor,task.id,{action:'export',version:reviewed.version,digest:task.digest,discard:true}),/审核通过/);
  f.state.blocks=f.state.blocks.filter((b:any)=>['doc','p1'].includes(b.block_id));f.state.blocks[0].children=['p1'];
  const empty=await f.create();assert.ok((await f.service.detail(f.admin.actor,empty.id)).issueCounts.blockers);
  const approved=await f.service.review(f.admin.actor,empty.id,{unitId:'p1',decision:'approved',comment:'',version:empty.version,snapshotHash:empty.snapshotHash,digest:empty.digest});
  assert.equal(approved.actions.export.allowed,false);assert.ok(approved.actions.export.reason);assert.equal(approved.actions.cancel.allowed,true);
  await assert.rejects(f.service.conversion(f.admin.actor,empty.id,{action:'export',version:approved.version,digest:empty.digest,discard:true}),/阻断/);
  assert.equal((await f.service.conversion(f.admin.actor,empty.id,{action:'cancel',version:approved.version,digest:empty.digest})).conversion,'cancelled');
 }finally{f.store.close();}
});

test('分页导入在后续页等待时可读取已闭合 P，未下载图片不是排除项且不能提前审核',async()=>{
 const f=await fixture();let release!:()=>void;let entered!:()=>void;
 const gate=new Promise<void>(r=>release=r), reached=new Promise<void>(r=>entered=r);
 try{
  f.state.blocks[0].children.push('p2','p2text');
  f.state.blocks.push({block_id:'p2',parent_id:'doc',block_type:3,heading1:{elements:[{text_run:{content:'P2'}}]}},{block_id:'p2text',parent_id:'doc',block_type:2,text:{elements:[{text_run:{content:'尚未读取的 P2 正文'}}]}});
  f.state.pageSize=7;
  f.state.beforeRequest=async(url:string)=>{if(url.includes('/medias/')){entered();await gate;}};
  const t=f.service.create(f.admin.actor,{url:'https://example.feishu.cn/docx/doc',dutyId:'demo',dutyName:'测试',profile:'standard'});
  await reached;
  const detail=await f.service.detail(f.admin.actor,t.id);assert.equal(detail.reading,'reading');assert.deepEqual(detail.units.map((u:any)=>u.id),['basic','p1']);
  assert.equal(detail.result,undefined);assert.equal(detail.actions.export.allowed,false);
  const unit=await f.service.unit(f.admin.actor,t.id,'p1');assert.equal(unit.final,false);assert.ok(JSON.stringify(unit.document).includes('image_pending'));assert.ok(!unit.unsupported.some((i:any)=>i.reason.includes('图片未能获取')));
  assert.ok(!JSON.stringify(unit).includes('尚未读取的 P2 正文'));
  await assert.rejects(f.service.unit(f.admin.actor,t.id,'p2'),/尚未读取完整/);
  await assert.rejects(f.service.review(f.admin.actor,t.id,{decision:'approved',comment:'',unitId:'p1'}),/尚未就绪/);
  await assert.rejects(f.service.issues(f.admin.actor,t.id),/尚未就绪/);
  release();await f.service.jobs.get(t.id);
  const ready=await f.service.detail(f.admin.actor,t.id);assert.equal(ready.reading,'ready');assert.deepEqual(ready.units.map((u:any)=>u.id),['basic','p1','p2']);
  const completed=await f.service.unit(f.admin.actor,t.id,'p1');assert.ok(!JSON.stringify(completed).includes('image_pending'));assert.notEqual(completed.hash,unit.hash);
  assert.ok((await readFile(path.join(f.service.dir(t.id),'blocks','0.json'),'utf8')).includes('p1'));
 }finally{release();await Promise.all([...f.service.jobs.values()]);f.store.close();}
});

test('分页正文和图片使用独立索引，篡改、跨用户、权限撤销与旧正文缓存均不能绕过检查',async()=>{
 const f=await fixture();try{
  const task=await f.create(),unit=await f.service.unit(f.admin.actor,task.id,'p1');
  // 浏览路径不能退回全量 files()/convert；审核和导出仍保留该检查。
  f.service.files=async()=>{throw new Error('不应重读全文');};
  assert.equal((await f.service.detail(f.admin.actor,task.id)).result,undefined);
  assert.equal((await f.service.unit(f.admin.actor,task.id,'basic')).document.phase_contents.length,0);
  const index=f.store.get('content',task.id),asset=Object.keys(index.assets)[0].split('/').pop();
  assert.ok((await f.service.image(f.admin.actor,task.id,asset)).length);
  f.state.denied=true;await assert.rejects(f.service.unit(f.admin.actor,task.id,'p1'),/无权访问/);await assert.rejects(f.service.image(f.admin.actor,task.id,asset),/无权访问/);f.state.denied=false;
  await writeFile(path.join(f.service.dir(task.id),'units',unit.hash+'.json'),'{}');await assert.rejects(f.service.unit(f.admin.actor,task.id,'p1'),/已变化或不完整/);
 }finally{f.store.close();}
});

test('分页截断容器时不发布残缺表格，后续版本变化撤回预览',async()=>{
 const {completePrefix}=await import('../src/feishu-api.ts');
 const blocks:any[]=[{block_id:'doc',block_type:1,children:['p1','table','p2']},{block_id:'p1',parent_id:'doc',block_type:3,heading1:{elements:[{text_run:{content:'P1'}}]}},{block_id:'table',parent_id:'doc',block_type:31,children:['cell']},{block_id:'cell',parent_id:'table',block_type:32,children:['text']}];
 assert.deepEqual(completePrefix(blocks,'doc').map(b=>b.block_id),['doc','p1']);
 const f=await fixture();let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),reached=new Promise<void>(r=>entered=r);
 try{
  f.state.beforeRequest=async(url:string)=>{if(url.includes('/medias/')){entered();await gate;}};
  const t=f.service.create(f.admin.actor,{url:'https://example.feishu.cn/docx/doc',dutyId:'demo',dutyName:'测试'});await reached;
  assert.ok((await f.service.detail(f.admin.actor,t.id)).units.length);
  f.state.revision++;release();await f.service.jobs.get(t.id);
  assert.equal((await f.service.detail(f.admin.actor,t.id)).reading,'failed');await assert.rejects(f.service.unit(f.admin.actor,t.id,'p1'),/尚未就绪/);
 }finally{release();await Promise.all([...f.service.jobs.values()]);f.store.close();}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { Auth, Store, hash, encrypt, decrypt, random } from '../src/review-auth.ts';
import type { Config } from '../src/review-auth.ts';
import { FeishuApi, blocksToTree, ApiError } from '../src/feishu-api.ts';
import { ReviewService, tar } from '../src/review-service.ts';
import { generateAstro, ASTRO_EXPORT_VERSION, isReviewAssetPath } from '../src/astro-export.ts';
import { createReviewServer } from '../src/review-server.ts';

import { convert, fingerprint } from '../src/converter.ts';
import { READER_VERSION } from '../src/feishu-api.ts';
import { fixture, rawBlocks } from './review-fixture.ts';

const astroDocument = () => ({ schema_version:'0.1.0', duty:{id:'demo',name:'测试副本',title:'测试攻略'}, phases:[{id:'p1',title:'P1',name:'P1',mechanics:[]}], phase_contents:[{phase_id:'p1',sections:[{id:'body',type:'content',content:[{type:'paragraph',content:[{type:'text',text:'正文'}]}]}]}] }) as any;

test('Astro 全字段示例可生成，保留区块、表格和颜色且不改写输入',async()=>{
 const doc=JSON.parse(await readFile(new URL('../docs/examples/strategy-all-fields.v0.1.json',import.meta.url),'utf8')), before=JSON.stringify(doc);
 const result=generateAstro(doc), source=result.files.filter(file=>file.name.endsWith('.astro')).map(file=>file.content).join('\n');
 assert.equal(JSON.stringify(doc),before);assert.deepEqual(generateAstro(doc),result);
 for(const tag of ['MechanicSection','SolutionSection','MultiSolutionSection','NoteSection','CollapseSection','ContentSection','SeparatorSection','<table','<colgroup','<blockquote','<pre']) assert.ok(source.includes(tag),tag);
 assert.ok(source.includes('slot="summary"'));assert.ok(source.includes('slot="details"'));assert.ok(source.includes('client:load'));
 assert.ok(result.files.some(file=>file.name==='navigation.json'));assert.ok(!result.files.some(file=>file.name==='strategy.json'));
});

test('Astro 正文与属性不能注入模板代码，代码空白和组合样式保留',()=>{
 const doc=astroDocument();const payload='<script>alert(1)</script>{process.exit()} & "引号"';doc.duty.title=payload;
 doc.phase_contents[0].sections[0].content=[
  {type:'paragraph',align:'center',indent:2,content:[{type:'text',text:payload,style:{bold:true,italic:true,underline:true,strike:true,color:'#245bdb',background_color:'#abcdef',font_size_px:18},href:'https://example.com/?a=1&b=2'}]},
  {type:'code',text:'\n  /p 原始宏\r\n\t下一行\n',language:'plain_text',wrap:true},
  {type:'heading',level:9,content:[{type:'text',text:'小标题'}]},
 ];
 const result=generateAstro(doc), source=result.files.find(file=>file.name==='pages/p1.astro')!.content;
 assert.ok(!source.includes('<script>alert'));assert.ok(!source.includes('{process.exit()}'));
 assert.ok(source.includes('&lt;script&gt;alert(1)&lt;/script&gt;&#123;process.exit()&#125;'));
 assert.ok(source.includes('text-decoration:underline line-through'));assert.ok(source.includes('color:#245bdb;background-color:#abcdef;font-size:18px'));
 assert.ok(source.includes('<code>\n  /p 原始宏&#13;\n\t下一行\n</code>'));assert.ok(source.includes('aria-level="9"'));
 assert.ok(result.files[0].content.includes("siteBase + dutyId + '/'"));
});

test('Astro 多解法将默认 ID 映射为标题，重复标题明确拒绝',()=>{
 const doc=astroDocument(), title='解法 "A" & {一}';
 const content=doc.phase_contents[0].sections[0].content;
 doc.phase_contents[0].sections=[{id:'multi',type:'multi_solution',defaultSolution:'b',solutions:[{id:'a',title,content},{id:'b',title:'解法 B',content,beta:true}]}];
 const source=generateAstro(doc).files.find(file=>file.name==='pages/p1.astro')!.content;
 assert.ok(source.includes('defaultSolution={JSON.parse("\\"解法 B\\"")}'));
 assert.ok(source.includes('slot="解法 &quot;A&quot; &amp; &#123;一&#125;"'));assert.ok(source.includes('Beta（测试解法）'));
 doc.phase_contents[0].sections[0].solutions[1].title=title;
 assert.throws(()=>generateAstro(doc),/标题唯一/);
 doc.phase_contents[0].sections[0].solutions[1].title='__proto__';
 assert.throws(()=>generateAstro(doc),/保留名称/);
});

test('Astro 图片与横幅映射去重；表格跨度、列宽、分栏比例保留',()=>{
 const doc=astroDocument(), text=[{type:'paragraph',content:[{type:'text',text:'格子'}]}];doc.duty.banner='assets/a.png';
 doc.phase_contents[0].sections[0].content=[{type:'image',src:'assets/a.png',alt:'说明',caption:[{type:'text',text:'图注'}],align:'center',width:640,height:480},
 {type:'image',src:'https://example.com/b.png'},
 {type:'table',column_widths_px:[120,180],rows:[{cells:[{header:true,row_span:2,background_color:'#abcdef',content:text},{content:text}]},{cells:[{content:text}]}]},
 {type:'columns',columns:[{width_weight:2,content:text},{width_weight:1,content:text}]}];
 const result=generateAstro(doc), source=result.files.find(file=>file.name==='pages/p1.astro')!.content;
 assert.deepEqual(result.assets,[{source:'assets/a.png',target:'public/review-assets/demo/a.png'}]);
 assert.equal(Function('siteBase','return '+source.match(/src=\{([^}]+)\}/)![1])('/guide/'),'/guide/review-assets/demo/a.png');assert.ok(source.includes('src="https://example.com/b.png"'));
 assert.ok(source.includes('rowspan="2"'));assert.ok(source.includes('width:120px'));assert.ok(source.includes('flex:2 1 0'));
});

test('Astro 非法字段、路径、URL、控制字符和路由冲突不能静默导出',()=>{
 for(const mutate of [
  (d:any)=>{d.duty.extra='未知';},
  (d:any)=>{d.phase_contents[0].sections[0].content=[{type:'image',src:'../private.png'}];},
  (d:any)=>{d.phase_contents[0].sections[0].content[0].content[0].href='javascript:alert(1)';},
  (d:any)=>{d.phase_contents[0].sections[0].content[0].content[0].href='https://u:p@example.com/';},
  (d:any)=>{d.phase_contents[0].sections[0].content[0].content[0].text='隐藏\u0000字符';},
  (d:any)=>{d.phases[0].id='index';d.phase_contents[0].phase_id='index';},
  (d:any)=>{d.phases[0].href='/07/demo/p2';},
 ]) {const doc=astroDocument();mutate(doc);assert.throws(()=>generateAstro(doc));}
});

test('ustar 长图片路径按 prefix 保存，非法路径不截断或穿越',()=>{
 const name='public/review-assets/'+ 'a'.repeat(90) +'/abcdefghijklmnopqrstuvwx.png';
 const bytes=Buffer.from('图片');assert.deepEqual(archiveEntries(tar([{name,bytes}])).get(name),bytes);
 for(const invalid of ['../secret','/absolute','folder/../../secret','a'.repeat(260)])assert.throws(()=>tar([{name:invalid,bytes}]));
});

test('Astro 版本变化保留预览与审核，只禁止生成新产物；中断产物不被覆盖',async()=>{
 const f=await fixture();try{
  const task=await f.create();const changed={...task,exportFormat:'astro-future'};f.store.put('task',task.id,changed);
  const detail=await f.service.detail(f.admin.actor,task.id);assert.equal(detail.digest,task.digest);
  const reviewed=await f.service.review(f.admin.actor,task.id,{unitId:'p1',digest:task.digest,decision:'approved',comment:'',version:task.version,snapshotHash:task.snapshotHash});
  assert.equal(reviewed.actions.export.allowed,false);assert.equal(reviewed.actions.cancel.allowed,true);
  await assert.rejects(f.service.conversion(f.admin.actor,task.id,{action:'export',version:reviewed.version,digest:task.digest,confirmPresentation:true}),e=>e.status===409&&/旧版导出/.test(e.message));
  f.store.put('task',task.id,{...f.service.task(f.admin.actor,task.id),exportFormat:ASTRO_EXPORT_VERSION});
  const old=Buffer.from('上次中断的产物');await writeFile(path.join(f.service.dir(task.id),'strategy-site.tar'),old);
  await assert.rejects(f.service.conversion(f.admin.actor,task.id,{action:'export',version:reviewed.version,digest:task.digest,confirmPresentation:true}),/不会覆盖/);
  assert.deepEqual(await readFile(path.join(f.service.dir(task.id),'strategy-site.tar')),old);assert.notEqual(f.service.task(f.admin.actor,task.id).conversion,'completed');
 }finally{f.store.close();}
});

// 按 ustar 标准读取目录和字节，验证实际下载内容，避免只比对一个文件名。
function archiveEntries(bytes: Buffer) {
 const entries = new Map<string, Buffer>();
 for (let offset = 0; offset + 512 <= bytes.length && bytes[offset] !== 0;) {
  const header=bytes.subarray(offset,offset+512), read=(start:number,size:number)=>header.subarray(start,start+size).toString().replace(/\0.*$/s,'');
  const prefix=read(345,155), name=(prefix?prefix+'/':'')+read(0,100), size=parseInt(read(124,12).trim(),8);
  entries.set(name,bytes.subarray(offset+512,offset+512+size));offset+=512+Math.ceil(size/512)*512;
 }
 return entries;
}

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
test('无 CLI 读取保存原始块与图片，审核及表现确认后导出且禁止覆盖',async()=>{
 const f=await fixture();try{
  const task=await f.create();assert.equal(task.reading,'ready');const d=await f.service.detail(f.admin.actor,task.id);assert.equal(d.result.notices.length,1);assert.equal(d.result.document.phases[0].id,'p1');
  const snap=JSON.parse(await readFile(path.join(f.service.dir(task.id),'snapshot.json'),'utf8'));assert.equal(snap.snapshot_version,2);assert.equal(snap.blocks.length,5);assert.ok(!JSON.stringify(snap).includes(f.state.token));
  await assert.rejects(f.service.conversion(f.admin.actor,task.id,{action:'export',version:task.version,digest:task.digest,confirmPresentation:true}),/审核通过/);
  const basic=await f.service.review(f.admin.actor,task.id,{unitId:'basic',digest:task.digest,decision:'approved',comment:'',version:task.version,snapshotHash:task.snapshotHash});
  assert.equal(basic.review,'pending');
  await assert.rejects(f.service.conversion(f.admin.actor,task.id,{action:'export',version:basic.version,digest:task.digest,confirmPresentation:true}),/审核通过/);
  const reviewed=await f.service.review(f.admin.actor,task.id,{unitId:'p1',digest:task.digest,decision:'approved',comment:'',version:basic.version,snapshotHash:task.snapshotHash});
  await assert.rejects(f.service.conversion(f.admin.actor,task.id,{action:'export',version:reviewed.version,digest:task.digest}),/表现待确认/);
  await assert.rejects(f.service.conversion(f.admin.actor,task.id,{action:'export',version:reviewed.version,digest:'old',confirmPresentation:true}),/已变化/);
  const done=await f.service.conversion(f.admin.actor,task.id,{action:'export',version:reviewed.version,digest:task.digest,confirmPresentation:true});assert.equal(done.conversion,'completed');
  const same=await f.service.conversion(f.admin.actor,task.id,{action:'export',version:reviewed.version,digest:task.digest,confirmPresentation:true});assert.equal(same.artifactHash,done.artifactHash);
  const archive=await f.service.export(f.admin.actor,task.id), entries=archiveEntries(archive);assert.equal(done.exportFormat,ASTRO_EXPORT_VERSION);
  assert.ok(entries.has('pages/index.astro'));assert.ok(entries.has('pages/p1.astro'));assert.ok(entries.has('navigation.json'));
  assert.ok(entries.get('pages/p1.astro')!.toString().includes('分摊后分散'));
  const image=Object.values(snap.images).find((value:any)=>value.src) as any;
  assert.deepEqual(entries.get('public/review-assets/demo/'+image.src.slice(7)),await readFile(path.join(f.service.dir(task.id),image.src)));
  assert.ok(!entries.has('strategy.json'));assert.ok(!archive.includes(Buffer.from('snapshot.json')));
  await writeFile(path.join(f.service.dir(task.id),'strategy-site.tar'),'{}');await assert.rejects(f.service.export(f.admin.actor,task.id),/产物已变化/);
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
  const newer=await f.create();const detail=await f.service.detail(f.admin.actor,newer.id);assert.ok(detail.result.blockers.some((i:any)=>i.reason.includes('无权访问')));
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
  await assert.rejects(f.service.conversion(f.admin.actor,task.id,{action:'export',version:current.version,digest:task.digest,confirmPresentation:true}),/至少一个 P/);
  current=await f.service.review(f.admin.actor,task.id,{...input,unitId:'p1',version:current.version});
  assert.equal(current.review,'rejected');assert.equal(current.unitReviews['p1-5'].reviewer,f.admin.actor);
  const done=await f.service.conversion(f.admin.actor,task.id,{action:'export',version:current.version,digest:task.digest,confirmPresentation:true});
  assert.equal(done.conversion,'completed');assert.equal(done.review,'rejected');assert.equal(done.unitReviews.p2,undefined);
  assert.equal(done.actions.review.p2.allowed,true);assert.equal(done.actions.export.allowed,false);assert.equal(done.actions.download.allowed,true);
  const entries=archiveEntries(await f.service.export(f.admin.actor,task.id));
  const navigation=JSON.parse(entries.get('navigation.json')!.toString());
  assert.deepEqual(navigation.phases.map((p:any)=>p.id),['p1','p1-5','p2']);
  assert.ok(entries.get('pages/p1-5.astro')!.toString().includes('P1.5 正文'));assert.ok(entries.get('pages/p2.astro')!.toString().includes('P2 正文'));
  current=await f.service.review(f.admin.actor,task.id,{...input,unitId:'p2',version:done.version});assert.equal(current.unitReviews.p2.review,'approved');
  const next=f.service.create(f.admin.actor,{url:task.url,...task.options},current);await f.service.jobs.get(next.id);
  const newer=await f.service.detail(f.admin.actor,next.id);assert.ok(newer.units.every((u:any)=>u.review==='pending'));assert.equal(newer.generation,2);
 }finally{f.store.close();}
});

test('旧任务保留原摘要和已完成 JSON，未导出任务须重新获取才启用 Astro',async()=>{
 const f=await fixture();try{
  const task=await f.create(),dir=f.service.dir(task.id);
  const snapshot=JSON.parse(await readFile(path.join(dir,'snapshot.json'),'utf8'));
  const result=legacyResult(snapshot,task.options,false);
  const digest=fingerprint({snapshotHash:task.snapshotHash,options:task.options,reader:READER_VERSION,converter:'review-1',result});
  delete task.reviewMode;delete task.unitReviews;delete task.exportFormat;delete task.storageVersion;delete task.reportHash;delete task.exportPlanHash;task.digest=digest;
  f.store.put('task',task.id,task);await writeFile(path.join(dir,'report.json'),JSON.stringify({...result,digest,converter:'review-1'}));
  const detail=await f.service.detail(f.admin.actor,task.id);assert.equal(detail.units,undefined);
  assert.equal(detail.actions.review.whole.allowed,true);assert.equal(detail.actions.export.allowed,false);
  const reviewed=await f.service.review(f.admin.actor,task.id,{decision:'approved',comment:'整篇审核',version:task.version,snapshotHash:task.snapshotHash});assert.equal(reviewed.review,'approved');
  assert.equal(reviewed.actions.review.whole.allowed,false);assert.equal(reviewed.actions.export.allowed,false);
  await assert.rejects(f.service.conversion(f.admin.actor,task.id,{action:'export',version:reviewed.version,digest,confirmPresentation:true}),/旧版导出/);
  // 模拟升级前已经发布的 JSON，验证它不会被新代码重写为站点包。
  const json=Buffer.from(JSON.stringify(result.document));await writeFile(path.join(dir,'strategy.json'),json);
  const old=f.service.task(f.admin.actor,task.id);old.conversion='completed';old.artifactHash=hash(json);f.store.put('task',task.id,old);
  assert.deepEqual(archiveEntries(await f.service.export(f.admin.actor,task.id)).get('strategy.json'),json);
  const next=f.service.create(f.admin.actor,{url:task.url,...task.options},old);await f.service.jobs.get(next.id);
  assert.equal(next.exportFormat,ASTRO_EXPORT_VERSION);assert.equal((await f.service.detail(f.admin.actor,next.id)).units[0].review,'pending');
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

test('必须修正项禁止通过和导出，但允许驳回和取消；过期审核不能取得导出资格',async()=>{
 const f=await fixture();try{
  const task=await f.create(),reviewed=await f.service.review(f.admin.actor,task.id,{unitId:'p1',decision:'approved',comment:'',version:task.version,snapshotHash:task.snapshotHash,digest:task.digest});
  const stored=f.store.get('task',task.id);stored.unitReviews.p1.digest='old';f.store.put('task',task.id,stored);
  await assert.rejects(f.service.conversion(f.admin.actor,task.id,{action:'export',version:reviewed.version,digest:task.digest,confirmPresentation:true}),/审核通过/);
  f.state.blocks[0].children.push('unknown');f.state.blocks.push({block_id:'unknown',parent_id:'doc',block_type:28,isv:{component_id:'timeline'}});
  const invalid=await f.create(),detail=await f.service.detail(f.admin.actor,invalid.id);
  assert.equal(detail.result.blockers.length,1);assert.match(detail.result.blockers[0].reason,/无法解析/);
  assert.equal(detail.actions.approve.p1.allowed,false);assert.equal(detail.actions.review.p1.allowed,true);assert.equal(detail.actions.export.allowed,false);assert.equal(detail.actions.cancel.allowed,true);
  const input={unitId:'p1',decision:'approved',comment:'请修改',version:invalid.version,snapshotHash:invalid.snapshotHash,digest:invalid.digest};
  await assert.rejects(f.service.review(f.admin.actor,invalid.id,input),e=>e.status===409&&/必须修正/.test(e.message));
  await assert.rejects(f.service.conversion(f.admin.actor,invalid.id,{action:'export',version:invalid.version,digest:invalid.digest,discard:true,confirmPresentation:true}),e=>e.status===409&&/必须修正/.test(e.message));
  const rejected=await f.service.review(f.admin.actor,invalid.id,{...input,decision:'rejected'});assert.equal(rejected.unitReviews.p1.review,'rejected');
  assert.equal((await f.service.conversion(f.admin.actor,invalid.id,{action:'cancel',version:rejected.version,digest:invalid.digest})).conversion,'cancelled');
 }finally{f.store.close();}
});

test('Astro 时间基准统一为数字秒，根路径和部署前缀下路由均正确',()=>{
 for(const [base,seconds] of [[undefined,0],['00:00.000',0],['02:07.400',127.4],['120:00.500',7200.5]] as const){
  const doc=astroDocument();if(base)doc.phases[0].base=base;
  const files=generateAstro(doc).files,phase=files.find(f=>f.name==='pages/p1.astro')!.content,index=files[0].content;
  assert.equal(Number(phase.match(/base=\{([^}]+)\}/)![1]),seconds);
  for(const configured of ['/','/guide','/guide/']){
   const prefix=configured.replace(/\/?$/,'/');
   for(const [source,pathname] of [[phase,prefix+'07/demo/p1'],[index,prefix+'07/demo/'],[index,prefix+'07/demo/index']]){
    const header=source.split('---')[1].split('\n').filter(line=>!line.startsWith('import ')).join('\n').replace('import.meta.env.BASE_URL','configured');
    const route=Function('configured','Astro',header+';return {siteBase,dutyId};')(configured,{url:{pathname}});
    assert.deepEqual(route,{siteBase:prefix,dutyId:'07/demo'});
    const href=index.match(/href=\{([^}]+)\}/)![1];assert.equal(Function('siteBase','dutyId','return '+href)(route.siteBase,route.dutyId),prefix+'07/demo/p1');
   }
  }
 }
});

test('任务只生成一次源码；生成逻辑改变不影响冻结字节，历史下载不依赖报告',async()=>{
 const f=await fixture();try{
  let calls=0;f.service.generate=doc=>{calls++;return generateAstro(doc);};
  const task=await f.create(),dir=f.service.dir(task.id),plan=JSON.parse(await readFile(path.join(dir,'export-plan.json'),'utf8'));
  assert.equal(calls,1);f.service.generate=()=>{throw new Error('新规则不得重新生成已读取任务');};
  await f.service.detail(f.admin.actor,task.id);await f.service.detail(f.admin.actor,task.id);
  const approved=await f.service.review(f.admin.actor,task.id,{unitId:'p1',digest:task.digest,decision:'approved',comment:'',version:task.version,snapshotHash:task.snapshotHash});
  await f.service.conversion(f.admin.actor,task.id,{action:'export',version:approved.version,digest:task.digest,confirmPresentation:true});
  const bytes=await f.service.export(f.admin.actor,task.id),entries=archiveEntries(bytes);
  for(const file of plan.files)assert.equal(entries.get(file.name)?.toString(),file.content);
  const stored=f.service.task(f.admin.actor,task.id);stored.exportFormat='astro-previous';f.store.put('task',task.id,stored);
  const detail=await f.service.detail(f.admin.actor,task.id);assert.equal(detail.actions.download.allowed,true);
  await writeFile(path.join(dir,'report.json'),'null');
  await assert.rejects(f.service.detail(f.admin.actor,task.id),e=>e.status===409);
  assert.deepEqual(await f.service.export(f.admin.actor,task.id),bytes);
  f.state.denied=true;await assert.rejects(f.service.export(f.admin.actor,task.id),/无权访问/);f.state.denied=false;
  await writeFile(path.join(dir,'strategy-site.tar'),Buffer.from('被替换的产物'));
  await assert.rejects(f.service.export(f.admin.actor,task.id),e=>e.status===409&&/产物已变化/.test(e.message));
 }finally{f.store.close();}
});

test('导出计划缺失或篡改返回 409，预览和已存审核仍可读取',async()=>{
 const f=await fixture();try{
  const task=await f.create();
  const approved=await f.service.review(f.admin.actor,task.id,{unitId:'p1',digest:task.digest,decision:'approved',comment:'',version:task.version,snapshotHash:task.snapshotHash});
  await writeFile(path.join(f.service.dir(task.id),'export-plan.json'),'{}');
  assert.equal((await f.service.detail(f.admin.actor,task.id)).unitReviews.p1.review,'approved');
  await assert.rejects(f.service.conversion(f.admin.actor,task.id,{action:'export',version:approved.version,digest:task.digest,confirmPresentation:true}),e=>e.status===409&&/导出计划/.test(e.message));
  assert.notEqual(f.service.task(f.admin.actor,task.id).conversion,'completed');
  await assert.rejects(f.service.export(f.admin.actor,task.id),e=>e.status===409);
 }finally{f.store.close();}
});

test('导出诊断不进入审核摘要；H5 图片来源在预检与读取时使用同一规则',async()=>{
 const f=await fixture();try{
  const task=await f.create(),snapshot=JSON.parse(await readFile(path.join(f.service.dir(task.id),'snapshot.json'),'utf8'));
  // 使用同一固定快照隔离读取时间差，只改变导出诊断。
  const originalFactory=f.service.apiFactory;
  f.service.apiFactory=(actor,check)=>{
   const api=originalFactory(actor,check);api.read=async(_url,dir)=>{await writeFile(path.join(dir,'snapshot.json'),JSON.stringify(snapshot));return snapshot;};return api;
  };
  for(const source of ['assets/custom.avif','assets/'+ 'a'.repeat(24)+'.PNG','assets/custom.png']){
   assert.equal(isReviewAssetPath(source),false);
   f.service.generate=doc=>({...generateAstro(doc),assets:[{source,target:'public/review-assets/demo/custom.png'}]});
   const invalid=await f.create(),detail=await f.service.detail(f.admin.actor,invalid.id);
   assert.equal(invalid.reading,'ready');assert.equal(invalid.digest,task.digest);assert.equal(detail.result.blockers.length,1);assert.equal(detail.result.blockers[0].code,'ASTRO_EXPORT');
   await assert.rejects(f.service.assetFile(invalid,source),e=>e.status===400);
   assert.equal(detail.actions.approve.p1.allowed,false);assert.equal(detail.actions.export.allowed,false);
   await assert.rejects(f.service.review(f.admin.actor,invalid.id,{unitId:'p1',digest:invalid.digest,decision:'approved',comment:'',version:invalid.version,snapshotHash:invalid.snapshotHash}),e=>e.status===409&&/必须修正/.test(e.message));
   await assert.rejects(f.service.conversion(f.admin.actor,invalid.id,{action:'export',version:invalid.version,digest:invalid.digest,confirmPresentation:true}),e=>e.status===409&&/必须修正/.test(e.message));
  }
  f.service.generate=()=>{throw new Error('另一条预检文案');};const changed=await f.create();assert.equal(changed.digest,task.digest);
  assert.equal((await f.service.detail(f.admin.actor,changed.id)).result.blockers[0].reason,'另一条预检文案');
  assert.equal(isReviewAssetPath('assets/'+'a'.repeat(24)+'.png'),true);
 }finally{f.store.close();}
});

test('历史 astro-1 报告沿用旧摘要，保留预览、审核和已经完成的下载',async()=>{
 const f=await fixture();try{
  for(const blocked of [false,true]){
   const task=await f.create(),dir=f.service.dir(task.id),snapshot=JSON.parse(await readFile(path.join(dir,'snapshot.json'),'utf8'));
   const result=legacyResult(snapshot,task.options,true);if(blocked)result.blockers.push({code:'ASTRO_EXPORT',source:'doc',location:'攻略站导出',reason:'历史预检失败'});
   const digest=fingerprint({snapshotHash:task.snapshotHash,options:task.options,reader:READER_VERSION,converter:'review-2',exporter:'astro-1',result});
   delete task.storageVersion;delete task.reportHash;delete task.exportPlanHash;task.exportFormat='astro-1';task.digest=digest;
   f.store.put('task',task.id,task);await writeFile(path.join(dir,'report.json'),JSON.stringify({...result,digest,converter:'review-2'}));
   assert.equal((await f.service.detail(f.admin.actor,task.id)).digest,digest);
   const approved=await f.service.review(f.admin.actor,task.id,{unitId:'p1',digest,decision:'approved',comment:'',version:task.version,snapshotHash:task.snapshotHash});
   assert.equal(approved.actions.export.allowed,false);
   if(!blocked){
    const bytes=tar([{name:'pages/p1.astro',bytes:Buffer.from('历史页面')}]);await writeFile(path.join(dir,'strategy-site.tar'),bytes);
    const old=f.service.task(f.admin.actor,task.id);old.conversion='completed';old.artifactHash=hash(bytes);f.store.put('task',task.id,old);
    assert.deepEqual(await f.service.export(f.admin.actor,task.id),bytes);
   }
  }
 }finally{f.store.close();}
});


function legacyResult(snapshot:any,options:any,split:boolean){
 const converted=convert(snapshot,options,split);
 const result={document:converted.document,unsupported:[],warnings:converted.notices,blockers:converted.blockers,digest:''};
 result.digest=fingerprint({snapshot,options,unsupported:result.unsupported,document:result.document,warnings:result.warnings,blockers:result.blockers});return result;
}

test('裁剪图片保留原图并要求表现确认；旧丢弃字段不能代替确认',async()=>{
 const f=await fixture();try{
  f.state.blocks.find((b:any)=>b.block_type===27).image.crop={x:0.1,y:0.1,width:0.5,height:0.5};
  const task=await f.create(),detail=await f.service.detail(f.admin.actor,task.id);
  assert.deepEqual(detail.result.blockers,[]);assert.ok(detail.result.notices.some((i:any)=>i.source==='image'&&i.reason.includes('完整原图')));
  assert.ok(detail.actions.approve.p1.allowed);assert.ok(JSON.stringify(detail.result.document).includes('assets/'));
  const approved=await f.service.review(f.admin.actor,task.id,{unitId:'p1',digest:task.digest,decision:'approved',comment:'',version:task.version,snapshotHash:task.snapshotHash});
  await assert.rejects(f.service.conversion(f.admin.actor,task.id,{action:'export',version:approved.version,digest:task.digest,discard:true}),e=>e.status===409&&/表现待确认/.test(e.message));
  const done=await f.service.conversion(f.admin.actor,task.id,{action:'export',version:approved.version,digest:task.digest,confirmPresentation:true});
  assert.equal(done.presentationConfirmed,true);assert.equal(done.discard,undefined);
  const entries=archiveEntries(await f.service.export(f.admin.actor,task.id));assert.ok([...entries.keys()].some(name=>name.startsWith('public/review-assets/')));
 }finally{f.store.close();}
});

test('未来未知组件和字段统一阻断；没有表现差异的正文无需确认',async()=>{
 const f=await fixture();try{
  for(const type of [28,99999]){
   f.state.blocks=rawBlocks();f.state.blocks[0].children.push('unknown');f.state.blocks.push({block_id:'unknown',parent_id:'doc',block_type:type});
   const task=await f.create(),detail=await f.service.detail(f.admin.actor,task.id);assert.ok(detail.result.blockers.some((i:any)=>i.source==='unknown'));assert.equal(task.exportPlanHash,undefined);
  }
  f.state.blocks=rawBlocks();f.state.blocks.find((b:any)=>b.block_type===27).image.futureTransform=true;
  const invalid=await f.create();assert.ok((await f.service.detail(f.admin.actor,invalid.id)).result.blockers.some((i:any)=>i.source==='image'));
  f.state.blocks=rawBlocks();delete f.state.blocks[3].text.elements[0].text_run.text_element_style.text_color;
  const task=await f.create(),detail=await f.service.detail(f.admin.actor,task.id);assert.deepEqual(detail.result.notices,[]);
  const approved=await f.service.review(f.admin.actor,task.id,{unitId:'p1',digest:task.digest,decision:'approved',comment:'',version:task.version,snapshotHash:task.snapshotHash});
  assert.equal((await f.service.conversion(f.admin.actor,task.id,{action:'export',version:approved.version,digest:task.digest})).conversion,'completed');
 }finally{f.store.close();}
});

test('astro-2 冻结报告映射为两类问题，历史产物仍能下载',async()=>{
 const f=await fixture();try{
  const task=await f.create(),dir=f.service.dir(task.id),snapshot=JSON.parse(await readFile(path.join(dir,'snapshot.json'),'utf8')),result=legacyResult(snapshot,task.options,true);
  const digest=fingerprint({snapshotHash:task.snapshotHash,options:task.options,reader:READER_VERSION,converter:'review-2',document:result.document,unsupported:result.unsupported});
  const report=Buffer.from(JSON.stringify({...result,contentDigest:result.digest,digest,reader:READER_VERSION,converter:'review-2',exportBlockers:[]}));
  Object.assign(task,{storageVersion:2,exportFormat:'astro-2',digest,reportHash:hash(report)});f.store.put('task',task.id,task);await writeFile(path.join(dir,'report.json'),report);
  const detail=await f.service.detail(f.admin.actor,task.id);assert.equal(detail.result.notices.length,result.warnings.length);assert.equal('warnings' in detail.result,false);assert.equal('unsupported' in detail.result,false);
  const approved=await f.service.review(f.admin.actor,task.id,{unitId:'p1',digest,decision:'approved',comment:'',version:task.version,snapshotHash:task.snapshotHash});assert.equal(approved.actions.export.allowed,false);
  const bytes=tar([{name:'pages/p1.astro',bytes:Buffer.from('旧页面')}]);await writeFile(path.join(dir,'strategy-site.tar'),bytes);
  const stored=f.service.task(f.admin.actor,task.id);Object.assign(stored,{conversion:'completed',artifactHash:hash(bytes)});f.store.put('task',task.id,stored);
  assert.deepEqual(await f.service.export(f.admin.actor,task.id),bytes);
 }finally{f.store.close();}
});

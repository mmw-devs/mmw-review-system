import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { fixture } from './review-fixture.ts';
import { createReviewServer } from '../src/review-server.ts';

const browser = process.env.REVIEW_BROWSER;
if (!browser) throw new Error('请通过 REVIEW_BROWSER 指定已安装浏览器；此测试不安装浏览器');
const f = await fixture(); const {server} = createReviewServer(f.auth, f.service);
await new Promise<void>(r => server.listen(0,'127.0.0.1',r)); const address=server.address() as any;f.config.origin='http://127.0.0.1:'+address.port;
const profile=await mkdtemp(path.join(os.tmpdir(),'mmw-browser-'));
const proc=spawn(browser,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:'ignore'});
let ws:WebSocket|undefined;let callId=0;const pending=new Map<number,{resolve:Function,reject:Function}>();const errors:string[]=[];
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
try{
 let port='';for(let i=0;i<50;i++){try{port=(await(await import('node:fs/promises')).readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];if(port)break;}catch{}await sleep(200);}
 if(!port)throw new Error('浏览器调试端口未就绪');
 const targets:any=await(await fetch('http://127.0.0.1:'+port+'/json')).json();const target=targets.find((t:any)=>t.type==='page');
 ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise<void>((r,j)=>{ws!.onopen=()=>r();ws!.onerror=()=>j(new Error('无法连接浏览器'));});
 ws.onmessage=e=>{const m=JSON.parse(String(e.data));if(m.id){const p=pending.get(m.id);pending.delete(m.id);if(m.error)p?.reject(new Error(m.error.message));else p?.resolve(m.result);}if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);};
 const call=(method:string,params:any={})=>new Promise<any>((resolve,reject)=>{const id=++callId;pending.set(id,{resolve,reject});ws!.send(JSON.stringify({id,method,params}));});
 const evaluate=async(expression:string)=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error('页面执行异常');return r.result.value;};
 const waitFor=async(expression:string)=>{for(let i=0;i<80;i++){if(await evaluate(expression))return;await sleep(100);}throw new Error('页面条件未达到：'+expression);};
 await call('Runtime.enable');await call('Page.enable');await call('Emulation.setDeviceMetricsOverride',{width:1280,height:1000,deviceScaleFactor:1,mobile:false});
 await call('Page.navigate',{url:f.config.origin});await waitFor("document.querySelector('#welcome a') !== null");assert.ok(await evaluate("!document.getElementById('welcome').hidden"));
 await call('Network.setCookie',{name:'mmw_session',value:f.admin.session,url:f.config.origin,httpOnly:true,sameSite:'Lax'});await call('Page.navigate',{url:f.config.origin});await waitFor("document.getElementById('workspace') && !document.getElementById('workspace').hidden");
 await evaluate("document.querySelector('[name=url]').value='https://example.feishu.cn/wiki/wikiNode';document.querySelector('[name=dutyId]').value='demo';document.querySelector('[name=dutyName]').value='测试副本';document.querySelector('[name=profile]').value='standard';document.getElementById('create').requestSubmit();");
 await waitFor("document.getElementById('tasks').querySelectorAll('button').length===1");await waitFor("document.getElementById('task').innerText.includes('读取')");
 await evaluate("Array.from(document.querySelectorAll('#task button')).find(x=>x.textContent==='刷新任务').click()");await waitFor("document.querySelector('#task .preview') !== null");await waitFor("Array.from(document.querySelectorAll('.preview img')).every(x=>x.complete && x.naturalWidth>0)");
 assert.ok(await evaluate("document.querySelector('.preview').innerText.includes('分摊后分散')"));
 await evaluate("Array.from(document.querySelectorAll('#task button')).find(x=>x.textContent==='审核通过').click()");await waitFor("document.querySelector('.confirm input') !== null");
 await evaluate("Array.from(document.querySelectorAll('#task button')).find(x=>x.textContent==='转换并保存 JSON').click()");await waitFor("document.getElementById('notice').textContent.includes('明确确认')");
 await evaluate("document.querySelector('.confirm input').checked=true;Array.from(document.querySelectorAll('#task button')).find(x=>x.textContent==='转换并保存 JSON').click()");await waitFor("document.querySelector('#task a[href$=export]') !== null");
 const download=await evaluate("fetch(document.querySelector('#task a[href$=export]').href).then(async r=>({status:r.status,type:r.headers.get('content-type'),bytes:(await r.arrayBuffer()).byteLength}))");assert.equal(download.status,200);assert.equal(download.type,'application/x-tar');assert.ok(download.bytes>1024);
 const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');await mkdir(path.join(repo,'data','ui-check'),{recursive:true});
 const shot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(path.join(repo,'data','ui-check','review-desktop.png'),Buffer.from(shot.data,'base64'));
 await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await sleep(200);assert.ok(await evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'));
 const mobile=await call('Page.captureScreenshot',{format:'png'});await writeFile(path.join(repo,'data','ui-check','review-mobile.png'),Buffer.from(mobile.data,'base64'));
 assert.deepEqual(errors,[]);console.log('浏览器验收通过：登录页、任务提交、图片正文、审核、排除确认、导出入口、移动端布局；使用模拟飞书服务');
}finally{ws?.close();proc.kill();await new Promise<void>(r=>server.close(()=>r()));f.store.close();}

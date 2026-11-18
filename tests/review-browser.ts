import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { fixture } from './review-fixture.ts';
import { AppError } from '../src/review-auth.ts';
import { createReviewServer } from '../src/review-server.ts';

const browser = process.env.REVIEW_BROWSER;
if (!browser) throw new Error('请通过 REVIEW_BROWSER 指定已安装浏览器；此测试不安装浏览器');
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const screenshotDir=path.join(repo,'data','ui-check');
const f = await fixture();
f.state.blocks[0].children.push('half','halfBody','p2','p2Body');
for(const [id,title] of [['half','P1.5'],['p2','P2']]) f.state.blocks.push({block_id:id,parent_id:'doc',block_type:3,heading1:{elements:[{text_run:{content:title}}]}},{block_id:id+'Body',parent_id:'doc',block_type:2,text:{elements:[{text_run:{content:title+' 独立正文'}}]}});
let detailRequests=0,imageRequests=0,failImages=true;
const originalDetail=f.service.detail.bind(f.service),originalImage=f.service.image.bind(f.service);
f.service.detail=async(...args:Parameters<typeof originalDetail>)=>{detailRequests++;await new Promise(r=>setTimeout(r,250));return originalDetail(...args);};
f.service.image=async(...args:Parameters<typeof originalImage>)=>{imageRequests++;if(failImages)throw new AppError(503,'图片暂时不可用');return originalImage(...args);};
const {server} = createReviewServer(f.auth, f.service);
let proc:ReturnType<typeof spawn>|undefined,closed:Promise<void>|undefined,browserClosed=false,cleaningUp=false;
let browserError:Error|undefined,ws:WebSocket|undefined,callId=0;
const pending=new Map<number,{resolve:(value:any)=>void,reject:(error:Error)=>void,timer:ReturnType<typeof setTimeout>}>();
const errors:string[]=[];
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
// 每次调试调用都限时；连接关闭时统一拒绝未完成请求，避免失败后一直等待。
const finishCall=(id:number,error?:Error,value?:any)=>{
 const request=pending.get(id);if(!request)return;
 pending.delete(id);clearTimeout(request.timer);if(error)request.reject(error);else request.resolve(value);
};
const rejectPending=(error:Error)=>{for(const id of pending.keys())finishCall(id,error);};
const call=(method:string,params:any={})=>new Promise<any>((resolve,reject)=>{
 if(browserError){reject(browserError);return;}
 if(ws?.readyState!==WebSocket.OPEN){reject(new Error('浏览器调试连接不可用'));return;}
 const id=++callId,timer=setTimeout(()=>finishCall(id,new Error('浏览器调试调用超时：'+method)),5000);
 pending.set(id,{resolve,reject,timer});
 try{ws.send(JSON.stringify({id,method,params}));}catch{finishCall(id,new Error('无法发送浏览器调试调用：'+method));}
});
const waitForBrowserClose=(ms:number)=>new Promise<boolean>(resolve=>{
 const timer=setTimeout(()=>resolve(false),ms);closed!.then(()=>{clearTimeout(timer);resolve(true);});
});
try{
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
 const address=server.address() as any;f.config.origin='http://127.0.0.1:'+address.port;
 const profile=await mkdtemp(path.join(os.tmpdir(),'mmw-browser-'));
 proc=spawn(browser,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:'ignore'});
 closed=new Promise<void>(resolve=>proc!.once('close',()=>{browserClosed=true;resolve();}));
 proc.on('error',()=>{browserError=new Error('浏览器无法启动，请检查 REVIEW_BROWSER 指定的可执行文件');rejectPending(browserError);});
 proc.on('exit',()=>{if(!cleaningUp){browserError=new Error('浏览器进程意外退出');rejectPending(browserError);}});
 let port='';for(let i=0;i<50;i++){if(browserError)throw browserError;try{port=(await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];if(port)break;}catch{}await sleep(200);}
 if(!port)throw new Error('浏览器调试端口未就绪');
 const response=await fetch('http://127.0.0.1:'+port+'/json',{signal:AbortSignal.timeout(5000)});
 if(!response.ok)throw new Error('无法读取浏览器调试页面');
 const targets:any=await response.json(),target=Array.isArray(targets)&&targets.find((t:any)=>t.type==='page');
 if(!target?.webSocketDebuggerUrl)throw new Error('浏览器没有可用的调试页面');
 ws=new WebSocket(target.webSocketDebuggerUrl);
 ws.onclose=()=>rejectPending(new Error('浏览器调试连接已关闭'));
 ws.onerror=()=>rejectPending(new Error('浏览器调试连接发生错误'));
 ws.onmessage=e=>{
  try{
   const m=JSON.parse(String(e.data));if(m.id)finishCall(m.id,m.error?new Error('浏览器调试调用失败'):undefined,m.result);
   if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);
  }catch{rejectPending(new Error('浏览器调试响应格式无效'));ws?.close();}
 };
 await new Promise<void>((resolve,reject)=>{
  const socket=ws!,finish=(error?:Error)=>{clearTimeout(timer);socket.removeEventListener('open',onOpen);socket.removeEventListener('error',onError);socket.removeEventListener('close',onClose);if(error)reject(error);else resolve();};
  const onOpen=()=>finish(),onError=()=>finish(new Error('无法连接浏览器')),onClose=()=>finish(new Error('浏览器在建立调试连接时关闭'));
  const timer=setTimeout(()=>finish(new Error('连接浏览器超时')),5000);
  socket.addEventListener('open',onOpen);socket.addEventListener('error',onError);socket.addEventListener('close',onClose);
 });
 const evaluate=async(expression:string)=>{const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error('页面执行异常');return r.result.value;};
 const waitFor=async(expression:string)=>{for(let i=0;i<80;i++){if(await evaluate(expression))return;await sleep(100);}throw new Error('页面条件未达到：'+expression);};
 await call('Runtime.enable');await call('Page.enable');await call('Emulation.setDeviceMetricsOverride',{width:1280,height:1000,deviceScaleFactor:1,mobile:false});
 await call('Page.navigate',{url:f.config.origin});await waitFor("document.querySelector('#welcome a') !== null");assert.ok(await evaluate("!document.getElementById('welcome').hidden"));
 await call('Network.setCookie',{name:'mmw_session',value:f.admin.session,url:f.config.origin,httpOnly:true,sameSite:'Lax'});await call('Page.navigate',{url:f.config.origin});await waitFor("document.getElementById('workspace') && !document.getElementById('workspace').hidden");
 await evaluate("document.querySelector('[name=url]').value='https://example.feishu.cn/wiki/wikiNode';document.querySelector('[name=dutyId]').value='demo';document.querySelector('[name=dutyName]').value='测试副本';document.querySelector('[name=profile]').value='standard';document.getElementById('create').requestSubmit();");
 await waitFor("document.getElementById('tasks').querySelectorAll('button').length===1");await waitFor("document.getElementById('task').innerText.includes('读取')");
 await waitFor("Array.from(document.querySelectorAll('#task button')).some(x=>x.textContent==='刷新任务')");
 await Promise.all([...f.service.jobs.values()]);
 await evaluate("Array.from(document.querySelectorAll('#task button')).find(x=>x.textContent==='刷新任务').click()");await waitFor("document.querySelector('#task .preview') !== null");assert.ok(await evaluate("document.querySelector('.preview').innerText.includes('副本基本信息')"));
 await evaluate("Array.from(document.querySelectorAll('.phase-nav button')).find(x=>x.textContent.startsWith('P1阶段')).click()");
 await waitFor("document.querySelector('figure[data-failed] button') !== null");
 assert.equal(imageRequests,6); // 三次图片加载及对应诊断请求，随后停止自动重试。
 assert.ok(await evaluate("!Array.from(document.querySelectorAll('#task button')).find(x=>x.textContent==='审核通过').disabled"));
 const beforeRetry=detailRequests;failImages=false;
 await evaluate("document.querySelector('figure[data-failed] button').click()");
 await waitFor("document.querySelector('.preview img')?.naturalWidth>0");assert.equal(detailRequests,beforeRetry);
 const cachedRequests=detailRequests,cachedImageRequests=imageRequests;
 await evaluate("document.querySelector('#task textarea').value='保留的草稿';document.querySelector('#task textarea').dispatchEvent(new Event('input'))");
 assert.ok(await evaluate("document.querySelector('.preview').innerText.includes('分摊后分散')"));
 assert.ok(!(await evaluate("document.querySelector('.preview').innerText.includes('P1.5 独立正文')")));
 await evaluate("Array.from(document.querySelectorAll('.phase-nav button')).find(x=>x.textContent.startsWith('P1.5')).click()");await waitFor("document.querySelector('.preview')?.innerText.includes('P1.5 独立正文')");
 assert.ok(!(await evaluate("document.querySelector('.preview').innerText.includes('分摊后分散')")));
 await evaluate("Array.from(document.querySelectorAll('.phase-nav button')).find(x=>x.textContent.startsWith('P1阶段')).click()");await waitFor("document.querySelector('.preview img')?.naturalWidth>0");
 assert.equal(await evaluate("document.querySelector('#task textarea').value"),'保留的草稿');assert.equal(detailRequests,cachedRequests);assert.equal(imageRequests,cachedImageRequests);
 await evaluate("Array.from(document.querySelectorAll('.phase-nav button')).find(x=>x.textContent.startsWith('P1.5')).click()");
 await call('Page.reload');await waitFor("document.querySelector('.loading') !== null");await waitFor("document.querySelector('.preview')?.innerText.includes('P1.5 独立正文')");
 await evaluate('history.back()');await waitFor("document.querySelector('.preview')?.innerText.includes('分摊后分散')");
 await evaluate('history.forward()');await waitFor("document.querySelector('.preview')?.innerText.includes('P1.5 独立正文')");
 const beforeReview=detailRequests;
 await evaluate("Array.from(document.querySelectorAll('#task button')).find(x=>x.textContent==='审核通过').click()");
 await waitFor("document.querySelector('.phase-nav [aria-current=page]')?.textContent.includes('已通过')");assert.equal(detailRequests,beforeReview);
 assert.ok(await evaluate("document.querySelector('.phase-nav').innerText.includes('副本基本信息 · 待审核')"));
 assert.ok(await evaluate("document.querySelector('.actions').innerText.includes('完整导出包含未通过部分')"));
 await waitFor("document.querySelector('.confirm input') !== null");
 await evaluate("Array.from(document.querySelectorAll('#task button')).find(x=>x.textContent==='转换并保存 JSON').click()");await waitFor("document.getElementById('notice').textContent.includes('明确确认')");
 await evaluate("document.querySelector('.confirm input').checked=true;Array.from(document.querySelectorAll('#task button')).find(x=>x.textContent==='转换并保存 JSON').click()");await waitFor("document.querySelector('#task a[href$=export]') !== null");
 const download=await evaluate("fetch(document.querySelector('#task a[href$=export]').href).then(async r=>({status:r.status,type:r.headers.get('content-type'),bytes:(await r.arrayBuffer()).byteLength}))");assert.equal(download.status,200);assert.equal(download.type,'application/x-tar');assert.ok(download.bytes>1024);
 await evaluate("Array.from(document.querySelectorAll('.phase-nav button')).find(x=>x.textContent.startsWith('P1阶段')).click()");await waitFor("document.querySelector('.preview img')?.complete");
 await mkdir(screenshotDir,{recursive:true});
 const shot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(path.join(repo,'data','ui-check','review-desktop.png'),Buffer.from(shot.data,'base64'));
 await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await sleep(200);assert.ok(await evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'));
 await evaluate("Array.from(document.querySelectorAll('.phase-nav button')).find(x=>x.textContent.startsWith('P1.5')).click()");await waitFor("document.querySelector('.preview')?.innerText.includes('P1.5 独立正文')");
 await evaluate("document.getElementById('task').scrollIntoView()");await sleep(200);assert.ok(await evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'));
 const mobile=await call('Page.captureScreenshot',{format:'png'});await writeFile(path.join(repo,'data','ui-check','review-mobile.png'),Buffer.from(mobile.data,'base64'));
 const beforeRefresh=detailRequests;
 await evaluate("Array.from(document.querySelectorAll('#task button')).find(x=>x.textContent==='刷新任务').click()");
 await waitFor("document.querySelector('.loading') !== null");assert.ok(await evaluate("document.querySelector('.preview') !== null"));await waitFor("document.querySelector('.loading') === null");assert.equal(detailRequests,beforeRefresh+1);
 // 新版本取消转换后，服务端禁止剩余页面审核，页面同步收起动作并说明原因。
 const previousTask=await evaluate("new URL(location.href).searchParams.get('task')");
 await evaluate("Array.from(document.querySelectorAll('#task button')).find(x=>x.textContent==='重新获取为新版本').click()");
 await waitFor("new URL(location.href).searchParams.get('task')!=="+JSON.stringify(previousTask)+" && Array.from(document.querySelectorAll('#task button')).some(x=>x.textContent==='刷新任务')");await Promise.all([...f.service.jobs.values()]);
 await evaluate("Array.from(document.querySelectorAll('#task button')).find(x=>x.textContent==='刷新任务').click()");await waitFor("document.querySelector('.phase-nav') !== null");
 await evaluate("Array.from(document.querySelectorAll('.phase-nav button')).find(x=>x.textContent.startsWith('P1阶段')).click()");
 await evaluate("Array.from(document.querySelectorAll('#task button')).find(x=>x.textContent==='审核通过').click()");
 await waitFor("Array.from(document.querySelectorAll('#task button')).some(x=>x.textContent==='放弃本次转换')");
 await evaluate("Array.from(document.querySelectorAll('#task button')).find(x=>x.textContent==='放弃本次转换').click()");await waitFor("document.querySelector('.actions')?.innerText.includes('取消')");
 await evaluate("Array.from(document.querySelectorAll('.phase-nav button')).find(x=>x.textContent.startsWith('副本基本信息')).click()");
 assert.ok(await evaluate("document.querySelector('.phase-nav [aria-current=page]').textContent.includes('待审核')"));
 assert.ok(await evaluate("document.querySelector('.actions textarea').disabled"));
 assert.ok(await evaluate("!Array.from(document.querySelectorAll('.actions button')).some(x=>['审核通过','驳回','转换并保存 JSON','放弃本次转换'].includes(x.textContent))"));
 assert.ok(await evaluate("document.querySelector('.actions').innerText.includes('取消')"));
 f.state.denied=true;
 await evaluate("Array.from(document.querySelectorAll('#task button')).find(x=>x.textContent==='刷新任务').click()");await waitFor("document.querySelector('.preview') === null && document.getElementById('notice').innerText.includes('无权访问')");
 assert.deepEqual(errors,[]);console.log('浏览器验收通过：登录页、任务提交、分 P 缓存命中、草稿保留、加载动画、刷新定位、前进后退、图片失败与重试、单 P 审核导出、取消后动作同步、权限失效清理、排除确认、导出入口、移动端布局；使用模拟飞书服务');
}catch(error){
 // 只截取本测试的模拟页面；截图失败不能掩盖原来的断言或连接错误。
 if(ws?.readyState===WebSocket.OPEN){
  try{const shot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await mkdir(screenshotDir,{recursive:true});await writeFile(path.join(screenshotDir,'review-failure.png'),Buffer.from(shot.data,'base64'));}
  catch{console.error('未能保存失败现场截图，保留原始测试错误');}
 }
 throw error;
}finally{
 cleaningUp=true;rejectPending(new Error('浏览器测试已结束'));ws?.close();
 if(proc&&closed&&!browserClosed){
  proc.kill();if(!await waitForBrowserClose(2000)){proc.kill('SIGKILL');if(!await waitForBrowserClose(2000)){proc.unref();process.exitCode=1;console.error('浏览器进程未能在清理期限内退出');}}
 }
 await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});
 await Promise.allSettled([...f.service.jobs.values()]);f.store.close();
}

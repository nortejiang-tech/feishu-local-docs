import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {makeDemo} from '../extension/demo.mjs';import {decodeDocument} from '../shared/model.mjs';
let workerNumber=0;
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};}
async function fixture({gate,oldHost=false,loseReply=false,omitHtmlReceipt=false}={}){
 let listener,storage={},source='https://sample.feishu.cn/docx/synthetic',reads=0,saves=0;const receipts=new Map();
 const chrome={runtime:{id:'synthetic-extension',getURL:p=>'chrome-extension://synthetic-extension/'+p,onMessage:{addListener:f=>listener=f}},tabs:{get:async()=>({url:source})},storage:{local:{get:async()=>structuredClone(storage),set:async o=>{storage=structuredClone(o)}}},action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{}},scripting:{executeScript:async()=>{reads++;if(gate)await gate.promise;return [{frameId:0,result:{ok:true,snapshot:makeDemo('document')}}]}}};
 chrome.runtime.sendNativeMessage=async(_host,message)=>{
  if(message.operation==='hello')return oldHost?{ok:false,code:'LOCAL_DELIVERY_FAILED'}:{ok:true,protocolVersion:1,capabilities:['save-task','query-task','html-output']};
  if(message.operation==='query-task')return receipts.get(message.jobId)||{ok:true,protocolVersion:1,jobId:message.jobId,status:'NOT_FOUND'};
  assert.equal(message.operation,'save-task');assert.equal(message.protocolVersion,1);const doc=await decodeDocument(message.text);assert.equal(doc.kind,'document');saves++;
  const r={ok:true,protocolVersion:1,status:'SAVED',jobId:message.jobId,requestId:message.jobId,sha256:message.sha256,partial:true};if(message.html&&!omitHtmlReceipt){assert.match(message.html,/<!doctype html>/);r.htmlSaved=true;r.htmlSha256=createHash('sha256').update(message.html).digest('hex');}receipts.set(message.jobId,r);
  if(loseReply)throw Error('Native host has exited.');return r;
 };
 async function restart(){globalThis.chrome=chrome;await import(`../extension-next/src/background.mjs?worker=${++workerNumber}`);}
 await restart();
 return {restart,setSource(v){source=v},get reads(){return reads},get saves(){return saves},get storage(){return storage},message(operation,extra={}){return new Promise((resolve,reject)=>{const accepted=listener({operation,tabId:1,...extra},{id:chrome.runtime.id,url:chrome.runtime.getURL('popup.html')},resolve);if(!accepted)reject(Error('message rejected'));});},raw(message,sender){return listener(message,sender,()=>{throw Error('must not respond')});}};
}
async function until(fn,predicate){for(let i=0;i<150;i++){const r=await fn();if(predicate(r))return r;await new Promise(r=>setImmediate(r));}assert.fail('extension did not settle');}
test('managed popup starts once, polls and reopens same confirmed job',async()=>{
 const f=await fixture();const initial=await f.message('task-current');assert.equal(initial.task,null);
 const first=await f.message('task-start');assert.ok(first.task.jobId);
 const saved=await until(()=>f.message('task-current'),r=>r.task?.state==='saved');assert.equal(saved.task.partial,true);assert.equal(f.saves,1);
 assert.equal((await f.message('task-start')).task.jobId,first.task.jobId);assert.equal(f.reads,1);
 await f.message('task-start',{newCopy:true});await until(()=>f.message('task-current'),r=>r.task?.state==='saved');assert.equal(f.saves,2);
 const persisted=JSON.stringify(f.storage);for(const v of ['https:','synthetic','local-feishu','document','title'])assert.ok(!persisted.includes(v));
});
test('old native host is rejected before reading, with compatible upgrade message',async()=>{
 const f=await fixture({oldHost:true});await f.message('task-start');const failed=await until(()=>f.message('task-current'),r=>r.task?.state==='failed');assert.equal(failed.task.code,'PROTOCOL_UPGRADE');assert.equal(f.reads,0);assert.equal(f.saves,0);
});
test('cancel during page execution prevents native delivery after page returns',async()=>{
 const gate=deferred(),f=await fixture({gate});const first=await f.message('task-start');await until(async()=>f.reads,x=>x===1);
 assert.equal((await f.message('task-cancel',{jobId:first.task.jobId})).task.state,'cancelled');gate.resolve();await new Promise(r=>setImmediate(r));assert.equal(f.saves,0);
});
test('capture completion after navigation never submits the old source',async()=>{
 const gate=deferred(),f=await fixture({gate});await f.message('task-start');await until(async()=>f.reads,x=>x===1);f.setSource('https://sample.feishu.cn/docx/other');gate.resolve();
 await new Promise(r=>setImmediate(r));f.setSource('https://sample.feishu.cn/docx/synthetic');const failed=await until(()=>f.message('task-current'),r=>r.task?.state==='failed');assert.equal(failed.task.code,'SOURCE_CHANGED');assert.equal(f.saves,0);
});
test('native response lost after commit is recovered by query without another save',async()=>{
 const f=await fixture({loseReply:true});const first=await f.message('task-start');const saved=await until(()=>f.message('task-current'),r=>r.task?.state==='saved');assert.equal(saved.task.jobId,first.task.jobId);assert.equal(f.saves,1);
 await f.restart();assert.equal((await f.message('task-current')).task.state,'saved');assert.equal(f.saves,1);
});
test('worker restart identifies abandoned capture without starting a new save',async()=>{
 const gate=deferred(),f=await fixture({gate});const first=await f.message('task-start');await until(async()=>f.reads,x=>x===1);
 await f.restart();const read=await f.message('task-current');assert.equal(read.task.jobId,first.task.jobId);assert.equal(read.task.state,'interrupted');assert.equal(f.reads,1);assert.equal(f.saves,0);
 // This unresolved promise represents the terminated worker; do not resume it.
});
test('task controls reject unrelated senders and malformed cancel requests',async()=>{
 const f=await fixture();assert.equal(f.raw({operation:'task-start',tabId:1},{id:'other',url:'https://example.org'}),false);
 assert.equal(f.raw({operation:'task-cancel',tabId:1,jobId:'../escape'},{id:'synthetic-extension',url:'chrome-extension://synthetic-extension/popup.html'}),false);
});

test('paired HTML delivery is confirmed by its own hash and survives a lost response',async()=>{
 const f=await fixture({loseReply:true});await f.message('task-start',{format:'both'});
 const saved=await until(()=>f.message('task-current'),r=>r.task?.state==='saved');assert.equal(saved.task.format,'both');assert.equal(f.saves,1);
 await f.restart();assert.equal((await f.message('task-current')).task.state,'saved');
});
test('a document-only receipt never confirms requested HTML output',async()=>{
 const f=await fixture({omitHtmlReceipt:true});await f.message('task-start',{format:'both'});
 const pending=await until(()=>f.message('task-current'),r=>r.task?.state==='interrupted');assert.equal(pending.task.code,'NATIVE_OUTPUT_PENDING');assert.equal(f.saves,1);
 await f.restart();assert.equal((await f.message('task-current')).task.state,'interrupted');assert.equal(f.saves,1);
});

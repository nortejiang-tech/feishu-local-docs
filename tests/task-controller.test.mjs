import test from 'node:test';
import assert from 'node:assert/strict';
import {createTaskController} from '../extension-next/src/tasks.mjs';
const key='localdocs.tasks.v1',hash='a'.repeat(64),payloadHash='b'.repeat(64);
function defer(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject};}
function harness(overrides={}){
 let data={},counter=0,calls=0,sourceKey=hash;
 const storage={get:async()=>structuredClone(data),set:async value=>{data=structuredClone(value)}};
 const deps={storage,source:async()=>({sourceKey,expectedSource:'https://sample.feishu.cn/docx/synthetic'}),uuid:()=>`00000000-0000-4000-8000-${String(++counter).padStart(12,'0')}`,run:async()=>{calls++;return {ok:true,partial:true}},query:async jobId=>({ok:true,protocolVersion:1,jobId,status:'NOT_FOUND'}),...overrides};
 return {deps,controller:createTaskController(deps),get data(){return data},get calls(){return calls},setSource(v){sourceKey=v},seed(v){data={[key]:structuredClone(v)}}};
}
async function until(fn,predicate){for(let i=0;i<100;i++){const value=await fn();if(predicate(value))return value;await new Promise(r=>setImmediate(r));}assert.fail('state did not settle');}
const finished=t=>['saved','failed','cancelled','interrupted'].includes(t?.state);
test('concurrent popup requests create one job and reopening only reads saved result',async()=>{
 const gate=defer();let runs=0;const h=harness({run:async()=>{runs++;await gate.promise;return {ok:true,partial:true}}});
 const results=await Promise.all(Array.from({length:8},()=>h.controller.start(1)));
 assert.equal(new Set(results.map(t=>t.jobId)).size,1);await until(async()=>runs,x=>x===1);assert.equal(runs,1);
 assert.equal((await h.controller.current(1)).state,'capturing');gate.resolve();
 const saved=await until(()=>h.controller.current(1),t=>t?.state==='saved');assert.equal(saved.partial,true);
 assert.equal((await h.controller.start(1)).jobId,saved.jobId);assert.equal(runs,1);
 const copy=await h.controller.start(1,{newCopy:true});assert.notEqual(copy.jobId,saved.jobId);
 await until(()=>h.controller.current(1),t=>t?.state==='saved');assert.equal(runs,2);
});
test('same source in two tabs is one active job, newer active beats older saved',async()=>{
 const gate=defer();let count=0;const h=harness({run:async()=>{if(++count===2)await gate.promise;return {ok:true}}});
 await h.controller.start(1);await until(()=>h.controller.current(1),t=>t?.state==='saved');
 const second=await h.controller.start(2,{newCopy:true});const other=await h.controller.start(3);
 assert.equal(second.jobId,other.jobId);assert.equal(other.state,'capturing');gate.resolve();
 await until(()=>h.controller.current(1),t=>t?.state==='saved');
});
test('cooperative cancellation discards in-flight capture before delivery',async()=>{
 const gate=defer();let delivered=0;const h=harness({run:async(_id,{checkpoint})=>{await gate.promise;await checkpoint('CONVERSION');delivered++;return {ok:true}}});
 const first=await h.controller.start(1);assert.equal((await h.controller.cancel(1,first.jobId)).state,'cancelled');
 assert.equal((await h.controller.current(1)).stopping,true);gate.resolve();await until(()=>h.controller.current(1),t=>t?.stopping===false);assert.equal(delivered,0);assert.equal((await h.controller.current(1)).state,'cancelled');
});
test('commit stage cannot claim cancellation',async()=>{
 const gate=defer();const h=harness({run:async(_id,{checkpoint})=>{await checkpoint('NATIVE',{partial:true,payloadHash});await gate.promise;return {ok:true,partial:true}}});
 const first=await h.controller.start(1);await until(()=>h.controller.current(1),t=>t?.state==='saving');
 assert.equal((await h.controller.cancel(1,first.jobId)).state,'saving');gate.resolve();
 assert.equal((await until(()=>h.controller.current(1),t=>t?.state==='saved')).partial,true);
});
test('worker restart marks abandoned capture interrupted without rerunning capture',async()=>{
 const gate=defer();const h=harness({run:async()=>gate.promise});await h.controller.start(1);
 await until(async()=>h.data[key]?.[0]?.stage,x=>x==='CAPTURE');const fresh=createTaskController(h.deps);const record=await fresh.current(1);assert.equal(record.state,'interrupted');assert.equal(record.code,'WORKER_INTERRUPTED');
});
test('native commit survives lost response and worker restart by querying same job',async()=>{
 const gate=defer();let queried=0;const h=harness({run:async(_id,{checkpoint})=>{await checkpoint('NATIVE',{partial:true,payloadHash});return gate.promise},query:async jobId=>{queried++;return {ok:true,protocolVersion:1,jobId,status:'SAVED',partial:true,sha256:payloadHash}}});
 const first=await h.controller.start(1);await until(()=>h.controller.current(1),t=>t?.state==='saving');
 const fresh=createTaskController(h.deps);const found=await fresh.current(1);assert.equal(found.jobId,first.jobId);assert.equal(found.state,'saved');assert.equal(found.partial,true);assert.equal(queried,1);
});
test('unconfirmed native result blocks new-copy and retry until authoritative query',async()=>{
 let queried=0;const h=harness({run:async(_id,{checkpoint})=>{await checkpoint('NATIVE',{payloadHash});return {ok:false,stage:'NATIVE',code:'NATIVE_CONNECTION_FAILED'}},query:async()=>{queried++;throw Error('private-token')}});
 const first=await h.controller.start(1);await until(()=>h.controller.current(1),t=>t?.state==='interrupted');
 assert.equal((await h.controller.start(1,{newCopy:true})).jobId,first.jobId);
 assert.equal((await h.controller.start(1,{retry:true})).jobId,first.jobId);assert.ok(queried>=1);assert.ok(!JSON.stringify(h.data).includes('private-token'));
});
test('NOT_FOUND allows explicit retry with original jobId',async()=>{
 let attempts=0;const h=harness({run:async(_id,{checkpoint})=>{await checkpoint('NATIVE',{payloadHash});return ++attempts===1?{ok:false,stage:'NATIVE',code:'NATIVE_CONNECTION_FAILED'}:{ok:true}}});
 const first=await h.controller.start(1);await until(()=>h.controller.current(1),t=>t?.state==='failed');
 assert.equal((await h.controller.start(1,{retry:true})).jobId,first.jobId);await until(()=>h.controller.current(1),t=>t?.state==='saved');assert.equal(attempts,2);
});
test('wrong native job/protocol/hash is never accepted as saved',async()=>{
 for(const bad of [{jobId:'different'},{protocolVersion:2},{sha256:'c'.repeat(64)}]){
  const h=harness({run:async(_id,{checkpoint})=>{await checkpoint('NATIVE',{payloadHash});return {ok:false,stage:'NATIVE',code:'NATIVE_CONNECTION_FAILED'}},query:async jobId=>({ok:true,protocolVersion:1,jobId,status:'SAVED',sha256:payloadHash,...bad})});
  await h.controller.start(1);const r=await until(()=>h.controller.current(1),t=>t?.state==='interrupted');assert.notEqual(r.state,'saved');
 }
});
test('source navigation after capture prevents native submission',async()=>{
 const gate=defer();let delivered=0;const h=harness({run:async(_id,{checkpoint})=>{await gate.promise;await checkpoint('NATIVE');delivered++;return {ok:true}}});
 await h.controller.start(1);h.setSource('c'.repeat(64));gate.resolve();await new Promise(r=>setImmediate(r));h.setSource(hash);
 const r=await until(()=>h.controller.current(1),finished);assert.equal(r.state,'failed');assert.equal(r.code,'SOURCE_CHANGED');assert.equal(delivered,0);
});
test('storage contains no source URLs, body or title and drops unknown restored fields',async()=>{
 const h=harness();const r=await h.controller.start(1);await until(()=>h.controller.current(1),t=>t?.state==='saved');
 const raw=h.data[key];raw[0].secret='private-body';raw[0].url='https://private.example';h.seed(raw);
 await h.controller.start(1,{newCopy:true});await until(()=>h.controller.current(1),t=>t?.state==='saved');
 const text=JSON.stringify(h.data);for(const secret of ['https:','synthetic','private-body','private.example','title','text'])assert.ok(!text.includes(secret));assert.equal(h.data[key].length,2);assert.ok(r.jobId);
});
test('storage failure prevents capture and protocol failure is actionable',async()=>{
 let runs=0;const h=harness({storage:{get:async()=>({}),set:async()=>{throw Error('disk')}},run:async()=>{runs++;return {ok:true}}});
 await assert.rejects(()=>h.controller.start(1));assert.equal(runs,0);
 const h2=harness({prepare:async()=>{throw Object.assign(Error(),{code:'PROTOCOL_UPGRADE'})}});await h2.controller.start(1);
 const record=await until(()=>h2.controller.current(1),finished);assert.equal(record.code,'PROTOCOL_UPGRADE');assert.equal(record.state,'failed');assert.equal(h2.calls,0);
});
test('corrupt or future task metadata fails closed without starting a new copy',async()=>{
 const h=harness();h.seed([{jobId:'broken',sourceKey:hash,tabId:1,state:'saving',stage:'NATIVE'}]);
 await assert.rejects(()=>h.controller.start(1),/TASK_METADATA_INVALID/);assert.equal(h.calls,0);assert.equal(h.data[key][0].jobId,'broken');
 h.seed([{jobId:'00000000-0000-4000-8000-000000000001',sourceKey:hash,tabId:1,state:'future-state',stage:'NATIVE'}]);
 await assert.rejects(()=>h.controller.current(1),/TASK_METADATA_INVALID/);assert.equal(h.calls,0);
});

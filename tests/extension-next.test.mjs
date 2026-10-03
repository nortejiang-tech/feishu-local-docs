import test from 'node:test';
import assert from 'node:assert/strict';
import {makeDemo} from '../extension/demo.mjs';
import {decodeDocument} from '../shared/model.mjs';
let listener;
globalThis.chrome={runtime:{id:'extension',getURL:p=>'chrome-extension://extension/'+p,onMessage:{addListener:f=>listener=f}}};
const {saveTab}=await import('../extension-next/src/background.mjs');
function setup({url='https://sample.feishu.cn/docx/abc',reply={ok:true,status:'DELIVERED',requestId:'r'},capture={ok:true,snapshot:makeDemo('document')},scriptError,nativeError}={}){
 const calls=[];chrome.tabs={get:async()=>({url})};
 chrome.action={setBadgeText:async o=>calls.push(o.text),setBadgeBackgroundColor:async()=>{}};
 chrome.scripting={executeScript:async()=>{if(scriptError)throw scriptError;return capture===undefined?[]:[{frameId:0,result:capture}]}};
 chrome.runtime.sendNativeMessage=async(host,message)=>{assert.equal(host,'cn.localdocs.bridge');const doc=await decodeDocument(message.text);assert.equal(doc.kind,'document');calls.push('native');if(nativeError)throw nativeError;return reply};return calls;
}
function assertFailure(result,stage,code){assert.equal(result.ok,false);assert.equal(result.stage,stage);assert.equal(result.code,code);assert.ok(result.message.endsWith(`[诊断：${stage}/${code}]`));}

test('one-click delivery keeps source incompleteness visible',async()=>{const calls=setup();const r=await saveTab(1);assert.equal(r.ok,true);assert.equal(r.partial,true);assert.equal(r.requestId,'r');assert.ok(calls.includes('native'));assert.equal(calls.at(-1),'!')});
test('reject untrusted hosts and unconfirmed native delivery',async()=>{let calls=setup({url:'https://feishu.cn.evil.example/docx/abc'});assertFailure(await saveTab(2),'SOURCE','UNSUPPORTED_SOURCE');assert.ok(!calls.includes('native'));setup({reply:{ok:true,status:'PENDING'}});assertFailure(await saveTab(3),'NATIVE','NATIVE_DELIVERY_UNCONFIRMED')});
test('known capture errors retain stable diagnostics and unknown codes stay hidden',async()=>{setup({capture:{ok:false,code:'MODEL_SHAPE_CHANGED',secret:'do-not-return'}});const result=await saveTab(4);assertFailure(result,'CAPTURE','MODEL_SHAPE_CHANGED');assert.ok(!result.message.includes('do-not-return'));setup({capture:{ok:false,code:'SOURCE_CHANGED'}});assertFailure(await saveTab(5),'CAPTURE','SOURCE_CHANGED');setup({capture:{ok:false,code:'UNTRUSTED_SECRET'}});const unknown=await saveTab(13);assertFailure(unknown,'CAPTURE','CAPTURE_FAILED');assert.ok(!unknown.message.includes('UNTRUSTED_SECRET'))});
test('snapshot conversion failures are actionable and do not expose input',async()=>{setup({capture:{ok:true,snapshot:null,token:'private'}});const result=await saveTab(6);assertFailure(result,'CONVERSION','ARCHIVE_INVALID');assert.ok(!result.message.includes('private'))});
test('script execution exceptions are classified without echoing exception text',async()=>{setup({scriptError:new Error('private-cookie=do-not-return')});const result=await saveTab(7);assertFailure(result,'CAPTURE','EXECUTE_SCRIPT_FAILED');assert.ok(!result.message.includes('private-cookie'));setup({scriptError:new Error('Cannot access contents of the page. Extension manifest must request permission to access the respective host.')});assertFailure(await saveTab(8),'CAPTURE','SCRIPT_ACCESS_DENIED')});
test('native host failures, delivery failures, and malformed replies have separate diagnostics',async()=>{setup({nativeError:new Error('Specified native messaging host not found.')});const missing=await saveTab(9);assertFailure(missing,'NATIVE','NATIVE_HOST_MISSING');assert.match(missing.message,/连接 Chrome 插件/);setup({nativeError:new Error('Access to the specified native messaging host is forbidden.')});assertFailure(await saveTab(10),'NATIVE','NATIVE_HOST_FORBIDDEN');setup({nativeError:new Error('Failed to start native messaging host.')});assertFailure(await saveTab(16),'NATIVE','NATIVE_HOST_START_FAILED');setup({nativeError:new Error('Native host has exited.')});assertFailure(await saveTab(11),'NATIVE','NATIVE_CONNECTION_FAILED');setup({nativeError:new Error('secret unknown chrome error')});assertFailure(await saveTab(14),'NATIVE','NATIVE_CONNECTION_FAILED');setup({reply:{ok:false,code:'LOCAL_DELIVERY_FAILED'}});assertFailure(await saveTab(15),'NATIVE','LOCAL_DELIVERY_FAILED');setup({reply:{ok:true,secret:'must-not-echo'}});const malformed=await saveTab(12);assertFailure(malformed,'NATIVE','NATIVE_REPLY_INVALID');assert.ok(!malformed.message.includes('must-not-echo'))});
test('popup message receiver rejects unrelated senders',()=>{assert.equal(listener({operation:'save-current',tabId:1},{id:'other',url:'https://example.org'},()=>{throw Error('must not respond')}),false)});
test('whiteboard capture is included in local delivery and navigation aborts the save',async()=>{
 const snapshot=makeDemo('document');snapshot.model={rootIds:['root'],blocks:[{id:'root',type:'page',text:'',richText:null,children:['wb'],parentId:null,properties:{}},{id:'wb',type:'whiteboard',text:'',richText:null,children:[],parentId:'root',properties:{},resource:{kind:'whiteboard',resourceId:'board'}}]};
 setup({capture:{ok:true,snapshot}});
 const payload={format:'feishu-whiteboard-page-detail',nodes:[],meta:{}};
 let step=0,delivered;
 chrome.scripting.executeScript=async({func})=>[{frameId:0,result:++step===1?{ok:true,snapshot}:func.name==='captureEmbeds'?{ok:true,embeds:[{sourceId:'wb',kind:'whiteboard',status:'STRUCTURE_CANDIDATE',code:'WHITEBOARD_EDITOR_PENDING',payload,byteLength:new TextEncoder().encode(JSON.stringify(payload)).byteLength,sha256:'a'.repeat(64),resourceCount:0}]}:{ok:true,assets:[]}}];
 chrome.runtime.sendNativeMessage=async(_host,message)=>{delivered=await decodeDocument(message.text);return{ok:true,status:'DELIVERED'};};
 assert.equal((await saveTab(100)).ok,true);assert.equal(delivered.provenance.embedded.length,1);
 step=0;chrome.scripting.executeScript=async()=>[{frameId:0,result:++step===1?{ok:true,snapshot}:{ok:false,code:'SOURCE_CHANGED'}}];
 assertFailure(await saveTab(101),'CAPTURE','SOURCE_CHANGED');
});
test('native Base fields and records are included in one-click local delivery without additional permissions',async()=>{
 const snapshot=makeDemo('document');snapshot.model={rootIds:['root'],blocks:[{id:'root',type:'page',text:'',richText:null,children:['base'],parentId:null,properties:{}},{id:'base',type:'bitable',text:'',richText:null,children:[],parentId:'root',properties:{},resource:{kind:'bitable',resourceId:'app_tbl1'}}]};setup({capture:{ok:true,snapshot}});
 const payload={format:'feishu-bitable-table',sourceTimezone:'Asia/Shanghai',table:{meta:{id:'tbl1'},views:[],viewMap:{},fieldMap:{A:{name:'任务',type:1,property:{}}},recordMap:{R:{A:{value:[{type:'text',text:'task'}]}}}}};let delivered;
 chrome.scripting.executeScript=async({func})=>[{frameId:0,result:func.name==='capturePage'?{ok:true,snapshot}:func.name==='captureBaseTables'?{ok:true,tables:[{sourceId:'base',kind:'bitable',status:'VIEW_SNAPSHOT',code:'BASE_EDITOR_AND_COVERAGE_PENDING',payload,counts:{fields:1,records:1,views:0,declaredRecords:null,metaRecords:null},byteLength:new TextEncoder().encode(JSON.stringify(payload)).byteLength,sha256:'a'.repeat(64)}]}:{ok:true,assets:[]}}];
 chrome.runtime.sendNativeMessage=async(_host,message)=>{delivered=await decodeDocument(message.text);return{ok:true,status:'DELIVERED'};};assert.equal((await saveTab(102)).ok,true);assert.equal(delivered.content.content[0].type,'localBase');assert.equal(delivered.provenance.audit.counts.structuredBases,1);
});

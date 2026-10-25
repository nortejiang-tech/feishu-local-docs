import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocument,encodeDocument,decodeDocument} from '../shared/model.mjs';
import {loadLibrary,loadLibraryIndex,loadDocument,saveLocal,openLocal,exportHtml,exportLocal,listHistory,openHistory} from '../app/src/io.mjs';

test('library retains valid files while isolating corrupt or unsupported files',async()=>{
 const doc=createDocument('document','Good');
 const valid=await encodeDocument(doc),slides=await encodeDocument(createDocument('slides'));
 globalThis.window={localDocsNative:{request:async()=>({files:[valid,'{bad',slides],skipped:1})}};
 const docs=await loadLibrary();assert.equal(docs.length,1);assert.equal(docs[0].title,'Good');assert.equal(docs.skipped,3);
});
test('save queue persists snapshots in order and survives a failed write',async()=>{
 const writes=[];let count=0;
 globalThis.window={localDocsNative:{request:async(action,{text})=>{assert.equal(action,'save');writes.push(await decodeDocument(text));if(++count===1)throw Error('FILE_IO_FAILED');return {savedAt:'now'}}}};
 const doc=createDocument('document','Before');const first=saveLocal(doc);doc.title='After';
 const second=saveLocal(doc);
 await assert.rejects(first,/保存失败/);await second;
 assert.deepEqual(writes.map(d=>d.title),['Before','After']);
});
test('opening a local copy creates a separate library ID and refuses deferred slides',async()=>{
 const doc=createDocument('document','Copy');let text=await encodeDocument(doc);
 globalThis.window={localDocsNative:{request:async()=>({text})}};
 const copy=await openLocal();assert.notEqual(copy.id,doc.id);assert.equal(copy.title,doc.title);
 text=await encodeDocument(createDocument('slides'));
 await assert.rejects(openLocal(),/只支持文档和电子表格/);
});
test('HTML export uses its dedicated native action, preserves source and propagates cancellation and write failure',async()=>{
 const doc=createDocument('document','Reading copy');const before=JSON.stringify(doc),calls=[];
 let response={cancelled:false};
 globalThis.window={localDocsNative:{request:async(action,payload)=>{calls.push({action,payload});if(response instanceof Error)throw response;return response;}}};
 const result=await exportHtml(doc,{chooseLocation:true});assert.equal(result.cancelled,false);assert.equal(calls[0].action,'saveHtml');assert.equal(calls[0].payload.name,'Reading copy.html');assert.match(calls[0].payload.text,/<!doctype html>/);assert.equal(JSON.stringify(doc),before);
 response={cancelled:true};assert.equal((await exportHtml(doc,{chooseLocation:true})).cancelled,true);
 response=Error('FILE_IO_FAILED');await assert.rejects(exportHtml(doc,{chooseLocation:true}),/保存失败/);
});

test('native startup reads summaries and hydrates only the requested document',async()=>{
 const doc=createDocument('document','Lazy file'),text=await encodeDocument(doc),calls=[];
 globalThis.window={localDocsNative:{request:async(action,payload)=>{calls.push(action);if(action==='listMetadata')return {files:[{...doc,summary:true,content:undefined,issues:undefined}],skipped:2};assert.equal(action,'readDocument');assert.ok(payload.documentId);return {text};}}};
 const files=await loadLibraryIndex();assert.equal(files.length,1);assert.equal(files.skipped,2);assert.equal(files[0].summary,true);assert.equal(files[0].content,undefined);assert.deepEqual(calls,['listMetadata']);
 assert.equal((await loadDocument(doc.id)).title,doc.title);assert.deepEqual(calls,['listMetadata','readDocument']);
 await assert.rejects(loadDocument(crypto.randomUUID()),/文件结构/);
});
test('native conflicting save keeps the recovery message actionable',async()=>{
 globalThis.window={localDocsNative:{request:async()=>{throw Error('FILE_CONFLICT');}}};
 await assert.rejects(saveLocal(createDocument()),/保存独立副本/);
});

test('native writes carry the last verified file hash and advance only after confirmation',async()=>{
 const doc=createDocument('document','Base'),text=await encodeDocument(doc),calls=[];
 globalThis.window={localDocsNative:{request:async(action,payload)=>{if(action==='readDocument')return {text};calls.push(payload);return {savedAt:'confirmed'};}}};
 await loadDocument(doc.id);const edited={...doc,revision:1,title:'Edited'};await saveLocal(edited);await saveLocal({...edited,revision:2,title:'Again'});
 assert.equal(calls[0].expectedHash,JSON.parse(text).sha256);assert.equal(calls[1].expectedHash,JSON.parse(calls[0].text).sha256);
});
test('history opens as an independent document and refuses mismatched identity or bytes',async()=>{
 const doc=createDocument('document','Past'),text=await encodeDocument(doc),hash=JSON.parse(text).sha256;
 globalThis.window={localDocsNative:{request:async(action,payload)=>action==='listHistory'?[{hash,revision:0}]:{text}}};
 assert.equal((await listHistory(doc.id))[0].hash,hash);
 const copy=await openHistory(doc.id,hash);assert.notEqual(copy.id,doc.id);assert.match(copy.title,/历史副本/);assert.deepEqual(copy.content,doc.content);
 await assert.rejects(openHistory(crypto.randomUUID(),hash),/文件结构/);
 await assert.rejects(openHistory(doc.id,'0'.repeat(64)),/文件结构/);
 await assert.rejects(openHistory(doc.id,'../escape'),/文件结构/);
});

test('default native exports confirm exact bytes without opening a system panel',async()=>{
 const doc=createDocument('document','本机副本'.repeat(40)),before=JSON.stringify(doc),calls=[];
 globalThis.window={localDocsNative:{request:async(action,payload)=>{calls.push(action);assert.equal(action,'exportManaged');assert.ok(new TextEncoder().encode(payload.name).length<=240);const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(payload.text)));return {cancelled:false,exportId:payload.requestId,name:payload.name,kind:payload.kind,sha256:Array.from(bytes,v=>v.toString(16).padStart(2,'0')).join('')};}}};
 assert.equal((await exportHtml(doc)).kind,'html');assert.equal((await exportLocal(doc)).kind,'localdoc');assert.deepEqual(calls,['exportManaged','exportManaged']);assert.equal(JSON.stringify(doc),before);
 globalThis.window.localDocsNative.request=async()=>({cancelled:false,sha256:'wrong'});
 await assert.rejects(exportHtml(doc),/完整性确认/);
});

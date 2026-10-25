import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocument,encodeDocument,decodeDocument} from '../shared/model.mjs';
import {loadLibrary,loadLibraryIndex,loadDocument,saveLocal,openLocal,exportHtml} from '../app/src/io.mjs';

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
 const result=await exportHtml(doc);assert.equal(result.cancelled,false);assert.equal(calls[0].action,'saveHtml');assert.equal(calls[0].payload.name,'Reading copy.html');assert.match(calls[0].payload.text,/<!doctype html>/);assert.equal(JSON.stringify(doc),before);
 response={cancelled:true};assert.equal((await exportHtml(doc)).cancelled,true);
 response=Error('FILE_IO_FAILED');await assert.rejects(exportHtml(doc),/保存失败/);
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

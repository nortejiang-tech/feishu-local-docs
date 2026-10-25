import { encodeDocument, decodeDocument, safeFileName, MAX_FILE_BYTES } from '../../shared/model.mjs';
import { importSnapshot } from '../../shared/import-snapshot.mjs';
import { parseArchive } from '../../extension/archive.mjs';
import { DEFAULT_OPERATION_TIMEOUT_MS, withDeadline } from './operation-deadline.mjs';
import {documentSummary} from '../../shared/library-view.mjs';

export const isNative = () => typeof window.localDocsNative?.request === 'function';
const native = (action, payload = {}) => window.localDocsNative.request(action, payload);
let dbPromise;
let queue = Promise.resolve();
// Optimistic write preconditions stay in memory, outside portable document data.
const persistedHashes = new Map();
const errors = {
  DOCUMENT_INVALID:'文件结构不受支持，原文件未改动。', DOCUMENT_HASH_MISMATCH:'文件校验失败，请使用未损坏的副本。', DOCUMENT_VERSION_UNSUPPORTED:'这个文件版本暂不支持。',
  DOCUMENT_TOO_LARGE:'文件超过当前版本的 32 MB 限制。', FILE_IO_FAILED:'本机文件保存失败，请检查磁盘空间后重试。',
  FILE_CONFLICT:'本机已有另一个版本，当前编辑仍保留。请保存独立副本后重新打开。',
  FEISHU_IMPORT_FAILED:'飞书导入未完成。请检查飞书连接与权限后重试；原文件未改动。',
  FEISHU_CONNECTION_UNAVAILABLE:'此电脑尚未连接飞书。当前开发版需要已登录的飞书连接组件。',
  OFFICE_UNSUPPORTED_CONTENT:'文件包含当前回导尚不支持的对象，已保留在本地。', NATIVE_TIMEOUT:'操作尚未确认完成，请先检查已有结果，避免重复创建。',
  SAVE_UNCONFIRMED:'保存尚未确认完成，当前编辑仍保留，请稍后重试。', OPERATION_TIMEOUT:'操作尚未确认完成，请稍后重试。'
  ,HTML_GRID_TOO_LARGE:'表格范围超过 HTML 当前支持的 15 万个位置，未生成截断文件。', HTML_TOO_LARGE:'HTML 超过 32 MB，未生成截断文件。', HTML_MERGE_INVALID:'合并单元格范围冲突，无法生成完整的 HTML。', HTML_KIND_UNSUPPORTED:'当前 HTML 保存支持文档和电子表格。'
};
function friendly(error) { return new Error(errors[error?.message] || error?.message || '操作未完成，请重试。'); }
async function database() {
  if (!dbPromise) dbPromise = new Promise((resolve,reject) => {
    const request=indexedDB.open('local-docs-v2',3);
    let blocked=false;
    request.onupgradeneeded=()=>{for(const name of ['documents','trash','history'])if(!request.result.objectStoreNames.contains(name))request.result.createObjectStore(name);};
    request.onsuccess=()=>{if(blocked){request.result.close();return;}request.result.onversionchange=()=>{request.result.close();dbPromise=undefined;};resolve(request.result);};
    request.onerror=()=>{dbPromise=undefined;reject(new Error('无法打开本机资料库。'));};
    request.onblocked=()=>{blocked=true;dbPromise=undefined;reject(new Error('资料库升级正在等待其他窗口关闭，请保存副本并关闭旧窗口后重试。'));};
  });
  return dbPromise;
}
async function idbAction(mode, operation,store='documents') {
  const db=await database();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(store,mode), request=operation(tx.objectStore(store));
    tx.oncomplete=()=>resolve(request.result);
    tx.onerror=tx.onabort=()=>reject(new Error('本机资料库保存失败，请检查可用空间。'));
  });
}
export async function loadLibraryIndex(){
  try{
    if(!isNative()){
      const active=await loadLibrary(),trash=await idbAction('readonly',s=>s.getAll(),'trash');
      for(const text of trash){try{const summary=documentSummary(await decodeDocument(text));if(summary)active.push({...summary,trashed:true});}catch{}}
      return active;
    }
    const result=await withDeadline(native('listMetadata'),DEFAULT_OPERATION_TIMEOUT_MS);
    if(!Array.isArray(result?.files))throw Error('DOCUMENT_INVALID');
    const docs=result.files.map(documentSummary).filter(Boolean);
    Object.defineProperty(docs,'skipped',{value:(result.skipped||0)+result.files.length-docs.length});return docs;
  }catch(error){throw friendly(error);}
}
export async function loadDocument(id){
  try{
    const text=isNative()?(await withDeadline(native('readDocument',{documentId:id}),DEFAULT_OPERATION_TIMEOUT_MS)).text:await idbAction('readonly',s=>s.get(id));
    const doc=await decodeDocument(text);if(doc.id!==id)throw Error('DOCUMENT_INVALID');
    persistedHashes.set(doc.id,JSON.parse(text).sha256);return doc;
  }catch(error){throw friendly(error);}
}
function historyRange(id){return IDBKeyRange.bound([id,''],[id,'\uffff']);}
export async function listHistory(id){
  try{
    if(isNative())return await withDeadline(native('listHistory',{documentId:id}),DEFAULT_OPERATION_TIMEOUT_MS);
    const rows=await idbAction('readonly',s=>s.getAll(historyRange(id)),'history'),result=[];
    for(const row of rows){try{const doc=await decodeDocument(row.text),hash=JSON.parse(row.text).sha256;if(doc.id===id)result.push({hash,title:doc.title,revision:doc.revision,updatedAt:doc.updatedAt,savedAt:row.savedAt,bytes:new TextEncoder().encode(row.text).length});}catch{}}
    return result.sort((a,b)=>b.savedAt.localeCompare(a.savedAt)||b.revision-a.revision);
  }catch(error){throw friendly(error);}
}
export async function openHistory(id,hash){
  try{
    if(!/^[0-9a-f]{64}$/.test(hash))throw Error('DOCUMENT_INVALID');
    const text=isNative()?(await withDeadline(native('readHistory',{documentId:id,hash}),DEFAULT_OPERATION_TIMEOUT_MS)).text:(await idbAction('readonly',s=>s.get([id,hash]),'history'))?.text;
    const doc=await decodeDocument(text);if(doc.id!==id||JSON.parse(text).sha256!==hash)throw Error('DOCUMENT_INVALID');
    const copy={...doc,id:crypto.randomUUID(),title:`${doc.title} · 历史副本`.slice(0,1000)};
    if(doc.localMeta){copy.localMeta={...doc.localMeta};delete copy.localMeta.taskId;}
    return copy;
  }catch(error){throw friendly(error);}
}
async function moveBrowserDocument(id,toTrash){
  const db=await database(),source=toTrash?'documents':'trash',target=toTrash?'trash':'documents';
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(['documents','trash'],'readwrite'),from=tx.objectStore(source),to=tx.objectStore(target);
    const read=from.get(id),check=to.get(id);let failure;
    check.onsuccess=()=>{if(check.result!==undefined){failure=Error('目标已存在同名副本，原文件已保留。');tx.abort();}};
    read.onsuccess=()=>{if(read.result===undefined){failure=Error('文件不存在，原有资料未改动。');tx.abort();return;}to.put(read.result,id);from.delete(id);};
    tx.oncomplete=()=>resolve(true);tx.onerror=tx.onabort=()=>reject(failure||Error('本机资料移动未完成，原文件已保留。'));
  });
}
export async function moveLocal(id,toTrash){
  try{return isNative()?await withDeadline(native(toTrash?'trashDocument':'restoreDocument',{documentId:id}),DEFAULT_OPERATION_TIMEOUT_MS):await moveBrowserDocument(id,toTrash);}
  catch(error){throw friendly(error);}
}
export async function revealLocal(id){
  if(!isNative())throw Error('浏览器资料库保存在浏览器内，可先保存副本到文件夹。');
  return native('revealDocument',{documentId:id});
}
export async function systemStatus(){
  if(!isNative())return {native:false,connected:false,version:'网页版',experimentalImport:false};
  return withDeadline(native('systemStatus'),DEFAULT_OPERATION_TIMEOUT_MS);
}
export async function repairConnection(){if(!isNative())throw Error('请在桌面应用中连接Chrome。');return native('connectChrome');}
export async function showExtension(){if(!isNative())throw Error('请在桌面应用中查看插件。');return native('showExtension');}
export async function listTasks(){return isNative()?withDeadline(native('listTasks'),DEFAULT_OPERATION_TIMEOUT_MS):[];}
export async function readTask(jobId){
  if(!isNative())throw Error('请在桌面应用中查看浏览器保存任务。');
  const result=await native('readTask',{jobId}),doc=await decodeDocument(result.text);
  return {...doc,id:crypto.randomUUID(),localMeta:{...doc.localMeta,taskId:jobId}};
}
export async function repairTaskHtml(jobId){
  const result=await native('readTask',{jobId}),doc=await decodeDocument(result.text);
  const {buildHtmlFile}=await import('../../shared/html-export.mjs');
  return withDeadline(native('repairTaskHtml',{jobId,html:buildHtmlFile(doc).html}),DEFAULT_OPERATION_TIMEOUT_MS);
}
export function revealTaskHtml(jobId){return native('revealTaskHtml',{jobId});}
export async function loadLibrary() {
  try {
    const result=isNative() ? await withDeadline(native('list'), DEFAULT_OPERATION_TIMEOUT_MS) : await idbAction('readonly',s=>s.getAll());
    const texts=Array.isArray(result)?result:result.files;
    const docs=[]; let skipped=Array.isArray(result)?0:(result.skipped||0);
    for (const text of texts) {
      try { const doc=await decodeDocument(text); if(doc.kind==='slides'){skipped++;continue} persistedHashes.set(doc.id,JSON.parse(text).sha256);docs.push(doc); }
      catch { skipped++; }
    }
    docs.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
    Object.defineProperty(docs,'skipped',{value:skipped});
    return docs;
  } catch(error) { throw friendly(error); }
}
export function saveLocal(doc) {
  // Serialize immediately so a later edit cannot change an enqueued write.
  const encode=withDeadline(encodeDocument(doc), DEFAULT_OPERATION_TIMEOUT_MS).then(text=>({text}),error=>({error: error?.message === 'OPERATION_TIMEOUT' ? new Error('SAVE_UNCONFIRMED') : error}));
  const operation=queue.catch(()=>{}).then(async()=>{
    const encoded=await encode;
    if(encoded.error)throw encoded.error;
    const text=encoded.text;
    // A timed out bridge call may still finish in native code. The native fileQueue remains
    // the serialization boundary for writes that were already sent.
    const expectedHash=persistedHashes.get(doc.id);
    if (isNative()) {
      const result=await withDeadline(native('save',{text,...(expectedHash?{expectedHash}:{})}), DEFAULT_OPERATION_TIMEOUT_MS).catch(error=>{ if(error?.message==='OPERATION_TIMEOUT')throw new Error('SAVE_UNCONFIRMED'); throw error; });
      persistedHashes.set(doc.id,JSON.parse(text).sha256);return result;
    }
    const db=await database();
    await new Promise((resolve,reject)=>{
      const tx=db.transaction(['documents','trash','history'],'readwrite'),check=tx.objectStore('trash').get(doc.id);let failure='FILE_IO_FAILED';
      check.onsuccess=()=>{
        if(check.result!==undefined){failure='FILE_CONFLICT';tx.abort();return;}
        const current=tx.objectStore('documents').get(doc.id);
        current.onsuccess=()=>{try{
          if(current.result!==undefined&&current.result!==text){
            const stored=JSON.parse(current.result),previous=stored.document;if(!Number.isSafeInteger(previous?.revision))throw Error();if(!expectedHash||stored.sha256!==expectedHash||previous.revision>=doc.revision){failure='FILE_CONFLICT';tx.abort();return;}
            const history=tx.objectStore('history');history.put({text:current.result,savedAt:new Date().toISOString()},[doc.id,stored.sha256]);
            const records=history.getAll(historyRange(doc.id));records.onsuccess=()=>{
              const rows=records.result.sort((a,b)=>b.savedAt.localeCompare(a.savedAt)||JSON.parse(b.text).document.revision-JSON.parse(a.text).document.revision);let bytes=0;
              for(let i=0;i<rows.length;i++){bytes+=new TextEncoder().encode(rows[i].text).length;if(i>=10||(i>0&&bytes>64*1024*1024))history.delete([doc.id,JSON.parse(rows[i].text).sha256]);}
            };
          }
          tx.objectStore('documents').put(text,doc.id);
        }catch{tx.abort();}};
      };
      tx.oncomplete=resolve;tx.onerror=tx.onabort=()=>reject(new Error(failure));
    });
    const stored=await idbAction('readonly',s=>s.get(doc.id));
    if (stored!==text) throw new Error('FILE_IO_FAILED');
    persistedHashes.set(doc.id,JSON.parse(text).sha256);
    return {savedAt:new Date().toISOString(),location:'此浏览器的本机资料库'};
  });
  queue=operation;
  return operation.catch(error=>{throw friendly(error)});
}
async function decodeAny(text) {
  if (new TextEncoder().encode(text).length>MAX_FILE_BYTES) throw new Error('DOCUMENT_TOO_LARGE');
  let parsed; try { parsed=JSON.parse(text) } catch { throw new Error('DOCUMENT_INVALID') }
  const doc=parsed.format==='fdocpack' ? importSnapshot(await parseArchive(text)) : await decodeDocument(text);
  if(doc.kind==='slides')throw new Error('当前版本只支持文档和电子表格，幻灯片文件已保留。');
  return doc;
}
async function pickBrowserFile() {
  return new Promise(resolve=>{
    const input=document.createElement('input'); input.type='file'; input.accept='.localdoc,.json';
    input.hidden=true;document.body.append(input);
    const finish=file=>{input.remove();resolve(file);};
    input.onchange=()=>finish(input.files?.[0] || null);
    input.oncancel=()=>finish(null); input.click();
  });
}
export async function openLocal() {
  try {
    let text;
    if (isNative()) { const result=await native('open'); if(!result)return null; text=result.text; }
    else { const file=await pickBrowserFile(); if(!file)return null; if(file.size>MAX_FILE_BYTES)throw new Error('DOCUMENT_TOO_LARGE'); text=await file.text(); }
    const imported=await decodeAny(text);
    // Opening an external version creates its own library entry, preserving any newer local edits.
    return {...imported,id:crypto.randomUUID()};
  } catch(error) { throw friendly(error); }
}
export async function exportLocal(doc) {
  try {
    const text=await encodeDocument(doc), name=safeFileName(doc.title);
    if(isNative())return await native('saveCopy',{text,name});
    const url=URL.createObjectURL(new Blob([text],{type:'application/octet-stream'}));
    const a=document.createElement('a'); a.href=url;a.download=name; document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
    return {cancelled:false,initiated:true};
  } catch(error) { throw friendly(error); }
}
export async function exportHtml(doc) {
  try {
    const {buildHtmlFile}=await import('../../shared/html-export.mjs');
    const output=buildHtmlFile(doc);
    let result;
    if(isNative()) result=await native('saveHtml',{text:output.html,name:output.name});
    else {
      const url=URL.createObjectURL(new Blob([output.html],{type:'text/html;charset=utf-8'}));
      const a=document.createElement('a');a.href=url;a.download=output.name;
      document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
      result={cancelled:false,initiated:true};
    }
    return {...result,warnings:output.warnings,stats:output.stats};
  } catch(error) { throw friendly(error); }
}
export async function importFeishu(doc) {
  try {
    if(!isNative())throw new Error('请在本地文档应用中使用“导入飞书”。');
    if(doc.issues.some(x=>x.count>0))throw new Error('当前文件尚有未完整读取的内容，暂不能保证回导一致。完整本地数据已保留。');
    const {buildOfficeFile}=await import('./office.mjs');
    const output=await buildOfficeFile(doc);
    if(output.warnings.length)throw new Error('该文件包含尚未支持回导的格式，已保留在本地。');
    let binary='';for(let i=0;i<output.bytes.length;i+=8192)binary+=String.fromCharCode(...output.bytes.subarray(i,i+8192));
    const result=await native('importOffice',{format:output.format,title:doc.title.slice(0,200),base64:btoa(binary)});
    // A browser launch failure must not turn a created cloud copy into a retry.
    if(result.url)await native('openURL',{url:result.url}).catch(()=>{});
    return result;
  } catch(error) { throw friendly(error); }
}
export function watchIncoming(callback) {
  let alive=true;
  const handle=async event=>{
    try {
      const doc=await decodeAny(event.detail.text);
      const taskId=typeof event.detail.name==='string'&&/^[0-9a-f-]{36}\.localdoc$/i.test(event.detail.name)?event.detail.name.slice(0,-9).toLowerCase():null;
      if(alive)await callback({...doc,id:crypto.randomUUID(),...(taskId?{localMeta:{...doc.localMeta,taskId}}:{})});
    } catch(error) { window.dispatchEvent(new CustomEvent('localdocs:error',{detail:friendly(error).message})); }
  };
  window.addEventListener('localdocs:incoming',handle);
  if(isNative())native('ready').catch(error=>window.dispatchEvent(new CustomEvent('localdocs:error',{detail:friendly(error).message})));
  return()=>{alive=false;window.removeEventListener('localdocs:incoming',handle)};
}

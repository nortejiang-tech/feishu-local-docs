import { encodeDocument, decodeDocument, safeFileName, MAX_FILE_BYTES } from '../../shared/model.mjs';
import { importSnapshot } from '../../shared/import-snapshot.mjs';
import { parseArchive } from '../../extension/archive.mjs';
import { DEFAULT_OPERATION_TIMEOUT_MS, withDeadline } from './operation-deadline.mjs';

export const isNative = () => typeof window.localDocsNative?.request === 'function';
const native = (action, payload = {}) => window.localDocsNative.request(action, payload);
let dbPromise;
let queue = Promise.resolve();
const errors = {
  DOCUMENT_INVALID:'文件结构不受支持，原文件未改动。', DOCUMENT_HASH_MISMATCH:'文件校验失败，请使用未损坏的副本。', DOCUMENT_VERSION_UNSUPPORTED:'这个文件版本暂不支持。',
  DOCUMENT_TOO_LARGE:'文件超过当前版本的 32 MB 限制。', FILE_IO_FAILED:'本机文件保存失败，请检查磁盘空间后重试。',
  FEISHU_IMPORT_FAILED:'飞书导入未完成。请检查飞书连接与权限后重试；原文件未改动。',
  FEISHU_CONNECTION_UNAVAILABLE:'此电脑尚未连接飞书。当前开发版需要已登录的飞书连接组件。',
  OFFICE_UNSUPPORTED_CONTENT:'文件包含当前回导尚不支持的对象，已保留在本地。', NATIVE_TIMEOUT:'操作尚未确认完成，请先检查已有结果，避免重复创建。',
  SAVE_UNCONFIRMED:'保存尚未确认完成，当前编辑仍保留，请稍后重试。', OPERATION_TIMEOUT:'操作尚未确认完成，请稍后重试。'
  ,HTML_GRID_TOO_LARGE:'表格范围超过 HTML 当前支持的 15 万个位置，未生成截断文件。', HTML_TOO_LARGE:'HTML 超过 32 MB，未生成截断文件。', HTML_MERGE_INVALID:'合并单元格范围冲突，无法生成完整的 HTML。', HTML_KIND_UNSUPPORTED:'当前 HTML 保存支持文档和电子表格。'
};
function friendly(error) { return new Error(errors[error?.message] || error?.message || '操作未完成，请重试。'); }
async function database() {
  if (!dbPromise) dbPromise = new Promise((resolve,reject) => {
    const request=indexedDB.open('local-docs-v2',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('documents');
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(new Error('无法打开本机资料库。'));
  });
  return dbPromise;
}
async function idbAction(mode, operation) {
  const db=await database();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('documents',mode), request=operation(tx.objectStore('documents'));
    tx.oncomplete=()=>resolve(request.result);
    tx.onerror=tx.onabort=()=>reject(new Error('本机资料库保存失败，请检查可用空间。'));
  });
}
export async function loadLibrary() {
  try {
    const result=isNative() ? await withDeadline(native('list'), DEFAULT_OPERATION_TIMEOUT_MS) : await idbAction('readonly',s=>s.getAll());
    const texts=Array.isArray(result)?result:result.files;
    const docs=[]; let skipped=Array.isArray(result)?0:(result.skipped||0);
    for (const text of texts) {
      try { const doc=await decodeDocument(text); if(doc.kind==='slides'){skipped++;continue} docs.push(doc); }
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
    if (isNative()) return withDeadline(native('save',{text}), DEFAULT_OPERATION_TIMEOUT_MS).catch(error=>{ if(error?.message==='OPERATION_TIMEOUT')throw new Error('SAVE_UNCONFIRMED'); throw error; });
    await idbAction('readwrite',s=>s.put(text,doc.id));
    const stored=await idbAction('readonly',s=>s.get(doc.id));
    if (stored!==text) throw new Error('FILE_IO_FAILED');
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
    input.onchange=()=>resolve(input.files?.[0] || null);
    input.oncancel=()=>resolve(null); input.click();
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
      if(alive)await callback({...doc,id:crypto.randomUUID()});
    } catch(error) { window.dispatchEvent(new CustomEvent('localdocs:error',{detail:friendly(error).message})); }
  };
  window.addEventListener('localdocs:incoming',handle);
  if(isNative())native('ready').catch(error=>window.dispatchEvent(new CustomEvent('localdocs:error',{detail:friendly(error).message})));
  return()=>{alive=false;window.removeEventListener('localdocs:incoming',handle)};
}

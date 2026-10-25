import { captureResources } from '../../extension/resources.mjs';
import { capturePage } from '../../extension/capture.mjs';
import { captureEmbeds } from '../../extension/embedded.mjs';
import { captureBaseTables } from '../../extension/base.mjs';
import { importSnapshot } from '../../shared/import-snapshot.mjs';
import { encodeDocument } from '../../shared/model.mjs';
import { createTaskController } from './tasks.mjs';
import { readResourceQueue } from './resource-queue.mjs';
import {buildHtmlFile} from '../../shared/html-export.mjs';

const jobs = new Set();
const messages = {
  UNSUPPORTED_SOURCE:'请在已打开的飞书文档或电子表格中点击插件。',
  SOURCE_CHANGED:'页面已经切换，请在要保存的文件中重新点击。',
  SLIDES_ADAPTER_PENDING:'本轮先支持文档和电子表格。',
  MODEL_UNAVAILABLE:'当前页面的内容尚未就绪，或这种页面结构还不支持。',
  CAPTURE_TIMEOUT:'本次读取未完成，原文件未改动。',
  EMPTY_OR_UNLOADED_SHEET:'仍有工作表未加载完整。',
  MODEL_SHAPE_CHANGED:'飞书页面结构已变化，插件暂时无法识别。请刷新页面后重试。',
  BLOCK_LIMIT:'页面内容已超过当前版本支持上限，暂无法保存。',
  BLOCK_ID_INVALID:'页面内容中的区块标识无效。请刷新原文件后重试。',
  BLOCK_NOT_READY:'页面中仍有内容尚未就绪，请等待加载完成后重试。',
  CELL_RANGE_LIMIT:'表格数据已超过当前版本支持上限，暂无法保存。',
  SHEET_LIMIT:'工作表数据已超过当前版本支持上限，暂无法保存。',
  FIELD_LIMIT:'页面字段已超过当前版本支持上限，暂无法保存。',
  CONTENT_LIMIT:'页面内容已超过当前版本支持上限，暂无法保存。',
  TEXT_SHAPE_CHANGED:'飞书页面文字结构已变化，插件暂时无法识别。请刷新页面后重试。',
  ATTRIBUTE_LIMIT:'页面属性已超过当前版本支持上限，暂无法保存。',
  PAYLOAD_LIMIT:'页面数据已超过当前版本支持上限，暂无法保存。',
  PAGE_READ_FAILED:'页面读取未完成。请确认文件已加载后重试。',
  IMPORT_INVALID:'页面内容格式不完整，无法安全转换。请刷新原文件后重试。',
  IMPORT_TOO_LARGE:'页面内容已超过当前版本支持上限，暂无法保存。',
  ARCHIVE_INVALID:'页面数据未通过完整性检查。请刷新原文件后重试。',
  DOCUMENT_INVALID:'转换后的文件未通过完整性检查。请刷新原文件后重试。',
  DOCUMENT_TOO_LARGE:'转换后的文件已超过当前版本支持上限，暂无法保存。',
  CRYPTO_UNAVAILABLE:'当前浏览器无法完成文件完整性校验，请更新浏览器后重试。',
  SCRIPT_ACCESS_DENIED:'Chrome 未允许插件读取此页面。请确认插件对当前飞书站点有访问权限后重试。',
  EXECUTE_SCRIPT_FAILED:'插件无法在当前页面启动读取。请刷新页面后重试。',
  CAPTURE_RESULT_MISSING:'页面读取没有返回有效内容。请刷新原文件后重试。',
  CAPTURE_FAILED:'页面读取未完成。请确认文件已加载后重试。',
  CONVERSION_FAILED:'页面内容转换未完成。请刷新原文件后重试。',
  NATIVE_HOST_MISSING:'请先打开“本地文档”应用，在应用菜单选择“连接 Chrome 插件”后重试。',
  NATIVE_HOST_FORBIDDEN:'Chrome 禁止连接“本地文档”应用。请检查应用的插件连接设置后重试。',
  NATIVE_HOST_START_FAILED:'“本地文档”应用未能启动。请先打开应用，再重试。',
  NATIVE_CONNECTION_FAILED:'无法连接“本地文档”应用。请先打开应用，并在应用菜单选择“连接 Chrome 插件”后重试。',
  NATIVE_REPLY_INVALID:'“本地文档”应用返回了无法识别的结果。请更新应用后重试。',
  LOCAL_DELIVERY_FAILED:'本地应用无法保存这份文件。请检查应用状态和本地存储空间后重试。',
  NATIVE_DELIVERY_UNCONFIRMED:'本地应用没有确认保存完成。请检查应用状态后重试。',
  SAVE_IN_PROGRESS:'这份文件正在保存，请稍候。',
  TASK_STATE_UNAVAILABLE:'保存任务状态暂时无法读取，请检查插件本地存储后重试。',
  RESOURCE_LIMIT:'嵌入资源超过当前支持的200项，未生成不完整的保存结果。',
  NATIVE_OUTPUT_PENDING:'可编辑副本已保留，HTML尚未完成。请在应用的保存任务中修复HTML输出。',
  SAVE_FAILED:'这次保存未完成。请保留源文件，稍后重试。'
};
const captureCodes=new Set(['UNSUPPORTED_SOURCE','SOURCE_CHANGED','SLIDES_ADAPTER_PENDING','MODEL_UNAVAILABLE','CAPTURE_TIMEOUT','EMPTY_OR_UNLOADED_SHEET','MODEL_SHAPE_CHANGED','BLOCK_LIMIT','BLOCK_ID_INVALID','BLOCK_NOT_READY','CELL_RANGE_LIMIT','SHEET_LIMIT','FIELD_LIMIT','CONTENT_LIMIT','TEXT_SHAPE_CHANGED','ATTRIBUTE_LIMIT','PAYLOAD_LIMIT','PAGE_READ_FAILED','RESOURCE_LIMIT']);
const conversionCodes=new Set(['IMPORT_INVALID','IMPORT_TOO_LARGE','ARCHIVE_INVALID','DOCUMENT_INVALID','DOCUMENT_TOO_LARGE','CRYPTO_UNAVAILABLE']);
const diagnosticCodes=new Set([...captureCodes,...conversionCodes,'UNSUPPORTED_SOURCE','SCRIPT_ACCESS_DENIED','EXECUTE_SCRIPT_FAILED','CAPTURE_RESULT_MISSING','CAPTURE_FAILED','CONVERSION_FAILED','NATIVE_HOST_MISSING','NATIVE_HOST_FORBIDDEN','NATIVE_HOST_START_FAILED','NATIVE_CONNECTION_FAILED','NATIVE_REPLY_INVALID','LOCAL_DELIVERY_FAILED','NATIVE_DELIVERY_UNCONFIRMED','NATIVE_OUTPUT_PENDING','SAVE_IN_PROGRESS','SAVE_FAILED']);
const chromeScriptErrors=new Map([
  ['Cannot access contents of the page. Extension manifest must request permission to access the respective host.','SCRIPT_ACCESS_DENIED'],
  ['Cannot access a chrome:// URL','SCRIPT_ACCESS_DENIED'],
  ['The extensions gallery cannot be scripted.','SCRIPT_ACCESS_DENIED']
]);
const nativeErrors=new Map([
  ['Specified native messaging host not found.','NATIVE_HOST_MISSING'],
  ['Access to the specified native messaging host is forbidden.','NATIVE_HOST_FORBIDDEN'],
  ['Failed to start native messaging host.','NATIVE_HOST_START_FAILED'],
  ['Native host has exited.','NATIVE_CONNECTION_FAILED'],
  ['Error when communicating with the native messaging host.','NATIVE_CONNECTION_FAILED']
]);
function failure(stage,code) { return {ok:false,stage,code,message:`${messages[code]||'这次保存未完成。请保留源文件，稍后重试。'} [诊断：${stage}/${code}]`}; }
export async function saveTab(tabId,options={}) {
  if(jobs.has(tabId))return failure('GUARD','SAVE_IN_PROGRESS');
  jobs.add(tabId);
  let stage='SOURCE',code='SAVE_FAILED';
  try {
    const tab=await chrome.tabs.get(tabId);
    const source=new URL(tab.url);
    if(source.protocol!=='https:'||!/(^|\.)(feishu\.cn|larksuite\.com)$/.test(source.hostname))return failure('SOURCE','UNSUPPORTED_SOURCE');
    if(options.expectedSource&&source.origin+source.pathname!==options.expectedSource)throw Object.assign(new Error(),{stage:'CAPTURE',code:'SOURCE_CHANGED'});
    const check=async(stage,extra)=>{if(options.checkpoint)await options.checkpoint(stage,extra);};
    await check('CAPTURE');
    await chrome.action.setBadgeText({tabId,text:'…'});
    stage='CAPTURE';
    let result;
    try { result=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:capturePage,args:[{expectedSource:source.origin+source.pathname}]}); }
    catch(error) { code=chromeScriptErrors.get(error?.message)||'EXECUTE_SCRIPT_FAILED';throw Object.assign(new Error(),{stage,code}); }
    const capture=result?.find?.(x=>x.frameId===0)?.result;
    if(!capture||typeof capture!=='object') { code='CAPTURE_RESULT_MISSING';throw Object.assign(new Error(),{stage,code}); }
    if(!capture.ok) { code=captureCodes.has(capture.code)?capture.code:'CAPTURE_FAILED';throw Object.assign(new Error(),{stage,code}); }
    await check('CAPTURE');
    let assets=[],embeds=[];
    if(capture.snapshot?.kind==='document' && Array.isArray(capture.snapshot.model?.blocks)) {
      const resources=capture.snapshot.model.blocks.filter(block=>block.resource).map(block=>({sourceId:block.id,...block.resource}));
      const embeddedResources=resources.filter(entry=>entry.kind==='whiteboard');
      if(embeddedResources.length) {
        try {
          const read=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:captureEmbeds,args:[{expectedSource:source.origin+source.pathname,resources:embeddedResources,warm:true}]});
          const result=read?.find(x=>x.frameId===0)?.result;
          if(result?.code==='SOURCE_CHANGED')throw Object.assign(new Error(),{stage:'CAPTURE',code:'SOURCE_CHANGED'});
          if(result?.ok&&Array.isArray(result.embeds))embeds=result.embeds;
        } catch(error){if(error?.code==='SOURCE_CHANGED')throw error;}
        await check('CAPTURE');
      }
      const baseResources=resources.filter(entry=>entry.kind==='bitable');
      if(baseResources.length){
        try{
          const read=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:captureBaseTables,args:[{expectedSource:source.origin+source.pathname,resources:baseResources}]});
          const result=read?.find(x=>x.frameId===0)?.result;
          if(result?.code==='SOURCE_CHANGED')throw Object.assign(new Error(),{stage:'CAPTURE',code:'SOURCE_CHANGED'});
          if(result?.ok&&Array.isArray(result.tables))embeds.push(...result.tables);
        }catch(error){if(error?.code==='SOURCE_CHANGED')throw error;}
        await check('CAPTURE');
      }
      if(resources.length) {
        try {
          const boardImages=embeds.flatMap(embed=>Array.isArray(embed.imageReferences)?embed.imageReferences:[]);
          assets=await readResourceQueue([...resources,...boardImages],{
            checkpoint:progress=>check('CAPTURE',{progress}),
            async read(entry,byteBudget){
              const read=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:captureResources,args:[{expectedSource:source.origin+source.pathname,resources:[entry],byteBudget}]});
              return read?.find(x=>x.frameId===0)?.result;
            }
          });
        } catch(error) {if(['SOURCE_CHANGED','TASK_CANCELLED','RESOURCE_LIMIT'].includes(error?.code))throw error;}
        await check('CAPTURE');
      }
      // Images inside native drawings are separate from document image blocks.
      // Transport only their local bytes and identity; never the observed URL.
      embeds=embeds.map(embed=>({...embed,images:(embed.imageReferences||[]).map(ref=>{
        const asset=assets.find(asset=>asset.sourceId===ref.sourceId);
        return {resourceId:ref.resourceId,status:asset?.status||'MISSING',code:asset?.code||'RESOURCE_BYTES_MISSING',...Object.fromEntries(['dataUrl','byteLength','sha256'].filter(key=>asset?.[key]!==undefined).map(key=>[key,asset[key]]))};
      })}));
    }
    stage='CONVERSION';
    await check('CONVERSION');
    let doc,text,htmlOutput;
    try { doc=importSnapshot(capture.snapshot,{assets,embeds});text=await encodeDocument(doc);if(options.jobId&&['html','both'].includes(options.format))htmlOutput=buildHtmlFile(doc); }
    catch(error) { code=conversionCodes.has(error?.message)?error.message:'CONVERSION_FAILED';throw Object.assign(new Error(),{stage,code}); }
    stage='NATIVE';
    const partial=doc.issues.some(x=>x.count>0)||!!htmlOutput?.warnings?.length;
    const hash=options.jobId?await textDigest(text):null;
    const htmlHash=htmlOutput?await textDigest(htmlOutput.html):null;
    await check('NATIVE',{partial,payloadHash:hash,htmlHash});
    let reply;
    const deliveryMessage=options.jobId?{operation:'save-task',protocolVersion:1,jobId:options.jobId,sha256:hash,text,...(htmlOutput?{html:htmlOutput.html,htmlPartial:!!htmlOutput.warnings.length}:{})}:{operation:'save',text};
    if(new TextEncoder().encode(JSON.stringify(deliveryMessage)).byteLength>=48_000_000)throw Object.assign(new Error(),{stage:'CONVERSION',code:'DOCUMENT_TOO_LARGE'});
    try { reply=await nativeCall(deliveryMessage); }
    catch(error) { code=nativeErrors.get(error?.message)||'NATIVE_CONNECTION_FAILED';throw Object.assign(new Error(),{stage,code}); }
    if(!reply||typeof reply!=='object'||typeof reply.ok!=='boolean') { code='NATIVE_REPLY_INVALID';throw Object.assign(new Error(),{stage,code}); }
    if(!reply.ok&&reply.code==='OUTPUT_PENDING')throw Object.assign(new Error(),{stage,code:'NATIVE_OUTPUT_PENDING'});
    if(!reply.ok&&reply.code==='LOCAL_DELIVERY_FAILED') { code='LOCAL_DELIVERY_FAILED';throw Object.assign(new Error(),{stage,code}); }
    if(typeof reply.status!=='string') { code='NATIVE_REPLY_INVALID';throw Object.assign(new Error(),{stage,code}); }
    if(options.jobId?(!reply.ok||reply.status!=='SAVED'||reply.protocolVersion!==1||reply.jobId!==options.jobId||reply.sha256!==hash):(!reply.ok||reply.status!=='DELIVERED')) { code='NATIVE_DELIVERY_UNCONFIRMED';throw Object.assign(new Error(),{stage,code}); }
    if(htmlOutput&&(reply.htmlSaved!==true||reply.htmlSha256!==htmlHash))throw Object.assign(new Error(),{stage,code:'NATIVE_OUTPUT_PENDING'});
    await chrome.action.setBadgeText({tabId,text:partial?'!':'✓'});
    await chrome.action.setBadgeBackgroundColor({tabId,color:partial?'#b37a13':'#258452'});
    return {ok:true,partial,message:partial?'已送到本地应用；这份文件仍有未完整读取的内容。':'已送到本地应用。',requestId:reply.requestId};
  } catch(error) {
    if(error?.code==='TASK_CANCELLED'){
      try{await chrome.action.setBadgeText({tabId,text:''});}catch{}
      return {ok:false,stage:'CAPTURE',code:'TASK_CANCELLED'};
    }
    try { await chrome.action.setBadgeText({tabId,text:'!'});await chrome.action.setBadgeBackgroundColor({tabId,color:'#bc3838'}); }catch{}
    const failedStage=['SOURCE','CAPTURE','CONVERSION','NATIVE'].includes(error?.stage)?error.stage:stage;
    const failedCode=diagnosticCodes.has(error?.code)?error.code:'SAVE_FAILED';
    return failure(failedStage,failedCode);
  } finally { jobs.delete(tabId); }
}
async function textDigest(text){
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('');
}
async function nativeCall(message){
  let timer;
  try{return await Promise.race([chrome.runtime.sendNativeMessage('cn.localdocs.bridge',message),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Native host timeout')),15000);})]);}
  finally{clearTimeout(timer);}
}
let controller;
function taskController(){
  if(!controller)controller=createTaskController({
    storage:chrome.storage.local,
    async source(tabId){
      const tab=await chrome.tabs.get(tabId),url=new URL(tab.url);
      if(url.protocol!=='https:'||url.username||url.password||!/(^|\.)(feishu\.cn|larksuite\.com)$/.test(url.hostname))throw new Error('UNSUPPORTED_SOURCE');
      const expectedSource=url.origin+url.pathname;
      return {expectedSource,sourceKey:await textDigest(expectedSource)};
    },
    run:saveTab,
    async prepare(format){
      const reply=await nativeCall({operation:'hello'});
      if(!reply?.ok||reply.protocolVersion!==1||!['save-task','query-task'].every(x=>reply.capabilities?.includes(x)))throw Object.assign(new Error(),{code:'PROTOCOL_UPGRADE'});
      if(['html','both'].includes(format)&&!reply.capabilities?.includes('html-output'))throw Object.assign(new Error(),{code:'PROTOCOL_UPGRADE'});
    },
    query:jobId=>nativeCall({operation:'query-task',protocolVersion:1,jobId})
  });
  return controller;
}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(sender.id!==chrome.runtime.id||sender.url!==chrome.runtime.getURL('popup.html')||!Number.isInteger(message?.tabId))return false;
  if(message.operation==='save-current'){saveTab(message.tabId).then(respond);return true;}
  if(!['task-current','task-start','task-cancel'].includes(message.operation))return false;
  if(message.operation==='task-cancel'&&!(typeof message.jobId==='string'&&/^[a-f0-9-]{36}$/i.test(message.jobId)))return false;
  const tasks=taskController();
  const action=message.operation==='task-current'?tasks.current(message.tabId):message.operation==='task-cancel'?tasks.cancel(message.tabId,message.jobId):tasks.start(message.tabId,{newCopy:message.newCopy===true,retry:message.retry===true,format:message.format});
  action.then(task=>respond({ok:true,task})).catch(error=>respond(error?.message==='UNSUPPORTED_SOURCE'?failure('SOURCE','UNSUPPORTED_SOURCE'):failure('TASK','TASK_STATE_UNAVAILABLE')));return true;
});

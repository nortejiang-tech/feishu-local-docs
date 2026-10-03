import { captureResources } from '../../extension/resources.mjs';
import { capturePage } from '../../extension/capture.mjs';
import { captureEmbeds } from '../../extension/embedded.mjs';
import { captureBaseTables } from '../../extension/base.mjs';
import { importSnapshot } from '../../shared/import-snapshot.mjs';
import { encodeDocument } from '../../shared/model.mjs';

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
  SAVE_FAILED:'这次保存未完成。请保留源文件，稍后重试。'
};
const captureCodes=new Set(['UNSUPPORTED_SOURCE','SOURCE_CHANGED','SLIDES_ADAPTER_PENDING','MODEL_UNAVAILABLE','CAPTURE_TIMEOUT','EMPTY_OR_UNLOADED_SHEET','MODEL_SHAPE_CHANGED','BLOCK_LIMIT','BLOCK_ID_INVALID','BLOCK_NOT_READY','CELL_RANGE_LIMIT','SHEET_LIMIT','FIELD_LIMIT','CONTENT_LIMIT','TEXT_SHAPE_CHANGED','ATTRIBUTE_LIMIT','PAYLOAD_LIMIT','PAGE_READ_FAILED']);
const conversionCodes=new Set(['IMPORT_INVALID','IMPORT_TOO_LARGE','ARCHIVE_INVALID','DOCUMENT_INVALID','DOCUMENT_TOO_LARGE','CRYPTO_UNAVAILABLE']);
const diagnosticCodes=new Set([...captureCodes,...conversionCodes,'UNSUPPORTED_SOURCE','SCRIPT_ACCESS_DENIED','EXECUTE_SCRIPT_FAILED','CAPTURE_RESULT_MISSING','CAPTURE_FAILED','CONVERSION_FAILED','NATIVE_HOST_MISSING','NATIVE_HOST_FORBIDDEN','NATIVE_HOST_START_FAILED','NATIVE_CONNECTION_FAILED','NATIVE_REPLY_INVALID','LOCAL_DELIVERY_FAILED','NATIVE_DELIVERY_UNCONFIRMED','SAVE_IN_PROGRESS','SAVE_FAILED']);
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
export async function saveTab(tabId) {
  if(jobs.has(tabId))return failure('GUARD','SAVE_IN_PROGRESS');
  jobs.add(tabId);
  let stage='SOURCE',code='SAVE_FAILED';
  try {
    const tab=await chrome.tabs.get(tabId);
    const source=new URL(tab.url);
    if(source.protocol!=='https:'||!/(^|\.)(feishu\.cn|larksuite\.com)$/.test(source.hostname))return failure('SOURCE','UNSUPPORTED_SOURCE');
    await chrome.action.setBadgeText({tabId,text:'…'});
    stage='CAPTURE';
    let result;
    try { result=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:capturePage,args:[{expectedSource:source.origin+source.pathname}]}); }
    catch(error) { code=chromeScriptErrors.get(error?.message)||'EXECUTE_SCRIPT_FAILED';throw Object.assign(new Error(),{stage,code}); }
    const capture=result?.find?.(x=>x.frameId===0)?.result;
    if(!capture||typeof capture!=='object') { code='CAPTURE_RESULT_MISSING';throw Object.assign(new Error(),{stage,code}); }
    if(!capture.ok) { code=captureCodes.has(capture.code)?capture.code:'CAPTURE_FAILED';throw Object.assign(new Error(),{stage,code}); }
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
      }
      const baseResources=resources.filter(entry=>entry.kind==='bitable');
      if(baseResources.length){
        try{
          const read=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:captureBaseTables,args:[{expectedSource:source.origin+source.pathname,resources:baseResources}]});
          const result=read?.find(x=>x.frameId===0)?.result;
          if(result?.code==='SOURCE_CHANGED')throw Object.assign(new Error(),{stage:'CAPTURE',code:'SOURCE_CHANGED'});
          if(result?.ok&&Array.isArray(result.tables))embeds.push(...result.tables);
        }catch(error){if(error?.code==='SOURCE_CHANGED')throw error;}
      }
      if(resources.length) {
        try {
          const boardImages=embeds.flatMap(embed=>Array.isArray(embed.imageReferences)?embed.imageReferences:[]);
          const read=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:captureResources,args:[{expectedSource:source.origin+source.pathname,resources:[...resources,...boardImages]}]});
          const result=read?.find(x=>x.frameId===0)?.result;
          if(result?.code==='SOURCE_CHANGED')throw Object.assign(new Error(),{stage:'CAPTURE',code:'SOURCE_CHANGED'});
          if(result?.ok && Array.isArray(result.assets))assets=result.assets;
        } catch(error) {if(error?.code==='SOURCE_CHANGED')throw error;}
      }
      // Images inside native drawings are separate from document image blocks.
      // Transport only their local bytes and identity; never the observed URL.
      embeds=embeds.map(embed=>({...embed,images:(embed.imageReferences||[]).map(ref=>{
        const asset=assets.find(asset=>asset.sourceId===ref.sourceId);
        return {resourceId:ref.resourceId,status:asset?.status||'MISSING',code:asset?.code||'RESOURCE_BYTES_MISSING',...Object.fromEntries(['dataUrl','byteLength','sha256'].filter(key=>asset?.[key]!==undefined).map(key=>[key,asset[key]]))};
      })}));
    }
    stage='CONVERSION';
    let doc,text;
    try { doc=importSnapshot(capture.snapshot,{assets,embeds});text=await encodeDocument(doc); }
    catch(error) { code=conversionCodes.has(error?.message)?error.message:'CONVERSION_FAILED';throw Object.assign(new Error(),{stage,code}); }
    stage='NATIVE';
    let reply;
    try { reply=await chrome.runtime.sendNativeMessage('cn.localdocs.bridge',{operation:'save',text}); }
    catch(error) { code=nativeErrors.get(error?.message)||'NATIVE_CONNECTION_FAILED';throw Object.assign(new Error(),{stage,code}); }
    if(!reply||typeof reply!=='object'||typeof reply.ok!=='boolean') { code='NATIVE_REPLY_INVALID';throw Object.assign(new Error(),{stage,code}); }
    if(!reply.ok&&reply.code==='LOCAL_DELIVERY_FAILED') { code='LOCAL_DELIVERY_FAILED';throw Object.assign(new Error(),{stage,code}); }
    if(typeof reply.status!=='string') { code='NATIVE_REPLY_INVALID';throw Object.assign(new Error(),{stage,code}); }
    if(!reply.ok||reply.status!=='DELIVERED') { code='NATIVE_DELIVERY_UNCONFIRMED';throw Object.assign(new Error(),{stage,code}); }
    const partial=doc.issues.some(x=>x.count>0);
    await chrome.action.setBadgeText({tabId,text:partial?'!':'✓'});
    await chrome.action.setBadgeBackgroundColor({tabId,color:partial?'#b37a13':'#258452'});
    return {ok:true,partial,message:partial?'已送到本地应用；这份文件仍有未完整读取的内容。':'已送到本地应用。',requestId:reply.requestId};
  } catch(error) {
    try { await chrome.action.setBadgeText({tabId,text:'!'});await chrome.action.setBadgeBackgroundColor({tabId,color:'#bc3838'}); }catch{}
    const failedStage=['SOURCE','CAPTURE','CONVERSION','NATIVE'].includes(error?.stage)?error.stage:stage;
    const failedCode=diagnosticCodes.has(error?.code)?error.code:'SAVE_FAILED';
    return failure(failedStage,failedCode);
  } finally { jobs.delete(tabId); }
}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(sender.id!==chrome.runtime.id||sender.url!==chrome.runtime.getURL('popup.html')||message?.operation!=='save-current'||!Number.isInteger(message.tabId))return false;
  saveTab(message.tabId).then(respond);return true;
});

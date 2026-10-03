import {validateBasePayload} from './base-data.mjs';
// Preserve native drawing data without treating it as executable HTML or SVG.
const denied=new Set(['proto','prototype','constructor','authorization','cookie','setcookie','password','accesstoken','refreshtoken','apikey','secret','credentials','headers','auth','session','cipherkey','encryptionkey','bearertoken']);
function fail(){throw Error('IMPORT_INVALID');}
function check(value,depth=0,budget={count:0}) {
  if(depth>48||++budget.count>100000)fail();
  if(value===null||typeof value==='boolean')return;
  if(typeof value==='number'){if(!Number.isFinite(value))fail();return;}
  if(typeof value==='string'){if(value.length>2000000||/[?&](?:access[_-]?token|refresh[_-]?token|signature|credential|api[_-]?key|auth|token|ticket|session|cipher[_-]?key)=/i.test(value))fail();return;}
  if(Array.isArray(value)){for(const item of value)check(item,depth+1,budget);return;}
  if(!value||typeof value!=='object')fail();
  for(const [key,item] of Object.entries(value)){if(denied.has(key.toLowerCase().replace(/[_-]/g,'')))fail();check(item,depth+1,budget);}
}
export function validateWhiteboardPayload(payload) {
  if(payload?.format!=='feishu-whiteboard-page-detail'||Object.keys(payload).some(key=>!['format','nodes','meta'].includes(key))||!Array.isArray(payload.nodes)||payload.nodes.length>20000||!payload.meta||typeof payload.meta!=='object'||Array.isArray(payload.meta))fail();
  if(Object.keys(payload.meta).some(key=>!['version','appliedVersion','theme','templateType'].includes(key)))fail();
  check(payload);
  if(new TextEncoder().encode(JSON.stringify(payload)).byteLength>6*1024*1024)fail();
}
export function validateWhiteboardImages(images=[]) {
  if(!Array.isArray(images)||images.length>200)fail();
  const seen=new Set();let total=0;
  for(const image of images) {
    if(!image||typeof image.resourceId!=='string'||!/^[-\w]{1,128}$/.test(image.resourceId)||seen.has(image.resourceId)||!['MISSING','PREVIEW','ORIGINAL_CANDIDATE'].includes(image.status)||typeof image.code!=='string'||!/^[A-Z_]{1,128}$/.test(image.code))fail();
    seen.add(image.resourceId);
    if(image.dataUrl!==undefined) {
      if(!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]*={0,2}$/.test(image.dataUrl)||image.dataUrl.length>8000000||!Number.isSafeInteger(image.byteLength)||image.byteLength<1||image.byteLength>6*1024*1024||!/^[a-f0-9]{64}$/.test(image.sha256))fail();
      total+=image.byteLength;
    } else if(image.status!=='MISSING')fail();
  }
  if(total>14*1024*1024)fail();
}
export function validateCapturedEmbeds(snapshot,embeds=[]) {
  if(!Array.isArray(embeds)||embeds.length>200)fail();
  const blocks=new Map((snapshot?.model?.blocks||[]).map(block=>[block.id,block])),seen=new Set(),out=[];
  let total=0;
  for(const entry of embeds) {
    if(!entry||typeof entry.sourceId!=='string'||seen.has(entry.sourceId)||!['whiteboard','bitable'].includes(entry.kind)||!['MISSING','STRUCTURE_CANDIDATE','VIEW_SNAPSHOT'].includes(entry.status)||typeof entry.code!=='string'||!/^[A-Z_]{1,128}$/.test(entry.code))fail();
    seen.add(entry.sourceId);
    const block=blocks.get(entry.sourceId);
    if(block?.type!==entry.kind)fail();
    const result={sourceId:entry.sourceId,kind:entry.kind,status:entry.status,code:entry.code};
    if(entry.status==='VIEW_SNAPSHOT'){
      if(entry.kind!=='bitable')fail();validateBasePayload(entry.payload);
      if(typeof block.resource?.resourceId!=='string'||!block.resource.resourceId.endsWith('_'+entry.payload.table.meta.id))fail();
      const bytes=new TextEncoder().encode(JSON.stringify(entry.payload)).byteLength;
      if(bytes!==entry.byteLength||!/^[a-f0-9]{64}$/.test(entry.sha256))fail();
      const counts=entry.counts;
      if(!counts||Object.keys(counts).some(k=>!['fields','records','views','declaredRecords','metaRecords'].includes(k)))fail();
      for(const[key,value]of Object.entries(counts))if(!Number.isSafeInteger(value)||value<0){if(!['declaredRecords','metaRecords'].includes(key)||value!==null)fail();}
      if(counts.fields!==Object.keys(entry.payload.table.fieldMap).length||counts.records!==Object.keys(entry.payload.table.recordMap).length||counts.views!==entry.payload.table.views.length)fail();
      total+=bytes;if(total>14*1024*1024)fail();
      Object.assign(result,{payload:JSON.parse(JSON.stringify(entry.payload)),byteLength:bytes,sha256:entry.sha256,counts:{...counts}});
      out.push(result);continue;
    }
    if(entry.status==='STRUCTURE_CANDIDATE') {
      const payload=entry.payload;
      if(entry.kind!=='whiteboard')fail();
      validateWhiteboardPayload(payload);
      const bytes=new TextEncoder().encode(JSON.stringify(payload)).byteLength;
      if(bytes!==entry.byteLength||bytes>6*1024*1024||!/^[a-f0-9]{64}$/.test(entry.sha256)||!Number.isSafeInteger(entry.resourceCount)||entry.resourceCount<0||entry.resourceCount>20000)fail();
      total+=bytes;if(total>14*1024*1024)fail();
      const images=entry.images||[];validateWhiteboardImages(images);
      total+=images.reduce((sum,image)=>sum+(image.byteLength||0),0);if(total>14*1024*1024)fail();
      const copiedImages=images.map(image=>Object.fromEntries(['resourceId','status','code','dataUrl','byteLength','sha256'].filter(key=>image[key]!==undefined).map(key=>[key,image[key]])));
      Object.assign(result,{payload:JSON.parse(JSON.stringify(payload)),images:copiedImages,byteLength:bytes,sha256:entry.sha256,resourceCount:entry.resourceCount});
    } else if(entry.payload!==undefined)fail();
    out.push(result);
  }
  return out;
}

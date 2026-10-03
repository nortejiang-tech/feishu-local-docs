// Self-contained MAIN-world reader. Uses only observed same-service resource
// URLs; no page strings are executed, no auth/storage state is read or exported.
export async function captureResources(options = {}) {
  const source = location.origin + location.pathname;
  if (source !== options.expectedSource) return {ok:false,code:'SOURCE_CHANGED'};
  const resources = options.resources;
  if (!Array.isArray(resources) || resources.length > 200) return {ok:false,code:'RESOURCE_LIMIT'};
  const idPattern=/^[A-Za-z0-9_-]{1,128}$/;
  const allowedMime=/^image\/(?:png|jpeg|webp)$/;
  const started=Date.now(), assets=[], issues=[];
  let total=0;
  const maxBytes=6*1024*1024, totalLimit=14*1024*1024;
  const urls=[];
  try {
    for (const img of document.querySelectorAll('img')) if (typeof img.currentSrc==='string') urls.push(img.currentSrc);
    for (const item of performance.getEntriesByType('resource')) if (typeof item.name==='string') urls.push(item.name);
  } catch {}
  function allowedURL(raw,id,coverOnly=false) {
    try {
      const u=new URL(raw);
      if(u.protocol!=='https:' || u.username || u.password || u.hash || u.hostname!=='internal-api-drive-stream.feishu.cn')return null;
      const bits=u.pathname.split('/').filter(Boolean);
      // This preview path was observed in native whiteboard image fills. The
      // object identity must match; only its observed preview_type=16 is valid.
      if(!coverOnly&&bits.slice(0,6).join('/')==='space/api/box/stream/download/preview'&&bits.length===7&&bits[6]===id) {
        if(u.search!=='?preview_type=16')return null;
        return {url:u,cover:true};
      }
      if(bits.slice(0,6).join('/')!=='space/api/box/stream/download/v2')return null;
      const cover=bits[6]==='cover';
      if(coverOnly&&!cover || bits.length!==(cover?8:7) || bits[cover?7:6]!==id)return null;
      for(const [key,value] of u.searchParams) {
        // mount_node_token is the document mount reference observed in the
        // page's own image URLs. It is retained only from that same-page URL;
        // no authentication token or arbitrary query parameter is accepted.
        if(!['width','height','policy','mount_point','mount_node_token','fallback_source'].includes(key) || value.length>128 || !/^[A-Za-z0-9_.-]*$/.test(value))return null;
      }
      return {url:u,cover};
    } catch{return null;}
  }
  const template=urls.map(raw=>{try {const u=new URL(raw),bits=u.pathname.split('/').filter(Boolean);return allowedURL(raw,bits.at(-1),true);}catch{return null;}}).find(Boolean);
  function magic(bytes,mime) {
    if(mime==='image/png')return bytes.length>=8&&[137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v);
    if(mime==='image/jpeg')return bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
    if(mime==='image/webp')return bytes.length>=12&&String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&String.fromCharCode(...bytes.slice(8,12))==='WEBP';
    return false;
  }
  async function nativeImage(entry) {
    // The page already uses this reader for high-definition image display.
    // Only its same-origin object URL is consumed; CDN URLs, credentials,
    // decrypt keys and diagnostic response fields never cross the boundary.
    const models=globalThis.window?.PageMain?.editor?.editor?.api?.modelService?.allBlockModels;
    if(!Array.isArray(models)||models.length>20000)return null;
    let block;
    for(let i=0;i<models.length;i++)if(models[i]?.struct?.record?.id===entry.sourceId){block=models[i];break;}
    const image=block?.struct?.record?.snapshot?.image;
    if(block?.type!=='image'||image?.token!==entry.resourceId||typeof block?.imageManager?.fetch!=='function')return null;
    let timer;
    try {
      const value=await new Promise((resolve,reject)=>{
        timer=setTimeout(()=>reject(new Error('NATIVE_IMAGE_TIMEOUT')),10000);
        const task=block.imageManager.fetch({uuid:entry.sourceId,token:entry.resourceId,isHD:true,fuzzy:false,mimeType:entry.mimeType,width:entry.width,height:entry.height,scale:entry.scale},undefined,resolve);
        if(task&&typeof task.catch==='function')task.catch(reject);
      });
      if(typeof value?.src!=='string'||!value.src.startsWith('blob:'+location.origin+'/'))return null;
      return {url:value.src,cover:true,native:true};
    } catch {return null;} finally {clearTimeout(timer);}
  }
  for (const entry of resources) {
    if(location.origin+location.pathname!==source)return {ok:false,code:'SOURCE_CHANGED'};
    if(!entry || typeof entry.sourceId!=='string' || entry.sourceId.length>256 || typeof entry.resourceId!=='string' || !idPattern.test(entry.resourceId))return {ok:false,code:'RESOURCE_DESCRIPTOR_INVALID'};
    const asset={sourceId:entry.sourceId,kind:entry.kind,status:'MISSING'};
    if(entry.kind!=='image') {asset.code='EMBEDDED_ADAPTER_PENDING';assets.push(asset);continue;}
    if(Date.now()-started>70000) {asset.code='RESOURCE_CAPTURE_TIMEOUT';assets.push(asset);continue;}
    const observed=typeof entry.observedPreview==='string'?allowedURL(entry.observedPreview,entry.resourceId):null;
    let candidates=[...(observed?[observed]:[]),...urls.map(raw=>allowedURL(raw,entry.resourceId)).filter(Boolean)].sort((a,b)=>Number(a.cover)-Number(b.cover));
    if(!candidates.length && template) {
      const u=new URL(template.url.href);u.pathname='/space/api/box/stream/download/v2/cover/'+entry.resourceId+'/';
      for(const key of ['width','height']) if(Number.isFinite(entry[key])&&entry[key]>0&&entry[key]<=10000)u.searchParams.set(key,String(Math.ceil(entry[key])));
      candidates=[{url:u,cover:true}];
    }
    const native=await nativeImage(entry);
    if(native)candidates.unshift(native);
    if(!candidates.length) {asset.code='RESOURCE_URL_UNAVAILABLE';assets.push(asset);continue;}
    if(location.origin+location.pathname!==source)return {ok:false,code:'SOURCE_CHANGED'};
    const selected=candidates[0], controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),12000);
    try {
      const response=await fetch(selected.native?selected.url:selected.url.href,{credentials:selected.native?'omit':'include',redirect:'error',signal:controller.signal});
      if(!response.ok)throw new Error(response.status===403?'RESOURCE_PERMISSION_DENIED':'RESOURCE_HTTP_FAILED');
      const mime=(response.headers.get('content-type')||'').split(';')[0].toLowerCase();
      const length=Number(response.headers.get('content-length')||0);
      if(!allowedMime.test(mime))throw new Error('RESOURCE_MIME_UNSUPPORTED');
      if(length>maxBytes || total+length>totalLimit)throw new Error('RESOURCE_BYTE_LIMIT');
      if(!response.body?.getReader)throw new Error('RESOURCE_BODY_UNAVAILABLE');
      const reader=response.body.getReader(),chunks=[];let size=0;
      try {
        while(true) {
          const part=await reader.read();if(part.done)break;
          size+=part.value.byteLength;
          if(size>maxBytes || total+size>totalLimit) {await reader.cancel();throw new Error('RESOURCE_BYTE_LIMIT');}
          chunks.push(part.value);
        }
      } finally {reader.releaseLock();}
      const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
      if(!magic(bytes,mime))throw new Error('RESOURCE_SIGNATURE_INVALID');
      let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
      const digest=await crypto.subtle.digest('SHA-256',bytes);
      asset.sha256=Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
      asset.dataUrl='data:'+mime+';base64,'+btoa(binary);asset.byteLength=size;
      const candidate=selected.native?Number.isInteger(entry.size)&&entry.size===size:!selected.cover;
      asset.status=candidate?'ORIGINAL_CANDIDATE':'PREVIEW';
      asset.code=candidate?'RESOURCE_ORIGINAL_UNVERIFIED':'RESOURCE_PREVIEW_ONLY';
      if(!selected.native&&!selected.cover&&Number.isFinite(entry.size)&&size!==entry.size)asset.code='RESOURCE_SIZE_MISMATCH';
      total+=size;
    } catch(error) {
      const codes=new Set(['RESOURCE_PERMISSION_DENIED','RESOURCE_HTTP_FAILED','RESOURCE_MIME_UNSUPPORTED','RESOURCE_BYTE_LIMIT','RESOURCE_BODY_UNAVAILABLE','RESOURCE_SIGNATURE_INVALID']);
      asset.code=controller.signal.aborted?'RESOURCE_CAPTURE_TIMEOUT':codes.has(error?.message)?error.message:'RESOURCE_READ_FAILED';
    } finally {clearTimeout(timer);}
    assets.push(asset);
  }
  if(location.origin+location.pathname!==source)return {ok:false,code:'SOURCE_CHANGED'};
  for(const asset of assets)if(asset.code)issues.push({code:asset.code,sourceId:asset.sourceId});
  return {ok:true,assets,issues};
}

// MAIN-world reader for the native whiteboard model. The export is data only:
// SVG strings are preserved in JSON and are never executed or inserted into DOM.
export async function captureEmbeds(options={}) {
  const source=location.origin+location.pathname;
  if(source!==options.expectedSource)return {ok:false,code:'SOURCE_CHANGED'};
  if(!Array.isArray(options.resources)||options.resources.length>200)return {ok:false,code:'RESOURCE_LIMIT'};
  const models=globalThis.window?.PageMain?.editor?.editor?.api?.modelService?.allBlockModels;
  if(!Array.isArray(models)||models.length>20000)return {ok:false,code:'EMBEDDED_MODEL_UNAVAILABLE'};
  const byId=new Map();
  for(let i=0;i<models.length;i++)if(typeof models[i]?.struct?.record?.id==='string')byId.set(models[i].struct.record.id,models[i]);
  const results=new Map(),started=Date.now(),done=new Set();
  const forbidden=new Set(['proto','prototype','constructor','authorization','cookie','setcookie','password','accesstoken','refreshtoken','apikey','secret','credentials','headers','auth','session','cipherkey','encryptionkey','bearertoken']);
  function copy(value,depth=0,budget={count:0}) {
    if(depth>48||++budget.count>100000)throw Error('EMBEDDED_DATA_LIMIT');
    if(value===null||typeof value==='boolean')return value;
    if(typeof value==='number'){if(!Number.isFinite(value))throw Error('EMBEDDED_FORMAT_UNSUPPORTED');return value;}
    if(typeof value==='string') {
      if(value.length>2000000)throw Error('EMBEDDED_DATA_LIMIT');
      if(/[?&](?:access[_-]?token|refresh[_-]?token|signature|credential|api[_-]?key|auth|token|ticket|session|cipher[_-]?key)=/i.test(value))throw Error('EMBEDDED_SENSITIVE_FIELD');
      return value;
    }
    if(Array.isArray(value)){const out=[];for(let i=0;i<value.length;i++)out.push(copy(value[i],depth+1,budget));return out;}
    if(!value||typeof value!=='object')throw Error('EMBEDDED_FORMAT_UNSUPPORTED');
    const out=Object.create(null);
    for(const key of Object.keys(value)) {
      if(forbidden.has(key.toLowerCase().replace(/[_-]/g,'')))throw Error('EMBEDDED_SENSITIVE_FIELD');
      out[key]=copy(value[key],depth+1,budget);
    }
    return out;
  }
  for(const entry of options.resources) {
    if(typeof entry?.sourceId!=='string'||!/^[-\w]{1,256}$/.test(entry.sourceId)||typeof entry.resourceId!=='string'||!/^[-\w]{1,256}$/.test(entry.resourceId)||results.has(entry.sourceId)||!['whiteboard','bitable'].includes(entry.kind))return {ok:false,code:'RESOURCE_DESCRIPTOR_INVALID'};
    results.set(entry.sourceId,{sourceId:entry.sourceId,kind:entry.kind,status:'MISSING',code:entry.kind==='whiteboard'?'WHITEBOARD_NOT_LOADED':'EMBEDDED_ADAPTER_PENDING'});
  }
  async function scan() {
    for(const entry of options.resources) {
      if(location.origin+location.pathname!==source)throw Error('SOURCE_CHANGED');
      const old=results.get(entry.sourceId);
      if(entry.kind!=='whiteboard'||done.has(entry.sourceId))continue;
      const block=byId.get(entry.sourceId),whiteboard=block?.whiteboardBlock;
      if(block?.type!=='whiteboard'||block.struct?.record?.snapshot?.token!==entry.resourceId)continue;
      const proxy=whiteboard?.appProxy;
      if(proxy?.isDestroy||typeof proxy?.serializeData!=='function')continue;
      try {
        const before=typeof whiteboard.abilityKit?.getCurrentSeq==='function'?whiteboard.abilityKit.getCurrentSeq():null;
        // The observed native method is synchronous. A changed implementation
        // must not hold the extension's save job open indefinitely.
        let timer;
        const text=await Promise.race([Promise.resolve(proxy.serializeData()),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('EMBEDDED_READ_TIMEOUT')),5000);})]).finally(()=>clearTimeout(timer));
        if(typeof text!=='string')continue;
        if(new TextEncoder().encode(text).byteLength>6*1024*1024)throw Error('EMBEDDED_DATA_LIMIT');
        const raw=JSON.parse(text);
        if(!Array.isArray(raw.nodes)||raw.nodes.length>20000||!raw.meta||typeof raw.meta!=='object'||Array.isArray(raw.meta))throw Error('EMBEDDED_FORMAT_UNSUPPORTED');
        const meta={};for(const key of ['version','appliedVersion','theme','templateType'])if(raw.meta[key]!==undefined)meta[key]=copy(raw.meta[key]);
        const payload={format:'feishu-whiteboard-page-detail',nodes:copy(raw.nodes),meta};
        const imageReferences=[],imageKeys=new Set(),walk=[...payload.nodes];
        while(walk.length) {
          const node=walk.pop();
          if(Array.isArray(node?.children))for(const child of node.children)if(child&&typeof child==='object')walk.push(child);
          const fills=node?.info?.fillV2?.fillStyleList?.data;
          if(!Array.isArray(fills))continue;
          for(const fill of fills) {
            const item=fill?.imageFillItem,id=item?.resource?.key;
            if(typeof id!=='string'||!/^[-\w]{1,128}$/.test(id)||imageKeys.has(id))continue;
            imageKeys.add(id);
            try {
              const url=new URL(item.imageUrl,location.href);
              if(url.protocol!=='https:'||url.hostname!=='internal-api-drive-stream.feishu.cn'||url.username||url.password||url.hash||url.pathname!=='/space/api/box/stream/download/preview/'+id||url.search!=='?preview_type=16')continue;
              imageReferences.push({sourceId:entry.sourceId+'-'+id,kind:'image',resourceId:id,observedPreview:url.href});
            }catch{}
          }
        }
        const after=typeof whiteboard.abilityKit?.getCurrentSeq==='function'?whiteboard.abilityKit.getCurrentSeq():null;
        if((typeof before==='string'||typeof before==='number')&&before!==after)throw Error('EMBEDDED_SOURCE_CHANGED');
        const encoded=new TextEncoder().encode(JSON.stringify(payload));
        if(encoded.byteLength>6*1024*1024)throw Error('EMBEDDED_DATA_LIMIT');
        const digest=await crypto.subtle.digest('SHA-256',encoded);
        results.set(entry.sourceId,{sourceId:entry.sourceId,kind:'whiteboard',status:'STRUCTURE_CANDIDATE',code:'WHITEBOARD_EDITOR_PENDING',payload,byteLength:encoded.byteLength,sha256:Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join(''),resourceCount:Math.max(imageKeys.size,Array.isArray(raw.resources)?raw.resources.length:0),imageReferences});
        done.add(entry.sourceId);
      } catch(error) {
        const allowed=['EMBEDDED_DATA_LIMIT','EMBEDDED_FORMAT_UNSUPPORTED','EMBEDDED_SENSITIVE_FIELD','EMBEDDED_SOURCE_CHANGED','EMBEDDED_READ_TIMEOUT'];
        results.set(entry.sourceId,{...old,code:allowed.includes(error?.message)?error.message:'EMBEDDED_READ_FAILED'});
        done.add(entry.sourceId);
      }
    }
  }
  let scroller=null,originalTop=0;
  try {
    await scan();
    if(options.warm===true&&options.resources.some(e=>e.kind==='whiteboard'&&!done.has(e.sourceId))) {
      let element=document.querySelector('.page-block');
      for(let depth=0;element&&depth<24;depth++,element=element.parentElement) {
        const overflow=getComputedStyle(element).overflowY;
        if(element.scrollHeight>element.clientHeight&&element.clientHeight>0&&['auto','scroll'].includes(overflow)){scroller=element;break;}
      }
      if(!scroller&&document.scrollingElement?.scrollHeight>document.scrollingElement.clientHeight)scroller=document.scrollingElement;
      if(scroller) {
        originalTop=scroller.scrollTop;
        let position=0;
        for(let step=0;step<240&&Date.now()-started<90000;step++) {
          if(location.origin+location.pathname!==source)throw Error('SOURCE_CHANGED');
          scroller.scrollTop=position;
          await new Promise(resolve=>setTimeout(resolve,300));
          await scan();
          if(!options.resources.some(e=>e.kind==='whiteboard'&&!done.has(e.sourceId)))break;
          const end=Math.max(0,scroller.scrollHeight-scroller.clientHeight);
          if(position>=end)break;
          position=Math.min(end,position+Math.max(1,Math.floor(scroller.clientHeight*0.7)));
        }
      }
    }
  } catch(error) {if(error?.message==='SOURCE_CHANGED')return {ok:false,code:'SOURCE_CHANGED'};}
  finally {if(scroller&&location.origin+location.pathname===source)scroller.scrollTop=originalTop;}
  if(location.origin+location.pathname!==source)return {ok:false,code:'SOURCE_CHANGED'};
  return {ok:true,embeds:Array.from(results.values())};
}

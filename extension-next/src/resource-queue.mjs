const TRANSIENT=new Set(['RESOURCE_READ_FAILED','RESOURCE_CAPTURE_TIMEOUT','RESOURCE_HTTP_FAILED']);
// The injected reader retains origin/URL/MIME guards. This layer only schedules
// bounded work and never writes page content or persists document bytes.
export async function readResourceQueue(resources,{read,checkpoint=async()=>{},now=()=>Date.now(),maxDuration=180000,byteBudget=14*1024*1024}={}){
  if(!Array.isArray(resources)||resources.length>200)throw Object.assign(new Error(),{code:'RESOURCE_LIMIT'});
  const started=now(),assets=[];let bytes=0;
  for(let index=0;index<resources.length;index++){
    await checkpoint({completed:index,total:resources.length});
    const entry=resources[index];
    let asset={sourceId:entry.sourceId,kind:entry.kind,status:'MISSING',code:'EMBEDDED_ADAPTER_PENDING'};
    if(entry.kind==='image'){
      if(now()-started>=maxDuration)asset.code='RESOURCE_CAPTURE_TIMEOUT';
      else if(bytes>=byteBudget)asset.code='RESOURCE_BYTE_LIMIT';
      else for(let attempt=0;attempt<2;attempt++){
        let reply;
        try{reply=await read(entry,byteBudget-bytes);}catch{reply=null;}
        if(reply?.code==='SOURCE_CHANGED')throw Object.assign(new Error(),{stage:'CAPTURE',code:'SOURCE_CHANGED'});
        const received=reply?.ok&&Array.isArray(reply.assets)?reply.assets.find(a=>a.sourceId===entry.sourceId):null;
        asset=received||{...asset,code:'RESOURCE_READ_FAILED'};
        if(asset.dataUrl){
          if(!Number.isSafeInteger(asset.byteLength)||asset.byteLength<0||bytes+asset.byteLength>byteBudget){asset={sourceId:entry.sourceId,kind:entry.kind,status:'MISSING',code:'RESOURCE_BYTE_LIMIT'};}
          else bytes+=asset.byteLength;
          break;
        }
        if(!TRANSIENT.has(asset.code)||now()-started>=maxDuration)break;
        await checkpoint({completed:index,total:resources.length});
      }
    }
    assets.push(asset);
  }
  await checkpoint({completed:resources.length,total:resources.length});
  return assets;
}

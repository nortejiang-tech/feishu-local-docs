// Reads the already observed native Base preload response. No guessed endpoint,
// authentication or permission changes. Captures business data, not a fidelity verdict.
export async function captureBaseTables(options={}) {
  const source=location.origin+location.pathname;
  if(source!==options.expectedSource)return {ok:false,code:'SOURCE_CHANGED'};
  if(!Array.isArray(options.resources)||options.resources.length>100)return {ok:false,code:'RESOURCE_LIMIT'};
  const models=window?.PageMain?.editor?.editor?.api?.modelService?.allBlockModels;
  if(!Array.isArray(models)||models.length>20000)return {ok:false,code:'EMBEDDED_MODEL_UNAVAILABLE'};
  const denied=new Set(['proto','prototype','constructor','authorization','cookie','setcookie','password','accesstoken','refreshtoken','apikey','secret','credentials','headers','auth','session','cipherkey','encryptionkey','bearertoken']);
  function copy(v,depth=0,budget={count:0}) {
    if(depth>48||++budget.count>150000)throw Error('BASE_DATA_LIMIT');
    if(v===null||typeof v==='boolean')return v;
    if(typeof v==='number'){if(!Number.isFinite(v))throw Error('BASE_FORMAT_UNSUPPORTED');return v;}
    if(typeof v==='string'){if(v.length>2000000)throw Error('BASE_DATA_LIMIT');if(/[?&](?:access[_-]?token|refresh[_-]?token|signature|credential|api[_-]?key|auth|token|ticket|session|cipher[_-]?key)=/i.test(v))throw Error('BASE_SENSITIVE_FIELD');return v;}
    if(Array.isArray(v)){const out=[];for(let i=0;i<v.length;i++)out.push(copy(v[i],depth+1,budget));return out;}
    if(!v||typeof v!=='object')throw Error('BASE_FORMAT_UNSUPPORTED');
    const out=Object.create(null);for(const key of Object.keys(v)){if(denied.has(key.toLowerCase().replace(/[_-]/g,'')))throw Error('BASE_SENSITIVE_FIELD');out[key]=copy(v[key],depth+1,budget);}return out;
  }
  const results=[],seen=new Set();let totalBytes=0;
  const start=Date.now();
  for(const entry of options.resources) {
    if(typeof entry?.sourceId!=='string'||!/^[-\w]{1,256}$/.test(entry.sourceId)||typeof entry.resourceId!=='string'||!/^[-\w]{1,128}$/.test(entry.resourceId)||seen.has(entry.sourceId))return {ok:false,code:'RESOURCE_DESCRIPTOR_INVALID'};
    seen.add(entry.sourceId);
    const row={sourceId:entry.sourceId,kind:'bitable',status:'MISSING',code:'BASE_MODEL_UNAVAILABLE'};
    if(Date.now()-start>70000){row.code='BASE_READ_TIMEOUT';results.push(row);continue;}
    let block;for(let i=0;i<models.length;i++)if(models[i]?.struct?.record?.id===entry.sourceId){block=models[i];break;}
    if(block?.type!=='bitable'||block.struct.record.snapshot?.token!==entry.resourceId||typeof block.preloadClientvar!=='function'){results.push(row);continue;}
    try {
      let timer;const data=await Promise.race([Promise.resolve(block.preloadClientvar()),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('BASE_READ_TIMEOUT')),15000);})]).finally(()=>clearTimeout(timer));
      if(location.origin+location.pathname!==source)return {ok:false,code:'SOURCE_CHANGED'};
      const t=data?.snapshot?.data?.table;
      if(!t||!t.meta||!t.fieldMap||!t.recordMap||!Array.isArray(t.views)||!t.viewMap||typeof t.meta.id!=='string'||!entry.resourceId.endsWith('_'+t.meta.id))throw Error('BASE_FORMAT_UNSUPPORTED');
      if(Object.keys(t.fieldMap).length>500||Object.keys(t.recordMap).length>10000||t.views.length>100)throw Error('BASE_DATA_LIMIT');
      const table={meta:copy(Object.fromEntries(['id','rev','schemaVersion','recordsNum'].filter(key=>t.meta[key]!==undefined).map(key=>[key,t.meta[key]]))),views:copy(t.views),fieldMap:copy(t.fieldMap),recordMap:Object.create(null),viewMap:Object.create(null)};
      // Cell authors, user profiles and access controls are not document values.
      for(const [recordId,record] of Object.entries(t.recordMap)){
        if(!/^[-\w]{1,128}$/.test(recordId)||!record||typeof record!=='object'||Array.isArray(record))throw Error('BASE_FORMAT_UNSUPPORTED');
        const cells=Object.create(null);
        for(const [fieldId,cell] of Object.entries(record)){
          if(!Object.hasOwn(t.fieldMap,fieldId)||!/^[-\w]{1,128}$/.test(fieldId))throw Error('BASE_FORMAT_UNSUPPORTED');
          // Review all cell data before excluding irrelevant metadata.
          copy(cell);
          cells[fieldId]={value:copy(cell?.value===undefined?null:cell.value)};
        }
        table.recordMap[recordId]=cells;
      }
      if(t.rankInfo) table.rankInfo=copy(Object.fromEntries(['rankMap','viewRankMap','nextRank'].filter(key=>t.rankInfo[key]!==undefined).map(key=>[key,t.rankInfo[key]])));
      if(typeof t.currentView==='string')table.currentView=t.currentView;
      if(typeof t.primaryKey==='string')table.primaryKey=t.primaryKey;
      for(const id of t.views) {
        if(typeof id!=='string'||!/^[-\w]{1,128}$/.test(id)||!t.viewMap[id])throw Error('BASE_FORMAT_UNSUPPORTED');
        const view=t.viewMap[id];table.viewMap[id]=copy(Object.fromEntries(['id','name','type','property'].filter(key=>view[key]!==undefined).map(key=>[key,view[key]])));
      }
      const payload={format:'feishu-bitable-table',table,sourceTimezone:Intl.DateTimeFormat().resolvedOptions().timeZone};
      copy(payload);const encoded=new TextEncoder().encode(JSON.stringify(payload));
      if(encoded.byteLength>6*1024*1024||totalBytes+encoded.byteLength>14*1024*1024)throw Error('BASE_DATA_LIMIT');
      totalBytes+=encoded.byteLength;
      const counts={fields:Object.keys(table.fieldMap).length,records:Object.keys(table.recordMap).length,views:table.views.length,declaredRecords:Number.isSafeInteger(t.recordCount)&&t.recordCount>=0?t.recordCount:null,metaRecords:Number.isSafeInteger(t.meta.recordsNum)&&t.meta.recordsNum>=0?t.meta.recordsNum:null};
      const hash=await crypto.subtle.digest('SHA-256',encoded);
      Object.assign(row,{status:'VIEW_SNAPSHOT',code:'BASE_EDITOR_AND_COVERAGE_PENDING',payload,counts,byteLength:encoded.byteLength,sha256:Array.from(new Uint8Array(hash),x=>x.toString(16).padStart(2,'0')).join('')});
    }catch(e){row.code=['BASE_DATA_LIMIT','BASE_FORMAT_UNSUPPORTED','BASE_SENSITIVE_FIELD','BASE_READ_TIMEOUT'].includes(e?.message)?e.message:'BASE_READ_FAILED';}
    results.push(row);
  }
  if(location.origin+location.pathname!==source)return {ok:false,code:'SOURCE_CHANGED'};
  return {ok:true,tables:results};
}

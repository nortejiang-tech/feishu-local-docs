// Base native business payload validator. Nothing here grants network access.
const identity=/^[-\w]{1,128}$/;
const isId=v=>typeof v==='string'&&identity.test(v);
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const denied=new Set(['proto','prototype','constructor','authorization','cookie','setcookie','password','accesstoken','refreshtoken','apikey','secret','credentials','headers','auth','session','cipherkey','encryptionkey','bearertoken','usermap','permissions','tableperm','commentmap']);
const fail=()=>{throw Error('IMPORT_INVALID');};
function check(value,depth=0,budget={count:0}){
  if(depth>48||++budget.count>150000)fail();
  if(value===null||typeof value==='boolean')return;
  if(typeof value==='number'){if(!Number.isFinite(value))fail();return;}
  if(typeof value==='string'){if(value.length>2000000||/[?&](?:access[_-]?token|refresh[_-]?token|signature|credential|api[_-]?key|auth|token|ticket|session|cipher[_-]?key)=/i.test(value))fail();return;}
  if(Array.isArray(value)){for(const item of value)check(item,depth+1,budget);return;}
  if(!object(value))fail();
  for(const[key,item]of Object.entries(value)){if(denied.has(key.toLowerCase().replace(/[_-]/g,'')))fail();check(item,depth+1,budget);}
}
export function validateBasePayload(payload){
  if(!object(payload)||payload.format!=='feishu-bitable-table'||Object.keys(payload).some(k=>!['format','table','sourceTimezone'].includes(k)))fail();
  const t=payload.table;
  if(!object(t)||Object.keys(t).some(k=>!['meta','views','fieldMap','recordMap','viewMap','rankInfo','currentView','primaryKey'].includes(k))||!object(t.meta)||!isId(t.meta.id)||Object.keys(t.meta).some(k=>!['id','rev','schemaVersion','recordsNum'].includes(k)))fail();
  if(!object(t.fieldMap)||!object(t.recordMap)||!object(t.viewMap)||!Array.isArray(t.views)||t.views.length>100||new Set(t.views).size!==t.views.length)fail();
  if(Object.keys(t.fieldMap).length>500||Object.keys(t.recordMap).length>10000)fail();
  for(const[id,field]of Object.entries(t.fieldMap))if(!identity.test(id)||!object(field)||typeof field.name!=='string'||!Number.isSafeInteger(field.type))fail();
  for(const[id,record]of Object.entries(t.recordMap)){
    if(!identity.test(id)||!object(record))fail();
    for(const[fieldId,cell]of Object.entries(record))if(!Object.hasOwn(t.fieldMap,fieldId)||!object(cell)||Object.keys(cell).some(k=>k!=='value')||!Object.hasOwn(cell,'value'))fail();
  }
  if(Object.keys(t.viewMap).length!==t.views.length)fail();
  for(const id of t.views){const v=t.viewMap[id];if(!isId(id)||!object(v)||v.id!==id||Object.keys(v).some(k=>!['id','name','type','property'].includes(k))||typeof v.name!=='string'||!object(v.property))fail();}
  if(payload.sourceTimezone!==undefined){try{if(typeof payload.sourceTimezone!=='string'||payload.sourceTimezone.length>128)fail();new Intl.DateTimeFormat('en',{timeZone:payload.sourceTimezone}).format();}catch{fail();}}
  check(payload);
  if(new TextEncoder().encode(JSON.stringify(payload)).byteLength>6*1024*1024)fail();
}

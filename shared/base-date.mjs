const fail=()=>{throw Error('BASE_DATE_INVALID');};
function parts(epoch,timeZone){
  if(!Number.isSafeInteger(epoch)||Math.abs(epoch)>8640000000000000)fail();
  let values;try{values=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(epoch));}catch{fail();}
  const p=Object.fromEntries(values.filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
  if(!/^\d{4}$/.test(p.year))fail();
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.${String(((epoch%1000)+1000)%1000).padStart(3,'0')}`;
}
export function baseDateInput(epoch,timeZone,dateOnly=false){if(epoch===null||epoch===undefined)return '';return parts(epoch,timeZone).slice(0,dateOnly?10:23);}
export function epochFromBaseDate(input,timeZone){
  if(input==='')return null;
  if(typeof input!=='string'||!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)?$/.test(input))fail();
  const full=input.length===10?input+'T00:00:00.000':input.length===16?input+':00.000':input.length===19?input+'.000':input.padEnd(23,'0');
  const desired=new Date(full+'Z').getTime();
  if(!Number.isSafeInteger(desired)||new Date(desired).toISOString().slice(0,23)!==full)fail();
  let candidate=desired;
  for(let n=0;n<5;n++){
    const localEpoch=new Date(parts(candidate,timeZone)+'Z').getTime();
    const next=desired-(localEpoch-candidate);
    if(next===candidate)break;candidate=next;
  }
  if(parts(candidate,timeZone)!==full)fail();
  // A repeated clock time is ambiguous. Refuse instead of picking silently.
  for(let delta=-180;delta<=180;delta+=15)if(delta!==0&&parts(candidate+delta*60000,timeZone)===full)fail();
  return candidate;
}

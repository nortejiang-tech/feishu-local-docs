// Persist metadata only. Source URLs, titles, snapshots and document bytes stay out of storage.
const ACTIVE = new Set(['capturing','converting','saving']);
const STATES = new Set([...ACTIVE,'saved','failed','interrupted','cancelled']);
const KEY = 'localdocs.tasks.v1';
export function createTaskController({storage,source,run,query,prepare=async()=>{},uuid=()=>crypto.randomUUID(),now=()=>Date.now()}) {
  let serial=Promise.resolve();
  const running=new Map();
  const exclusive=fn=>{const next=serial.then(fn);serial=next.catch(()=>{});return next;};
  async function read() {
    const value=(await storage.get(KEY))[KEY];
    if(value!==undefined&&!Array.isArray(value))throw new Error('TASK_METADATA_INVALID');
    if(Array.isArray(value)&&value.length>500)throw new Error('TASK_METADATA_LIMIT');
    const list=value||[];
    if(list.some(t=>!t||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(t.jobId)||!/^[a-f0-9]{64}$/.test(t.sourceKey)||!Number.isSafeInteger(t.tabId)||t.tabId<0||!STATES.has(t.state)||!['SOURCE','CAPTURE','CONVERSION','NATIVE'].includes(t.stage)))throw new Error('TASK_METADATA_INVALID');
    return list.map(t=>({
      jobId:t.jobId,sourceKey:t.sourceKey,tabId:t.tabId,state:t.state,
      stage:['SOURCE','CAPTURE','CONVERSION','NATIVE'].includes(t.stage)?t.stage:'SOURCE',
      partial:t.partial===true,code:typeof t.code==='string'&&/^[A-Z_]{1,64}$/.test(t.code)?t.code:'',
      format:['localdoc','html','both'].includes(t.format)?t.format:'localdoc',retryFresh:t.retryFresh===true,
      ...(Number.isInteger(t.progress?.completed)&&Number.isInteger(t.progress?.total)&&t.progress.completed>=0&&t.progress.completed<=t.progress.total&&t.progress.total<=200?{progress:{completed:t.progress.completed,total:t.progress.total}}:{}),
      createdAt:Number.isSafeInteger(t.createdAt)?t.createdAt:0,updatedAt:Number.isSafeInteger(t.updatedAt)?t.updatedAt:0,
      ...(/^[a-f0-9]{64}$/.test(t.payloadHash)?{payloadHash:t.payloadHash}:{}),
      ...(/^[a-f0-9]{64}$/.test(t.htmlHash)?{htmlHash:t.htmlHash}:{})
    }));
  }
  async function write(list) {
    const active=list.filter(t=>ACTIVE.has(t.state)||t.state==='interrupted'&&t.stage==='NATIVE');
    const finished=list.filter(t=>!active.includes(t)).slice(-100);
    if(active.length>200)throw Object.assign(new Error(),{code:'TASK_LIMIT'});
    await storage.set({[KEY]:list.filter(t=>active.includes(t)||finished.includes(t))});
  }
  const publicTask=t=>t?{jobId:t.jobId,state:t.state,stage:t.stage,partial:t.partial===true,format:t.format||'localdoc',progress:t.progress,code:t.code||'',updatedAt:t.updatedAt,stopping:t.state==='cancelled'&&running.has(t.jobId)}:null;
  async function update(id,patch,expected) {
    return exclusive(async()=>{
      const list=await read(),task=list.find(t=>t.jobId===id);
      if(!task)return null;
      if(expected&&(task.state!==expected.state||task.stage!==expected.stage))return {...task};
      Object.assign(task,patch,{updatedAt:now()});await write(list);return {...task};
    });
  }
  async function reconcile(task) {
    if(!task||running.has(task.jobId)||!ACTIVE.has(task.state)&&!(task.state==='interrupted'&&task.stage==='NATIVE'))return task;
    if(task.stage==='NATIVE') {
      try {
        const reply=await query(task.jobId);
        if(reply?.ok&&reply.protocolVersion===1&&reply.jobId===task.jobId&&reply.status==='SAVED'&&/^[a-f0-9]{64}$/.test(reply.sha256)&&(!task.payloadHash||reply.sha256===task.payloadHash)&&(task.format==='localdoc'||reply.htmlSaved===true&&reply.htmlSha256===task.htmlHash))return update(task.jobId,{state:'saved',partial:reply.partial===true,code:''},task);
        if(reply?.ok&&reply.protocolVersion===1&&reply.jobId===task.jobId&&reply.status==='NOT_FOUND')return update(task.jobId,{state:'failed',code:'LOCAL_NOT_FOUND',retryFresh:reply.requiresNewJob===true},task);
      }catch{}
      return update(task.jobId,{state:'interrupted',code:['html','both'].includes(task.format)?'NATIVE_OUTPUT_PENDING':'NATIVE_DELIVERY_UNCONFIRMED'},task);
    }
    return update(task.jobId,{state:'interrupted',code:'WORKER_INTERRUPTED'},task);
  }
  async function latest(tabId) {
    const identity=await source(tabId);
    const task=await exclusive(async()=>[...await read()].reverse().find(t=>t.sourceKey===identity.sourceKey)||null);
    return {identity,task:await reconcile(task)};
  }
  async function execute(task,identity) {
    const control={cancelled:false};running.set(task.jobId,control);
    async function checkpoint(stage,extra={}) {
      if(control.cancelled)throw Object.assign(new Error(),{code:'TASK_CANCELLED'});
      const current=await source(task.tabId);
      if(current.sourceKey!==task.sourceKey)throw Object.assign(new Error(),{stage:'CAPTURE',code:'SOURCE_CHANGED'});
      if(control.cancelled)throw Object.assign(new Error(),{code:'TASK_CANCELLED'});
      const changed=await exclusive(async()=>{
        const list=await read(),record=list.find(t=>t.jobId===task.jobId);
        if(!record||record.state==='cancelled'||control.cancelled)throw Object.assign(new Error(),{code:'TASK_CANCELLED'});
        Object.assign(record,{stage,state:stage==='NATIVE'?'saving':stage==='CONVERSION'?'converting':'capturing',partial:extra.partial===true,updatedAt:now()});
        if(stage==='NATIVE'&&/^[a-f0-9]{64}$/.test(extra.payloadHash))record.payloadHash=extra.payloadHash;
        if(stage==='NATIVE'&&/^[a-f0-9]{64}$/.test(extra.htmlHash))record.htmlHash=extra.htmlHash;
        if(extra.progress&&Number.isInteger(extra.progress.completed)&&Number.isInteger(extra.progress.total))record.progress={completed:extra.progress.completed,total:extra.progress.total};
        await write(list);return record;
      });
      return changed;
    }
    try {
      await prepare(task.format);await checkpoint('CAPTURE');
      const result=await run(task.tabId,{jobId:task.jobId,format:task.format,expectedSource:identity.expectedSource,checkpoint});
      if(control.cancelled)return;
      if(result.ok)await update(task.jobId,{state:'saved',stage:'NATIVE',partial:result.partial===true,code:''});
      else await update(task.jobId,{state:result.stage==='NATIVE'?'interrupted':'failed',stage:result.stage,code:result.code});
    }catch(error) {
      if(error?.code==='TASK_CANCELLED'||control.cancelled)return;
      const stored=await exclusive(async()=>(await read()).find(t=>t.jobId===task.jobId));
      await update(task.jobId,{state:stored?.stage==='NATIVE'?'interrupted':'failed',stage:stored?.stage||'SOURCE',code:error?.code==='PROTOCOL_UPGRADE'?'PROTOCOL_UPGRADE':error?.code==='SOURCE_CHANGED'?'SOURCE_CHANGED':'TASK_FAILED'});
    }finally {running.delete(task.jobId);}
  }
  return {
    async current(tabId){return publicTask((await latest(tabId)).task);},
    async start(tabId,{newCopy=false,retry=false,format='localdoc'}={}) {
      const {identity}=await latest(tabId);
      const next=await exclusive(async()=>{
        const list=await read();
        // Re-read under the lock: two popup messages may have observed no previous task.
        const current=[...list].reverse().find(t=>t.sourceKey===identity.sourceKey);
        if(current&&(running.has(current.jobId)||ACTIVE.has(current.state)||current.state==='interrupted'&&current.stage==='NATIVE'))return {task:current,start:false};
        if(current&&!newCopy&&!retry)return {task:current,start:false};
        if(retry&&current?.state==='saved')return {task:current,start:false};
        const task={jobId:retry&&current&&!current.retryFresh?current.jobId:uuid(),sourceKey:identity.sourceKey,tabId,state:'capturing',stage:'SOURCE',partial:false,format:retry&&current?current.format:['localdoc','html','both'].includes(format)?format:'localdoc',code:'',createdAt:now(),updatedAt:now()};
        await write([...list.filter(t=>t.jobId!==task.jobId),task]);
        // Reserve before releasing the lock; execute() takes over the same record.
        running.set(task.jobId,{cancelled:false});return {task,start:true};
      });
      if(next.start)void execute(next.task,identity).catch(()=>{});
      return publicTask(next.task);
    },
    async cancel(tabId,jobId){
      const {identity}=await latest(tabId);
      return exclusive(async()=>{
        const list=await read(),task=list.find(t=>t.jobId===jobId&&t.sourceKey===identity.sourceKey);
        if(!task)return null;
        if(task.state==='capturing'||task.state==='converting'){
          const control=running.get(jobId);if(control)control.cancelled=true;
          Object.assign(task,{state:'cancelled',code:'',updatedAt:now()});await write(list);
        }
        return publicTask(task);
      });
    }
  };
}

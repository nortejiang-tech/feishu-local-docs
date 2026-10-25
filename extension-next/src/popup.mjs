import {taskView} from '../../shared/task-view.mjs';
const $=id=>document.getElementById(id);
let tabId,task,busy=false,timer;
const buttons=['retry','new-copy','cancel','check'];
function render(record){
  task=record;const view=taskView(record);
  $('status').textContent=view?.headline||'准备保存当前文件';$('status').className=view?.tone||'';
  $('detail').textContent=view?.detail||'正在连接本地应用…';
  $('progress').hidden=!['capturing','converting','saving'].includes(record?.state);
  $('retry').hidden=!view?.canRetry||record?.stopping===true;$('new-copy').hidden=!view?.canNewCopy;
  $('cancel').hidden=!view?.canCancel;$('check').hidden=!view?.canCheck;$('diagnostic').textContent='';
  if(record?.code==='PROTOCOL_UPGRADE')$('detail').textContent='请使用配套的 0.4.0 或兼容版本应用，并重新连接 Chrome 插件。';
  if(record?.code==='TASK_FAILED')$('detail').textContent='请先打开配套应用并检查插件连接，然后重试。';
  if(record?.code==='NATIVE_OUTPUT_PENDING')$('detail').textContent='HTML输出尚未确认；可在本地应用的“保存任务”中修复，再检查本次结果。';
  if(record?.code==='SOURCE_CHANGED')$('detail').textContent='页面已切换。本次读取未交付新副本，请在目标文件重新保存。';
  if(record?.code&&/^[A-Z_]{1,64}$/.test(record.code))$('diagnostic').textContent=`诊断：${record.code}`;
  if(record?.state==='cancelled')$('detail').textContent=record.stopping?'已禁止后续交付，正在等待当前页面读取返回并丢弃结果。':'本次读取已停止，未交付新的本地副本。';
  if(record?.stopping){$('status').textContent='正在停止后续读取';$('progress').hidden=false;}
  if(record?.state==='capturing'&&record.progress)$('detail').textContent=`已检查 ${record.progress.completed}/${record.progress.total} 项嵌入资源；内容完整性仍需核对。`;
  if(record?.state==='saved'&&['html','both'].includes(record.format))$('detail').textContent='可编辑副本和 HTML 阅读版已保存在本机，可在应用的“保存任务”中打开。内容完整性仍需核对。';
}
async function request(operation,extra={}){
  const reply=await chrome.runtime.sendMessage({operation,tabId,...extra});
  if(!reply?.ok)throw new Error(reply?.code==='UNSUPPORTED_SOURCE'?'UNSUPPORTED_SOURCE':'TASK_UNAVAILABLE');
  render(reply.task);return reply.task;
}
function unavailable(error){
  $('status').textContent=error?.message==='UNSUPPORTED_SOURCE'?'当前页面无法保存':'任务状态暂时无法读取';$('status').className='error';
  $('detail').textContent=error?.message==='UNSUPPORTED_SOURCE'?'请在已打开的飞书文档或电子表格中使用插件。':'请先检查配套应用；保存结果不明时不要再次创建副本。';
  $('progress').hidden=true;for(const id of buttons)$(id).hidden=true;$('check').hidden=false;
}
async function action(operation,extra){
  if(busy)return;busy=true;for(const id of buttons)$(id).disabled=true;
  try{await request(operation,extra);}catch(error){unavailable(error);}
  finally{busy=false;for(const id of buttons)$(id).disabled=false;}
}
$('retry').addEventListener('click',()=>action('task-start',{retry:true,format:$('format').value}));
$('new-copy').addEventListener('click',()=>action('task-start',{newCopy:true,format:$('format').value}));
$('cancel').addEventListener('click',()=>action('task-cancel',{jobId:task?.jobId}));
$('check').addEventListener('click',()=>action('task-current'));
async function init(){
  try{
    const saved=await chrome.storage?.local?.get('localdocs.options.v1');
    const format=saved?.['localdocs.options.v1']?.format;
    if(['localdoc','html','both'].includes(format))$('format').value=format;
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});if(!Number.isInteger(tab?.id))throw new Error('UNSUPPORTED_SOURCE');
    tabId=tab.id;$('source').textContent=tab.title||'当前文件';
    const current=await request('task-current');if(!current)await request('task-start',{format:$('format').value});
  }catch(error){unavailable(error);}
  timer=setInterval(()=>{if(!busy&&(['capturing','converting','saving'].includes(task?.state)||task?.stopping))void action('task-current');},1000);
}
$('format').addEventListener('change',()=>{void chrome.storage?.local?.set({'localdocs.options.v1':{format:$('format').value}}).catch(()=>{$('detail').textContent='默认格式未保存，本次选择仍可使用。';});});
window.addEventListener('unload',()=>clearInterval(timer));void init();

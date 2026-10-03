const status=document.getElementById('status'), retry=document.getElementById('retry');
async function run() {
  retry.hidden=true;status.textContent='正在读取当前文件…';status.className='';
  try {
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(!Number.isInteger(tab?.id))throw new Error();
    const result=await chrome.runtime.sendMessage({operation:'save-current',tabId:tab.id});
    status.textContent=result?.message||'保存尚未确认完成，请检查本地应用。';
    status.className=result?.ok?(result.partial?'partial':'success'):'error';
    retry.hidden=!!result?.ok;
  }catch{status.textContent='保存尚未确认完成。请检查当前页面和本地应用。';retry.hidden=false;}
}
retry.addEventListener('click',run);run();

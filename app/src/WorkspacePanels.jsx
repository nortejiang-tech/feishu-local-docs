import React,{useEffect,useState} from 'react';
import {systemStatus,repairConnection,showExtension,listTasks,repairTaskHtml,revealTaskHtml} from './io.mjs';

export function ConnectionPanel({experimental,onExperimental}){
  const [info,setInfo]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const refresh=async()=>{setBusy(true);try{setInfo(await systemStatus());setError('');}catch{setError('连接检查未完成，请稍后重新检查。');}finally{setBusy(false);}};
  useEffect(()=>{void refresh();},[]);
  const repair=async()=>{setBusy(true);try{await repairConnection();await refresh();}catch{setError('无法修复本机连接。请确认应用保留在稳定位置，且当前用户可写入 Chrome 接收配置。');}finally{setBusy(false);}};
  return <section className="utility-panel" aria-label="设置与连接"><h1>设置与连接</h1>
    <p>本地文件可以独立使用。浏览器保存需要配套的 Chrome 插件和本机接收配置。</p>
    {error&&<p role="alert">{error}</p>}
    <dl><dt>应用版本</dt><dd>{info?.version||'正在检查…'}</dd><dt>本机接收配置</dt><dd>{info?info.registrationMatches?'已匹配当前应用':'尚未匹配当前应用':'正在检查…'}</dd><dt>浏览器插件</dt><dd>在 Chrome 中打开插件后，会独立检查协议与应用能力。</dd></dl>
    <div className="panel-actions"><button className="secondary-button" disabled={busy} onClick={refresh}>重新检查</button><button className="primary-button" disabled={busy||!info?.native} onClick={repair}>修复本机连接</button><button className="secondary-button" disabled={!info?.native} onClick={()=>showExtension().catch(()=>setError('配套插件目录无法打开。'))}>显示配套插件</button></div>
    {!info?.native&&<p>当前是网页版，资料保存在当前浏览器中。桌面版提供 Chrome 连接和 Finder 文件位置。</p>}
    <h2>隐私与文件</h2><p>默认不上传正文到开发者服务器；读取在线内容时仍与来源平台交互。iCloud 文件位置由你选择，跨 Mac 请使用显式保存的副本。</p>
    <h2>实验功能</h2><label className="check-label"><input type="checkbox" checked={experimental} onChange={e=>onExperimental(e.target.checked)}/>显示飞书回导入口</label><p>完整保真仍需逐对象核对；启用入口不会自动写入飞书。原文保持不变，回导创建新副本。</p>
  </section>;
}

export function TaskPanel({onOpen}){
  const [tasks,setTasks]=useState([]),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const refresh=async()=>{setBusy(true);try{const result=await listTasks();setTasks(Array.isArray(result)?result:[]);setError('');}catch{setError('任务记录暂时无法读取。已有文件仍保留。');}finally{setBusy(false);}};
  useEffect(()=>{void refresh();},[]);
  const repair=async jobId=>{setBusy(true);try{await repairTaskHtml(jobId);await refresh();}catch{setError('HTML尚未修复，原始本地副本仍保留。可打开文件后重新导出。');}finally{setBusy(false);}};
  return <section className="utility-panel" aria-label="保存任务"><div className="panel-heading"><h1>保存任务</h1><button className="secondary-button" disabled={busy} onClick={refresh}>刷新任务记录</button></div><p>这里列出已落盘的浏览器副本。正在采集的进度在浏览器插件中查看；保存完成不等于内容覆盖和回导已核对。</p>
    {error&&<p role="alert">{error}</p>}{!busy&&!tasks.length&&<p>还没有接收到浏览器保存的文件。</p>}
    <ul className="task-list">{tasks.map(task=><li key={task.jobId}><div><strong>{task.title}</strong><small>{task.status==='SAVED'?'副本已落盘 · 内容核对待完成':'文件不可读取 · 原件保留'}</small></div><div className="panel-actions"><button className="secondary-button" disabled={busy||task.status!=='SAVED'} onClick={()=>onOpen(task.jobId)}>打开本地结果</button>{task.htmlStatus==='AVAILABLE'&&<button className="secondary-button" disabled={busy} onClick={()=>revealTaskHtml(task.jobId).catch(()=>setError('HTML文件位置无法打开。'))}>显示 HTML 文件</button>}{task.htmlStatus==='PENDING'&&<button className="secondary-button" disabled={busy} onClick={()=>repair(task.jobId)}>修复 HTML 输出</button>}</div></li>)}</ul>
  </section>;
}

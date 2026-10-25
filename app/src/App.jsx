import React, { Component, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle, Check, ChevronDown, Clock3, FileSpreadsheet, FileText, FolderOpen,
  LoaderCircle, Menu, Plus, Save, X, FileCode2, Search, Trash2, Settings, ListChecks,
} from 'lucide-react';
import { createDocument, updateContent, validateDocument } from '../../shared/model.mjs';
import { buildCaptureAudit } from '../../shared/capture-audit.mjs';
import { buildSheetAudit } from '../../shared/sheet-audit.mjs';
import { withDeadline } from './operation-deadline.mjs';
import {documentSummary,libraryView} from '../../shared/library-view.mjs';
import {ConnectionPanel,TaskPanel} from './WorkspacePanels.jsx';
import { createStarterDocuments } from './samples.mjs';
import { exportLocal, exportHtml, importFeishu, isNative, loadLibraryIndex, loadDocument, moveLocal, revealLocal, readTask, openLocal, saveLocal, watchIncoming } from './io.mjs';
const DocumentEditor=lazy(()=>import('./editors/DocumentEditor.jsx'));
const SheetEditor=lazy(()=>import('./editors/SheetEditor.jsx'));

class EditorErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <div className="editor-fallback" role="alert"><AlertCircle size={20} /><div><strong>编辑器暂时无法显示</strong><p>当前文件仍在本地文档列表中。请重新打开文件，或稍后重试。</p><button type="button" onClick={() => this.setState({ failed: false })}>重新载入编辑器</button></div></div>;
    return this.props.children;
  }
}

const errorCopy = (error, action) => {
  const code = typeof error?.message === 'string' ? error.message : '';
  const human = code && !/^[A-Z0-9_]+$/.test(code) ? code : '';
  if (human) return human;
  if (code === 'EDITOR_FLUSH_TIMEOUT') return '编辑内容仍在整理，当前文件保持打开且草稿保留。请稍后重试。';
  if (action === 'save') return '保存没有完成。请重试；原文件仍保留在列表中。';
  if (action === 'open') return code.includes('CANCEL') ? '' : '打开失败，请确认选择的是有效的 .localdoc 文件。';
  if (action === 'export') return code.includes('CANCEL') ? '' : '保存副本失败，请重试。';
  if (action === 'import' && !isNative()) return '飞书恢复需要桌面应用。请在桌面应用中打开这份本地文件后再试。';
  if (action === 'import') return '飞书副本没有创建成功。请检查网络连接后重试。';
  return '操作没有完成，请重试。';
};

function countDocumentText(node) {
  if (!node || typeof node !== 'object') return 0;
  if (node.type === 'text') return [...(node.text || '').replace(/\s/g, '')].length;
  return (node.content || []).reduce((sum, child) => sum + countDocumentText(child), 0);
}
function countSheetText(content) {
  return Object.values(content?.sheets || {}).reduce((sum, sheet) => sum + Object.values(sheet.cellData || {}).reduce((rowSum, row) => rowSum + Object.values(row || {}).reduce((cellSum, cell) => cellSum + [...String(cell?.v ?? '').replace(/\s/g, '')].length, 0), 0), 0);
}
function issueCount(doc) {
  return (doc?.issues || []).reduce((sum, issue) => sum + (Number.isFinite(issue?.count) ? issue.count : 0), 0);
}
const resourceStatus={MISSING:'未读取',PREVIEW:'已保存预览',ORIGINAL_CANDIDATE:'已保存数据，待核对',ORIGINAL:'已保存原始数据',UNVERIFIED:'已保存，待核对',STRUCTURE_CANDIDATE:'已保存图形节点',VIEW_SNAPSHOT:'已保存字段与记录'};
const resourceReason={RESOURCE_URL_UNAVAILABLE:'页面未提供可读取的数据',RESOURCE_BYTES_MISSING:'未取得内容数据',EMBEDDED_ADAPTER_PENDING:'这类嵌入内容尚未完成转换',RESOURCE_PERMISSION_DENIED:'服务器拒绝了当前账号的读取',RESOURCE_CAPTURE_TIMEOUT:'读取超时',RESOURCE_PREVIEW_ONLY:'原始数据仍待核对',RESOURCE_ORIGINAL_UNVERIFIED:'原始内容一致性仍待核对',RESOURCE_READ_FAILED:'读取未完成',WHITEBOARD_EDITOR_PENDING:'已接入基础编辑，复杂结构和样式仍待完善',WHITEBOARD_NOT_LOADED:'画板尚未加载出内容',EMBEDDED_READ_FAILED:'嵌入内容读取未完成',EMBEDDED_READ_TIMEOUT:'嵌入内容读取超时',EMBEDDED_SOURCE_CHANGED:'读取时画板发生变化，请重新保存'};
function captureAudit(doc) {
  if(doc?.kind!=='document'||!doc.provenance?.capture)return null;
  const report=doc.provenance.audit;
  const countKeys=['tables','tableCells','images','files','whiteboards','bases','otherEmbeds','editableTables','renderedImages','resourcesWithBytes','previewResources','missingResources'];
  if(report?.status==='PENDING'&&countKeys.every(k=>Number.isSafeInteger(report.counts?.[k])&&report.counts[k]>=0)
    &&Array.isArray(report.objects)&&report.objects.length<=200&&report.objects.every(o=>typeof o?.label==='string'&&typeof o.code==='string'&&Object.hasOwn(resourceStatus,o.status)))return report;
  return buildCaptureAudit(doc.provenance.capture,[],doc.content,doc.provenance.embedded);
}
function CaptureDetails({report}) {
  if(!report)return null;
  const c=report.counts;
  return <details className="capture-details"><summary>导出检查：普通表格 {c.editableTables}/{c.tables}，图片 {c.renderedImages}/{c.images}，附件 {c.files}，画板节点 {c.structuredWhiteboards||0}/{c.whiteboards}，多维表格数据 {c.structuredBases||0}/{c.bases}</summary>
    <div className="capture-details-body"><p>这里显示导出时的读取结果。已显示的图片可能来自预览；内容、外观和回导一致性仍待核对。</p>
    {report.objects.length>0&&<ul>{report.objects.map((o,index)=><li key={index}><span>{o.label}</span><strong>{resourceStatus[o.status]}</strong><small>{resourceReason[o.code]||'尚待核对'}</small></li>)}</ul>}
    </div></details>;
}
function SheetCaptureDetails({report}) {
  if(!report)return null;
  return <details className="capture-details">
    <summary>导出检查：采集到 {report.totals.sheets} 个工作表 · 加载完整性待核对</summary>
    <div className="capture-details-body">
      <p>以下是采集时留存的快照，之后的本地编辑不会改写这些计数。范围和样式数量不代表已完整加载；各类单元格计数可重叠。</p>
      {report.totals.emptyOrUnloadedSheets>0&&<p>{report.totals.emptyOrUnloadedSheets} 个工作表没有取得值、显示文字或公式，可能为空白或尚未加载。请在原文件中核对。</p>}
      <div className="sheet-audit-scroll"><table><thead><tr><th scope="col">工作表</th><th scope="col">范围</th><th scope="col">有值</th><th scope="col">显示文字</th><th scope="col">公式</th><th scope="col">样式</th><th scope="col">合并</th><th scope="col">读取状态</th></tr></thead>
        <tbody>{report.sheets.map(s=><tr key={s.index}><th scope="row">{s.name}</th><td>{s.rows} 行 × {s.columns} 列</td><td>{s.valueCells}</td><td>{s.displayCells}</td><td>{s.formulaCells}</td><td>{s.styledCells}</td><td>{s.merges}</td><td>{s.state==='EMPTY_OR_UNLOADED'?'空白或未加载':'加载覆盖待核对'}</td></tr>)}</tbody>
      </table></div>
      <p>每张工作表的完整性目前均未知。请在飞书中逐表加载并核对关键内容；自动加载所有工作表将在后续阶段实现。</p>
    </div>
  </details>;
}
function normalizeTitle(value) { return String(value || '').replace(/[\r\n]/g, '').slice(0, 1000); }

export default function App() {
  const [library, setLibrary] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [filter, setFilter] = useState('recent');
  const [savingById, setSavingById] = useState({});
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState('');
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [booted, setBooted] = useState(false);
  const [incomingCount, setIncomingCount] = useState(0);
  const [view,setView]=useState('editor');
  const [query,setQuery]=useState('');
  const [folder,setFolder]=useState('');
  const [folderDraft,setFolderDraft]=useState('');
  const [experimental,setExperimental]=useState(()=>{try{return localStorage.getItem('localdocs.experimentalImport.v1')==='true';}catch{return false;}});
  const editorRef = useRef(null);
  const titleRef = useRef(null);
  const libraryRef = useRef([]);
  const activeIdRef = useRef(null);
  const saveChains = useRef(new Map());
  const saveTasks = useRef(new Map());
  const savedRevisions = useRef(new Map());
  const incomingQueue = useRef([]);
  const loading = useRef(false);

  const activeEntry=library.find(doc=>doc.id===activeId);
  const activeDoc = activeEntry?.content&&!activeEntry.trashed ? activeEntry:null;
  const activeAudit = useMemo(()=>captureAudit(activeDoc),[activeDoc?.provenance,activeDoc?.content]);
  const activeSheetAudit = useMemo(()=>activeDoc?.kind==='sheet'?buildSheetAudit(activeDoc.provenance?.capture):null,[activeDoc?.kind,activeDoc?.provenance]);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  activeIdRef.current = activeId;
  libraryRef.current = library;

  const setLibraryAndRef = useCallback(next => {
    const value = typeof next === 'function' ? next(libraryRef.current) : next;
    libraryRef.current = value;
    setLibrary(value);
    return value;
  }, []);

  const setSaveState = useCallback((id, state) => {
    setSavingById(previous => ({ ...previous, [id]: state }));
  }, []);

  const queueSave = useCallback(snapshot => {
    if (!snapshot?.content||snapshot.trashed) return Promise.resolve(null);
    const taskKey = `${snapshot.id}\u0000${snapshot.revision}`;
    const inProgress = saveTasks.current.get(taskKey);
    if (inProgress) return inProgress;
    const alreadySaved = savedRevisions.current.get(snapshot.id) ?? -1;
    if (alreadySaved >= snapshot.revision) return Promise.resolve({ saved: true, skipped: true });
    setSaveState(snapshot.id, { state: 'saving' });
    const previous = saveChains.current.get(snapshot.id) || Promise.resolve();
    const task = previous.catch(() => undefined).then(async () => {
      const latestSaved = savedRevisions.current.get(snapshot.id) ?? -1;
      if (latestSaved >= snapshot.revision) return { saved: true, skipped: true };
      const result = await saveLocal(snapshot);
      savedRevisions.current.set(snapshot.id, Math.max(latestSaved, snapshot.revision));
      const current = libraryRef.current.find(doc => doc.id === snapshot.id);
      if (current?.revision === snapshot.revision) setSaveState(snapshot.id, { state: 'saved', savedAt: result?.savedAt || null, location: result?.location || null });
      return result;
    }).catch(error => {
      const current = libraryRef.current.find(doc => doc.id === snapshot.id);
      if (current?.revision === snapshot.revision) setSaveState(snapshot.id, { state: 'error' });
      throw error;
    });
    saveChains.current.set(snapshot.id, task);
    saveTasks.current.set(taskKey, task);
    const clearTask = () => { if (saveTasks.current.get(taskKey) === task) saveTasks.current.delete(taskKey); };
    task.then(clearTask, clearTask);
    return task;
  }, [setSaveState]);

  const updateActive = useCallback((next, dirty = true) => {
    validateDocument(next);
    const updated = libraryRef.current.some(doc => doc.id === next.id)
      ? libraryRef.current.map(doc => doc.id === next.id ? next : doc)
      : [...libraryRef.current, next];
    setLibraryAndRef(updated);
    if (dirty) setSaveState(next.id, { state: 'pending' });
    return next;
  }, [setLibraryAndRef, setSaveState]);

  const flushActive = useCallback(() => {
    const targetId = activeIdRef.current;
    const doc = libraryRef.current.find(item => item.id === targetId);
    if (!doc?.content||doc.trashed) return Promise.resolve(null);
    const editor = editorRef.current;
    return Promise.resolve().then(async () => {
      let content;
      try { content = await withDeadline(Promise.resolve(editor?.flush?.()), 10_000); }
      catch (error) { throw new Error(error?.message === 'OPERATION_TIMEOUT' ? 'EDITOR_FLUSH_TIMEOUT' : 'EDITOR_FLUSH_FAILED'); }
      const current = libraryRef.current.find(item => item.id === targetId);
      if (!current) return null;
      if (content && JSON.stringify(content) !== JSON.stringify(current.content)) return updateActive(updateContent(current, content));
      return current;
    });
  }, [updateActive]);

  const flushAndSave = useCallback(async () => {
    for(let attempt=0;attempt<8;attempt++) {
      const doc = await flushActive();
      if (!doc) return null;
      await queueSave(doc);
      const latest = await flushActive();
      if(latest?.id===doc.id && latest.revision===doc.revision)return latest;
    }
    throw new Error('内容仍在更新，请稍后再试。');
  }, [flushActive, queueSave]);

  useEffect(() => {
    const beforeClose = async () => {
      document.activeElement?.blur?.();
      const workspace=document.getElementById('root');
      if(workspace)workspace.inert=true;
      try {
        await flushAndSave();
        for(const doc of libraryRef.current)await queueSave(doc);
      } catch(error) { if(workspace)workspace.inert=false; throw error; }
    };
    window.localDocsBeforeClose = beforeClose;
    const warnIfDirty = event => {
      const dirty = libraryRef.current.some(doc => doc.revision > (savedRevisions.current.get(doc.id) ?? -1));
      if (dirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warnIfDirty);
    return () => {
      if (window.localDocsBeforeClose === beforeClose) delete window.localDocsBeforeClose;
      window.removeEventListener('beforeunload', warnIfDirty);
    };
  }, [flushAndSave]);

  const showError = useCallback((error, action) => {
    const message = errorCopy(error, action);
    if (message) setNotice({ kind: 'error', message });
  }, []);

  const enqueueIncoming = useCallback(incoming => {
    incomingQueue.current.push(incoming);
    setIncomingCount(incomingQueue.current.length);
  }, []);

  const processIncoming = useCallback(async incoming => {
    try {
      const sameTask=incoming.localMeta?.taskId&&libraryRef.current.find(doc=>(doc.localMeta?.taskId||doc.taskId)===incoming.localMeta.taskId&&!doc.trashed);
      if(sameTask){
        await flushAndSave();const latest=libraryRef.current.find(doc=>doc.id===sameTask.id);
        const opened=latest?.content?latest:await loadDocument(sameTask.id);
        setLibraryAndRef(libraryRef.current.map(doc=>doc.id===opened.id?opened:doc));setActiveId(opened.id);setView('editor');return;
      }
      const previousId = activeIdRef.current;
      await flushAndSave();
      if (activeIdRef.current !== previousId) { enqueueIncoming(incoming); return; }
      const doc = validateDocument(incoming);
      setLibraryAndRef(libraryRef.current.some(item => item.id === doc.id)
        ? libraryRef.current.map(item => item.id === doc.id ? doc : item)
        : [...libraryRef.current, doc]);
      setActiveId(doc.id);
      setView('editor');
      setFilter('recent');
      setSidebarOpen(false);
      setNotice(null);
      if (issueCount(doc)) setNotice({ kind: 'partial', message: '文件已保存。还有未完整读取或转换的内容，可展开“导出检查”查看。' });
      try { await queueSave(doc); } catch (error) { showError(error, 'save'); }
    } catch (error) { showError(error, 'save'); }
  }, [enqueueIncoming, flushAndSave, queueSave, setLibraryAndRef, showError]);

  useEffect(() => {
    if (loading.current) return undefined;
    loading.current = true;
    let mounted = true;
    let unsubscribe = () => {};
    const handleNativeError = event => {
      const message = typeof event.detail === 'string' ? event.detail : '本机操作没有完成，请重试。';
      setNotice({ kind: 'error', message });
    };
    try {
      unsubscribe = watchIncoming(enqueueIncoming) || (() => {});
    } catch { /* Native file watching can be unavailable in browser preview. */ }
    window.addEventListener('localdocs:error', handleNativeError);
    loadLibraryIndex().then(async loaded => {
      if (!mounted) return;
      const docs = Array.isArray(loaded) ? loaded.filter(doc => { try { if(!doc.content)return !!documentSummary(doc);validateDocument(doc);return true; } catch { return false; } }) : [];
      const liveDocs = libraryRef.current;
      const combined = [...docs, ...liveDocs.filter(doc => !docs.some(saved => saved.id === doc.id))];
      if (combined.length) {
        setLibraryAndRef(combined);
        for (const doc of docs) {
          savedRevisions.current.set(doc.id, doc.revision);
          setSaveState(doc.id, { state: 'saved' });
        }
        if (!activeIdRef.current) {
          const first=combined.find(doc=>!doc.trashed);
          if(first){try{const opened=first.content?first:await loadDocument(first.id);if(!mounted)return;setLibraryAndRef(list=>list.map(doc=>doc.id===opened.id?opened:doc));setActiveId(opened.id);}catch(error){setNotice({kind:'error',message:'第一份文件暂时无法打开，其余文件仍可从侧栏选择。'});}}
        }
      } else if (!loaded.skipped) {
        const samples = createStarterDocuments();
        setLibraryAndRef(samples);
        setActiveId(samples[0].id);
        for (const doc of samples) setSaveState(doc.id, { state: 'saving' });
        if (mounted) setBooted(true);
        const results = await Promise.allSettled(samples.map(doc => queueSave(doc)));
        if (mounted && results.some(result => result.status === 'rejected')) setNotice({ kind: 'error', message: '示例已打开，但未能写入本地文档库。请检查应用权限后重试。' });
      }
      if (loaded.skipped) setNotice({kind:'error',message:`有 ${loaded.skipped} 份文件无法读取或暂不支持，已保留原文件；其余文档可继续使用。`});
      if (mounted) setBooted(true);
    }).catch(error => {
      if (!mounted) return;
      setLibraryAndRef([]);
      setActiveId(null);
      setBooted(true);
      const message = typeof error?.message === 'string' && !/^[A-Z0-9_]+$/.test(error.message)
        ? error.message
        : '无法读取本地文档库。请重试，或先打开一个本地文件。';
      setNotice({ kind: 'error', message });
    });
    return () => { mounted = false; unsubscribe(); window.removeEventListener('localdocs:error', handleNativeError); };
  }, [enqueueIncoming, queueSave, setLibraryAndRef, setSaveState]);

  useEffect(() => {
    if (!booted || busy || !incomingQueue.current.length) return undefined;
    const incoming = incomingQueue.current.shift();
    setIncomingCount(incomingQueue.current.length);
    setBusy('incoming');
    processIncoming(incoming).finally(() => setBusy(''));
    return undefined;
  }, [booted, busy, incomingCount, processIncoming]);

  useEffect(() => {
    if (!activeDoc || !booted) return undefined;
    const timer = window.setTimeout(() => {
      const current = libraryRef.current.find(doc => doc.id === activeDoc.id);
      if (!current) return;
      const saved = savedRevisions.current.get(current.id) ?? -1;
      if (current.revision > saved) queueSave(current).catch(() => {});
    }, 600);
    return () => window.clearTimeout(timer);
  }, [activeDoc?.id, activeDoc?.revision, booted, queueSave]);

  useEffect(() => {
    if (!titleEditing) return undefined;
    titleRef.current?.focus();
    titleRef.current?.select();
    return undefined;
  }, [titleEditing]);
  useEffect(()=>{setFolderDraft(activeDoc?.localMeta?.folder||'');},[activeDoc?.id,activeDoc?.localMeta?.folder]);

  const switchTo = async doc => {
    if (doc.id === activeIdRef.current) { setView('editor');setSidebarOpen(false); return; }
    const previousId = activeIdRef.current;
    if (busyRef.current) return;
    setBusy('switch');
    try {
      await flushAndSave();
      if (activeIdRef.current !== previousId) return;
      const opened=doc.content?doc:await loadDocument(doc.id);
      setLibraryAndRef(list=>list.map(entry=>entry.id===opened.id?opened:entry));
      setActiveId(doc.id);
      setView('editor');
      setFilter('recent');
      setSidebarOpen(false);
      setNotice(null);
      if (issueCount(opened)) setNotice({ kind: 'partial', message: '文件已保存。还有未完整读取或转换的内容，可展开“导出检查”查看。' });
    } catch (error) { showError(error, 'save'); }
    finally { setBusy(''); }
  };

  const createFile = async kind => {
    setNewMenuOpen(false);
    if (busyRef.current) return;
    const previousId = activeIdRef.current;
    setBusy('create');
    try {
      await flushAndSave();
      if (activeIdRef.current !== previousId) return;
      const doc = createDocument(kind, kind === 'sheet' ? '未命名电子表格' : '未命名文档');
      setLibraryAndRef([...libraryRef.current, doc]);
      setActiveId(doc.id);
      setView('editor');
      setFilter('recent');
      setSidebarOpen(false);
      setNotice(null);
      setSaveState(doc.id, { state: 'saving' });
      try { await queueSave(doc); } catch (error) { showError(error, 'save'); }
    } catch (error) { showError(error, 'save'); }
    finally { setBusy(''); }
  };

  const openFile = async () => {
    if (busyRef.current) return;
    const previousId = activeIdRef.current;
    setBusy('open');
    try {
      await flushAndSave();
      if (activeIdRef.current !== previousId) return;
      setNotice(null);
      setBusy('open-picker');
      const doc = await openLocal();
      if (!doc) return;
      validateDocument(doc);
      setLibraryAndRef(libraryRef.current.some(item => item.id === doc.id)
        ? libraryRef.current.map(item => item.id === doc.id ? doc : item)
        : [...libraryRef.current, doc]);
      setActiveId(doc.id);
      setView('editor');
      setFilter('recent');
      setSidebarOpen(false);
      if (issueCount(doc)) setNotice({ kind: 'partial', message: '文件已打开。还有未完整读取或转换的内容，可展开“导出检查”查看。' });
      try { await queueSave(doc); } catch (error) { showError(error, 'save'); }
    } catch (error) { showError(error, 'open'); }
    finally { setBusy(''); }
  };

  const saveCopy = async (format = 'localdoc') => {
    if (busyRef.current) return;
    const previousId = activeIdRef.current;
    setBusy(format === 'html' ? 'html' : 'export');
    try {
      const doc = await flushActive();
      if (!doc || activeIdRef.current !== previousId) return;
      let librarySaved=true;
      try{await queueSave(doc);}catch{librarySaved=false;}
      setNotice(null);
      const result = await (format === 'html' ? exportHtml(doc) : exportLocal(doc));
      if (!result?.cancelled) {
        const message = format === 'html' ? (result?.initiated ? 'HTML 下载已发起，可用浏览器离线打开。' : 'HTML 已保存，可用浏览器离线打开。') : (result?.initiated ? '本地副本下载已发起。' : '本地副本已保存。');
        setNotice({kind:result?.warnings?.length||!librarySaved ? 'partial' : 'success',message:message+(!librarySaved?' 本机资料库尚未更新，此次副本保留了当前编辑。':'')+(result?.warnings?.length ? ' 未完整转换的内容已在 HTML 中标注。' : '')});
      }
    } catch (error) { showError(error, 'export'); }
    finally { setBusy(''); }
  };

  const restoreToFeishu = async () => {
    if(!experimental)return;
    if (!isNative()) { showError(new Error('UNAVAILABLE'), 'import'); return; }
    if (busyRef.current) return;
    const previousId = activeIdRef.current;
    setBusy('import');
    try {
      const doc = await flushAndSave();
      if (!doc || activeIdRef.current !== previousId) return;
      setNotice(null);
      const result = await importFeishu(doc);
      const url = typeof result?.url === 'string' && /^https:\/\//i.test(result.url) ? result.url : null;
      const created = result?.status === 'CREATED' && url;
      if (created) {
        const verified = result?.verification === 'PASS';
        const message = verified ? '飞书副本已创建并通过保真校验。' : '已创建飞书副本，保真校验待完成。';
        setNotice({ kind: 'success', message, link: url, linkText: '打开飞书副本' });
      } else {
        setNotice({ kind: 'partial', message: result?.status === 'PENDING' ? '飞书副本创建状态待确认，保真校验待完成。' : '飞书操作已返回，副本创建状态仍待确认。' });
      }
    } catch (error) { showError(error, 'import'); }
    finally { setBusy(''); }
  };

  const commitTitle = () => {
    const title = normalizeTitle(titleDraft).trim() || '未命名文档';
    if (activeDoc && title !== activeDoc.title) {
      try { updateActive(validateDocument({ ...activeDoc, title, revision: activeDoc.revision + 1, updatedAt: new Date().toISOString() })); }
      catch { setNotice({ kind: 'error', message: '文件名无法保存，请换一个较短的名称。' }); }
    }
    setTitleEditing(false);
  };

  const projected=useMemo(()=>libraryView(library,{query,folder,kind:filter==='recent'?null:filter}),[library,query,folder,filter]);
  const visibleDocs=useMemo(()=>{const map=new Map(library.map(doc=>[doc.id,doc]));return projected.ids.map(id=>map.get(id));},[library,projected]);
  const trashDocs=useMemo(()=>{const ids=libraryView(library,{query,trashed:true}).ids;return ids.map(id=>library.find(doc=>doc.id===id));},[library,query]);
  const changeView=async next=>{if(busyRef.current)return;setBusy('switch');try{await flushAndSave();setView(next);setSidebarOpen(false);setNotice(null);}catch(error){showError(error,'save');}finally{setBusy('');}};
  const changeExperimental=value=>{setExperimental(value);try{localStorage.setItem('localdocs.experimentalImport.v1',String(value));}catch{}};
  const moveDocument=async(doc,toTrash)=>{
    if(busyRef.current)return;setBusy('manage');
    try{
      if(toTrash&&doc.id===activeIdRef.current)await flushAndSave();
      await moveLocal(doc.id,toTrash);
      setLibraryAndRef(list=>list.map(entry=>entry.id===doc.id?{...documentSummary(entry),trashed:toTrash}:entry));
      if(toTrash&&doc.id===activeIdRef.current)setActiveId(null);
      setNotice({kind:'success',message:toTrash?'文件已移到最近删除，可随时恢复。':'文件已恢复到文档库。'});
    }catch(error){showError(error,'save');}finally{setBusy('');}
  };
  const assignFolder=async()=>{
    if(busyRef.current||!activeDoc)return;setBusy('manage');
    try{const doc=await flushAndSave();if(!doc)return;const next={...doc,localMeta:{...doc.localMeta,folder:folderDraft.trim().slice(0,64)},revision:doc.revision+1,updatedAt:new Date().toISOString()};updateActive(next);await queueSave(next);setNotice({kind:'success',message:'文件夹已保存。'});}catch(error){showError(error,'save');}finally{setBusy('');}
  };
  const openSavedTask=async jobId=>{
    if(busyRef.current)return;setBusy('task');
    try{
      const previous=libraryRef.current.find(doc=>(doc.localMeta?.taskId||doc.taskId)===jobId&&!doc.trashed);
      await flushAndSave();
      const fresh=previous&&libraryRef.current.find(doc=>doc.id===previous.id);
      const opened=previous?(fresh?.content?fresh:await loadDocument(previous.id)):await readTask(jobId);
      setLibraryAndRef(list=>list.some(doc=>doc.id===opened.id)?list.map(doc=>doc.id===opened.id?opened:doc):[...list,opened]);setActiveId(opened.id);setView('editor');if(!previous)await queueSave(opened);
    }catch(error){showError(error,'open');}finally{setBusy('');}
  };
  const saveState = activeDoc ? savingById[activeDoc.id] : null;
  const count = activeDoc?.kind === 'document' ? countDocumentText(activeDoc.content) : activeDoc?.kind === 'sheet' ? countSheetText(activeDoc.content) : null;

  const saveLabel = !activeDoc ? '' : saveState?.state === 'saving' ? '正在保存' : saveState?.state === 'pending' ? '待保存' : saveState?.state === 'error' ? '保存失败' : '已保存到本地';
  const busyLabel = ({
    switch: '准备切换文件…', create: '正在准备新文件…', open: '正在读取文件…', 'open-picker': '请完成文件选择…',
    export: '正在保存副本…', html: '正在保存 HTML…', import: '正在导入飞书…', incoming: '正在接收文件…',manage:'正在保存文件变更…',task:'正在打开任务结果…',
  })[busy] || '';

  return (
    <div className="app-shell">
      {sidebarOpen && <button className="mobile-scrim" aria-label="关闭侧栏" onClick={() => setSidebarOpen(false)} />}
      <aside className={`sidebar ${sidebarOpen ? 'sidebar-open' : ''}`} aria-label="文档导航">
        <div className="brand-row"><span className="brand-mark"><FileText size={19} /></span><span>本地文档</span><button className="icon-button sidebar-close" aria-label="关闭导航" onClick={() => setSidebarOpen(false)}><X size={18} /></button></div>
        <div className="new-wrap">
        <button className="new-button" disabled={!booted || !!busy} onClick={() => setNewMenuOpen(value => !value)} aria-expanded={newMenuOpen}><Plus size={18} />新建<ChevronDown size={16} /></button>
          {newMenuOpen && <div className="new-menu" role="menu"><button role="menuitem" onClick={() => createFile('document')}><FileText size={17} />文档</button><button role="menuitem" onClick={() => createFile('sheet')}><FileSpreadsheet size={17} />电子表格</button></div>}
        </div>
        <nav className="nav-list" aria-label="文件筛选">
          <button className={`nav-item ${filter === 'recent' ? 'nav-active' : ''}`} disabled={!!busy} onClick={() => {setFilter('recent');void changeView('editor');}}><Clock3 size={18} />最近打开</button>
          <button className={`nav-item ${filter === 'document' ? 'nav-active' : ''}`} disabled={!!busy} onClick={() => {setFilter('document');void changeView('editor');}}><FileText size={18} />文档</button>
          <button className={`nav-item ${filter === 'sheet' ? 'nav-active' : ''}`} disabled={!!busy} onClick={() => {setFilter('sheet');void changeView('editor');}}><FileSpreadsheet size={18} />电子表格</button>
          <button className={`nav-item ${view==='tasks'?'nav-active':''}`} disabled={!!busy} onClick={()=>changeView('tasks')}><ListChecks size={18}/>保存任务</button>
          <button className={`nav-item ${view==='trash'?'nav-active':''}`} disabled={!!busy} onClick={()=>changeView('trash')}><Trash2 size={18}/>最近删除</button>
          <button className={`nav-item ${view==='settings'?'nav-active':''}`} disabled={!!busy} onClick={()=>changeView('settings')}><Settings size={18}/>设置与连接</button>
        </nav>
        <label className="library-search"><Search size={16}/><input aria-label="搜索本地文件" value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索本地文件" maxLength={100}/></label>
        <select className="folder-filter" aria-label="筛选文件夹" value={folder} onChange={e=>setFolder(e.target.value)}><option value="">全部文件夹</option>{projected.folders.map(name=><option key={name} value={name}>{name}</option>)}</select>
        <div className="library-list">
          <div className="section-label">我的文档</div>
          {!booted && <div className="list-hint">正在读取本地文件…</div>}
          {booted && visibleDocs.length === 0 && <div className="list-hint">这里还没有文件</div>}
          {visibleDocs.map(doc => <button key={doc.id} disabled={!booted || !!busy} className={`file-item ${doc.id === activeId ? 'file-active' : ''}`} onClick={() => switchTo(doc)} title={doc.title}>
            {doc.kind === 'sheet' ? <FileSpreadsheet size={18} /> : <FileText size={18} />}<span>{doc.title}</span>
          </button>)}
        </div>
        <div className="sidebar-foot"><span className="offline-dot" /><span>离线可用</span></div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <button className="icon-button mobile-menu" aria-label="打开导航" onClick={() => setSidebarOpen(true)}><Menu size={19} /></button>
          <div className="file-heading">
            {titleEditing ? <input ref={titleRef} disabled={!!busy} className="title-input" value={titleDraft} onChange={event => setTitleDraft(event.target.value)} onBlur={commitTitle} onKeyDown={event => { if (event.key === 'Enter') commitTitle(); if (event.key === 'Escape') setTitleEditing(false); }} aria-label="文件名" /> : <button className="title-button" disabled={!!busy||view!=='editor'} onClick={() => { if (activeDoc) { setTitleDraft(activeDoc.title); setTitleEditing(true); } }} title="重命名文件">{view==='editor'?(activeDoc?.title||'本地文档'):({settings:'设置与连接',tasks:'保存任务',trash:'最近删除'})[view]}</button>}
            <span className={`save-indicator ${saveState?.state === 'error' ? 'save-error' : ''}`} aria-live="polite">{saveState?.state === 'saving' && <LoaderCircle className="spin" size={16} />}{saveState?.state === 'saved' && <Check size={16} />}{saveState?.state === 'error' && <AlertCircle size={16} />}{saveLabel}</span>
          </div>
          <div className="header-actions">
          <button className="secondary-button" onClick={openFile} disabled={!booted || !!busy}><FolderOpen size={17} /><span>打开文件</span></button>
            <details className="export-menu"><summary aria-disabled={!activeDoc||!!busy||view!=='editor'} onClick={e=>{if(!activeDoc||busy||view!=='editor')e.preventDefault();}}>导出 <ChevronDown size={15}/></summary><div role="menu"><button role="menuitem" onClick={e=>{e.currentTarget.closest('details').open=false;void saveCopy();}}><Save size={17}/>保存可编辑副本</button><button role="menuitem" onClick={e=>{e.currentTarget.closest('details').open=false;void saveCopy('html');}}><FileCode2 size={17}/>保存为 HTML</button><button role="menuitem" onClick={e=>{e.currentTarget.closest('details').open=false;if(activeDoc)void revealLocal(activeDoc.id).catch(error=>showError(error,'open'));}}><FolderOpen size={17}/>在 Finder 中显示</button><button role="menuitem" onClick={e=>{e.currentTarget.closest('details').open=false;if(activeDoc)void moveDocument(activeDoc,true);}}><Trash2 size={17}/>移到最近删除</button></div></details>
            {experimental&&<button className="primary-button" onClick={restoreToFeishu} disabled={!activeDoc||!!busy||view!=='editor'} title="实验功能：创建新副本后仍需核对保真"><FileText size={17}/><span>实验回导</span></button>}
          </div>
          {busyLabel && <span className="list-hint" role="status" aria-live="polite">{busyLabel}</span>}
        </header>

        {notice && <div className={`notice notice-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}><span>{notice.kind === 'error' ? <AlertCircle size={17} /> : <Check size={17} />}</span><p>{notice.message}{notice.link && <> <a href={notice.link} target="_blank" rel="noreferrer">{notice.linkText}</a></>}</p><button className="icon-button notice-close" onClick={() => setNotice(null)} aria-label="关闭提示"><X size={16} /></button></div>}

        {view==='editor'&&<>
        {activeAudit ? <CaptureDetails report={activeAudit} /> : activeSheetAudit ? <SheetCaptureDetails report={activeSheetAudit} /> : activeDoc && issueCount(activeDoc) > 0 && <div className="partial-banner"><AlertCircle size={17} /><span>此文件包含尚未完整转换的内容。请核对原始文件，再决定如何继续编辑。</span></div>}

        <section className={`workspace ${activeDoc?.kind === 'sheet' ? 'workspace-sheet' : ''} ${busy ? 'workspace-busy' : ''}`} inert={!!busy} aria-busy={!!busy} aria-label={activeDoc?.kind === 'sheet' ? '电子表格编辑区' : '文档编辑区'}>
          {!activeDoc && booted && <div className="empty-state"><FileText size={30} /><h1>打开或新建一个文件</h1><p>文件保存在本地设备中。</p></div>}
          {!booted && <div className="loading-state"><LoaderCircle className="spin" size={22} />正在打开本地文档…</div>}
          {activeDoc?.kind === 'slides' && <div className="deferred-state"><FileText size={28} /><h1>演示文稿编辑暂未开放</h1><p>这份文件仍保存在本地文档库中。当前版本可查看和编辑文档与电子表格。</p></div>}
          {activeDoc && <Suspense fallback={<div className="loading-state" role="status">正在加载编辑器…</div>}><EditorErrorBoundary key={`${activeDoc.id}:${activeDoc.kind}`}>
            {activeDoc.kind === 'document'
              ? <DocumentEditor ref={editorRef} value={activeDoc.content} onChange={content => { if (activeIdRef.current !== activeDoc.id) return; try { const current = libraryRef.current.find(doc => doc.id === activeDoc.id); if (current) updateActive(updateContent(current, content)); } catch { setNotice({ kind: 'error', message: '这次编辑无法应用，请检查内容后重试。' }); } }} />
              : activeDoc.kind === 'sheet'
                ? <SheetEditor ref={editorRef} value={activeDoc.content} onChange={content => { if (activeIdRef.current !== activeDoc.id) return; try { const current = libraryRef.current.find(doc => doc.id === activeDoc.id); if (current) updateActive(updateContent(current, content)); } catch { setNotice({ kind: 'error', message: '这次表格编辑无法应用，请检查内容后重试。' }); } }} />
                : null}
          </EditorErrorBoundary></Suspense>}
        </section>
        {activeDoc&&<div className="file-organization"><label>文件夹 <input aria-label="当前文件的文件夹" list="local-folders" placeholder={activeDoc.localMeta?.folder||'未分类'} value={folderDraft} maxLength={64} onChange={e=>setFolderDraft(e.target.value)}/></label><datalist id="local-folders">{projected.folders.map(name=><option key={name} value={name}/>)}</datalist><button className="secondary-button" disabled={!!busy} onClick={assignFolder}>保存文件夹</button></div>}
        </>}
        {view==='settings'&&<div className="utility-scroll"><ConnectionPanel experimental={experimental} onExperimental={changeExperimental}/></div>}
        {view==='tasks'&&<div className="utility-scroll"><TaskPanel onOpen={openSavedTask}/></div>}
        {view==='trash'&&<section className="utility-scroll utility-panel" aria-label="最近删除"><h1>最近删除</h1><p>文件仍保存在本机，可以恢复。本应用不提供自动清空或永久删除。</p>{!trashDocs.length&&<p>没有最近删除的文件。</p>}<ul className="task-list">{trashDocs.map(doc=><li key={doc.id}><strong>{doc.title}</strong><button className="secondary-button" disabled={!!busy} onClick={()=>moveDocument(doc,false)}>恢复文件</button></li>)}</ul></section>}

        <footer className="statusbar"><span>{activeDoc?.kind === 'sheet' ? '电子表格' : activeDoc?.kind === 'slides' ? '演示文稿（暂不支持编辑）' : activeDoc ? '文档' : '本地文档'}</span><span className="status-spacer" /><span>{count !== null ? `${count} 字` : ''}</span><span className="status-divider" /><span>100%</span></footer>
      </main>
    </div>
  );
}

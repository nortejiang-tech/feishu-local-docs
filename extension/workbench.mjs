import { capturePage } from './capture.mjs';
import { summarize } from './metrics.mjs';
import { serializeArchive, parseArchive, fileName, renderPreview, orderedBlocks, validateSnapshot, MAX_FILE_BYTES } from './archive.mjs';
import { makeDemo } from './demo.mjs';

const $ = id => document.getElementById(id);
const sourceValue = new URL(location.href).searchParams.get('sourceTab');
const sourceTab = sourceValue && /^\d+$/.test(sourceValue) ? Number(sourceValue) : null;
const sourceParams = new URL(location.href).searchParams;
const expectedSource = sourceParams.get('source');
const initialTitle = sourceParams.get('title');
const extensionMode = location.protocol === 'chrome-extension:' && typeof globalThis.chrome?.scripting?.executeScript === 'function';
let snapshot = null, busy = false, unsaved = false;
const labels = {
  COMPLETENESS_UNKNOWN: '源内容总量未知，尚不能证明完整采集', SOURCE_REVISION_NOT_LOCKED: '未锁定来源版本，采集时请勿编辑源文件',
  ASSET_BYTES_NOT_CAPTURED: '图片和附件原始文件尚未归档', ROUNDTRIP_NOT_IMPLEMENTED: '飞书恢复与往返验证待实现',
  SHEET_LOAD_COVERAGE_UNKNOWN: '工作表加载覆盖未知，请逐张打开后重新采集', ADVANCED_SHEET_FEATURES_NOT_CAPTURED: '冻结、隐藏、图表、条件格式等高级属性尚未采集',
  EMPTY_OR_UNLOADED_SHEET: '有工作表未读到内容，可能为空或尚未加载', FORMULA_COVERAGE_UNVERIFIED: '本次没有非空公式，公式能力尚未验收',
  EMBEDDED_CONTENT_NOT_CAPTURED: '嵌入对象仅有结构占位，未采集内部内容', BLOCK_LAYOUT_NOT_CAPTURED: '表格或分栏布局尚未重建',
  RICH_TEXT_RENDERING_PENDING: '富文本编码已保存，原样式渲染尚未验证', UNKNOWN_BLOCK_TYPE: '存在尚未适配的块类型',
  UNRESOLVED_CHILD: '部分子块关系未解析', TEXT_SHAPE_UNKNOWN: '部分文本结构未识别', RICH_TEXT_ATTRIBUTE_UNMAPPED: '部分富文本属性未映射',
  NON_SCALAR_VALUE: '部分复杂单元格值未采集', FORMULA_SHAPE_UNKNOWN: '部分公式格式未识别', SHEET_NAME_UNAVAILABLE: '部分工作表名称不可读',
  SYNTHETIC_DEMO: '合成演示内容，用于界面与文件流程测试', LINK_DETAILS_NOT_CAPTURED: '链接查询参数或锚点未保存'
};
const errors = {
  UNSUPPORTED_SOURCE: '请回到飞书文档、表格或 Wiki 页面，重新点击扩展图标。',
  SLIDES_ADAPTER_PENDING: '幻灯片适配器待接入。该类型不会生成归档文件。',
  MODEL_UNAVAILABLE: '未找到可用模型。请等待源页面加载，或在源页面重新点击扩展。',
  MODEL_SHAPE_CHANGED: '页面模型与当前适配器不一致，采集已停止。',
  PAGE_READ_FAILED: '页面读取失败，未保存不可靠的结果。', SOURCE_CHANGED: '采集期间来源发生变化，请保持源页面稳定后重试。',
  CAPTURE_TIMEOUT: '采集超过时间上限，未生成截断文件。', CELL_RANGE_LIMIT: '工作簿超出本开发版的 15 万坐标范围上限。',
  ARCHIVE_HASH_MISMATCH: '归档内容与校验值不一致，文件未载入。', ARCHIVE_INVALID: '归档结构不合法，文件未载入。',
  ARCHIVE_VERSION_UNSUPPORTED: '文件不是当前版本的归档包。', ARCHIVE_TOO_LARGE: '文件超过本开发版 24 MB 上限。'
};

function status(message, isError = false) { $('task-status').textContent = message; $('task-status').classList.toggle('error', isError); }
function setBusy(value) {
  busy = value;
  $('capture').disabled = value || !extensionMode || sourceTab === null;
  for (const id of ['open-archive', 'demo-document', 'demo-sheet']) $(id).disabled = value;
  for (const id of ['download-json', 'download-html']) $(id).disabled = value || !snapshot;
}
function clearResult() {
  snapshot = null; unsaved = false;
  $('result').hidden = true; $('empty-result').hidden = false; $('issues-section').hidden = true;
  $('result-badge').textContent = '尚未采集'; $('result-badge').className = 'badge neutral';
  $('download-json').disabled = true; $('download-html').disabled = true;
}
function metric(value, label) {
  const box = document.createElement('div'); box.className = 'metric';
  const strong = document.createElement('span'); strong.textContent = Number(value).toLocaleString('zh-CN');
  const small = document.createElement('small'); small.textContent = label; box.append(strong, small); return box;
}
function show(s, origin = 'capture') {
  validateSnapshot(s); snapshot = s; unsaved = origin !== 'file';
  const demo = s.issues.some(x => x.code === 'SYNTHETIC_DEMO');
  $('empty-result').hidden = true; $('result').hidden = false; $('issues-section').hidden = false;
  $('result-badge').textContent = demo ? '合成演示' : 'PENDING · 部分采集';
  $('result-badge').className = 'badge warning'; $('result-title').textContent = s.source.title;
  const counts = summarize(s);
  $('metrics').replaceChildren(...(s.kind === 'document' ? [metric(counts.items, '已捕获块'), metric(counts.textCharacters, '正文字符'), metric(s.issues.length, '缺口种类')] : [metric(counts.items, '工作表'), metric(counts.nonemptyValues, '非空值'), metric(counts.formulas, '公式')]));
  $('preview').replaceChildren();
  if (s.kind === 'document') {
    const rows = orderedBlocks(s).slice(0, 12);
    $('preview-label').textContent = `前 ${rows.length} 个块 · 非原排版`;
    for (const { block } of rows) {
      const type = document.createElement('small'); type.textContent = block.type;
      const p = document.createElement('p'); p.textContent = block.text || `［${block.type}：结构占位］`;
      $('preview').append(type, p);
    }
  } else {
    $('preview-label').textContent = '各表前 8 个内容单元格';
    for (const sheet of s.model.sheets) {
      const label = document.createElement('small'); label.textContent = `${sheet.name} · ${sheet.rows} × ${sheet.columns}`; $('preview').append(label);
      const cells = sheet.cells.filter(c => c.value !== null && c.value !== '' || c.formula || c.display).slice(0, 8);
      if (!cells.length) { const p = document.createElement('p'); p.textContent = '没有读到内容，可能为空或尚未加载。'; $('preview').append(p); }
      for (const cell of cells) {
        const row = document.createElement('div'); row.className = 'preview-row';
        const at = document.createElement('span'); at.textContent = `${cell.row + 1},${cell.column + 1}`;
        const value = document.createElement('span'); value.textContent = cell.display + (cell.formula ? `  ${cell.formula}` : ''); row.append(at, value); $('preview').append(row);
      }
    }
  }
  $('issues').replaceChildren();
  for (const issue of s.issues) {
    const li = document.createElement('li'); li.textContent = labels[issue.code] || '未识别的问题类型';
    const count = document.createElement('span'); count.textContent = `× ${issue.count} · ${issue.code}`; li.append(count); $('issues').append(li);
  }
  setBusy(false);
  status(origin === 'file' ? '归档已重新打开，内容校验一致。完整性与保真状态仍为 PENDING。' : demo ? '合成样本已载入；这里没有读取真实云文档。' : '已捕获当前可读结构。请检查缺口后保存；完整性尚未验证。');
}
function download(contents, mime, suffix) {
  const blob = new Blob([contents], { type: mime });
  if (blob.size > MAX_FILE_BYTES) throw new Error('ARCHIVE_TOO_LARGE');
  const url = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href = url; a.download = fileName(snapshot.source.title, suffix); document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  status('下载已发起，请在 Chrome 下载列表确认文件。');
}

$('capture').addEventListener('click', async () => {
  if (busy || !extensionMode || sourceTab === null) return;
  clearResult(); setBusy(true); status('正在读取源页面中的已加载结构，请保持源页面稳定…');
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId: sourceTab }, world: 'MAIN', func: capturePage, args: [{ expectedSource }] });
    const result = results.find(x => x.frameId === 0)?.result;
    if (!result?.ok) throw new Error(result?.code || 'PAGE_READ_FAILED');
    show(result.snapshot);
  } catch (error) {
    clearResult(); status(errors[error?.message] || '采集未完成。页面可能已关闭、授权失效或超出容量限制，请在源页面重新点击扩展。', true);
  } finally { setBusy(false); }
});
$('return-source').addEventListener('click', async () => {
  if (extensionMode && sourceTab !== null) {
    try { const tab = await chrome.tabs.update(sourceTab, { active: true }); await chrome.windows.update(tab.windowId, { focused: true }); }
    catch { status('源页面已不可访问，请重新打开并点击扩展。', true); }
  }
});
for (const kind of ['document', 'sheet']) $(`demo-${kind}`).addEventListener('click', () => { clearResult(); show(makeDemo(kind), 'demo'); });
$('download-json').addEventListener('click', async () => {
  if (!snapshot || busy) return; setBusy(true);
  try { download(await serializeArchive(snapshot), 'application/json;charset=utf-8', 'fdocpack.json'); }
  catch (e) { status(errors[e.message] || '归档生成失败。', true); }
  finally { setBusy(false); }
});
$('download-html').addEventListener('click', () => {
  if (!snapshot || busy) return;
  try { download(renderPreview(snapshot), 'text/html;charset=utf-8', 'html'); }
  catch (e) { status(errors[e.message] || '预览生成失败。', true); }
});
$('open-archive').addEventListener('click', () => $('archive-file').click());
$('archive-file').addEventListener('change', async event => {
  const file = event.target.files?.[0]; if (!file) return;
  clearResult(); setBusy(true);
  try { if (file.size > MAX_FILE_BYTES) throw new Error('ARCHIVE_TOO_LARGE'); show(await parseArchive(await file.text()), 'file'); }
  catch (e) { status(errors[e.message] || '文件读取失败。', true); }
  finally { event.target.value = ''; setBusy(false); }
});
window.addEventListener('beforeunload', event => { if (busy || unsaved) { event.preventDefault(); event.returnValue = ''; } });

if (extensionMode && sourceTab !== null) {
  try {
    const tab = await chrome.tabs.get(sourceTab);
    if (!expectedSource || new URL(tab.url).origin + new URL(tab.url).pathname !== expectedSource) throw new Error('SOURCE_CHANGED');
    $('source-title').textContent = initialTitle || tab.title || '当前飞书页面';
    $('source-description').textContent = '点击采集后，仅从这个标签页读取已加载的结构。';
    $('source-badge').textContent = '已连接标签页'; $('return-source').disabled = false; setBusy(false);
  } catch { status('源标签页已变化或关闭，请回到目标飞书页面重新点击扩展。', true); }
} else {
  $('source-badge').textContent = '本地预览'; $('environment-note').hidden = false;
  $('environment-note').textContent = '当前为本地预览模式。可试用合成样本、下载与重新打开归档；采集真实飞书页面需要在 Chrome 中加载扩展。';
}

import { validateSnapshot, orderedBlocks } from '../extension/archive.mjs';
import { createDocument, validateDocument } from './model.mjs';
import { buildEditableTable } from './document-table.mjs';
import { assembleDocumentTree } from './document-tree.mjs';
import { decodeFeishuRichText } from './document-richtext.mjs';
import { buildCaptureAudit } from './capture-audit.mjs';
import { validateCapturedEmbeds } from './embedded-data.mjs';
import { MAX_JSON_VALUES } from './json-limits.mjs';

const MAX_CAPTURE_BYTES = 32 * 1024 * 1024;
const MAX_CAPTURE_DEPTH = 64;
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
function invalid() { throw new Error('IMPORT_INVALID'); }
function checkJson(value, depth = 0, budget = { count: 0 }) {
  if (++budget.count > MAX_JSON_VALUES) throw new Error('IMPORT_TOO_LARGE');
  if (depth > MAX_CAPTURE_DEPTH) invalid();
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') { if (value.length > 8_000_000) invalid(); return; }
  if (typeof value === 'number') { if (!Number.isFinite(value)) invalid(); return; }
  if (Array.isArray(value)) { for (const child of value) checkJson(child, depth + 1, budget); return; }
  if (!value || typeof value !== 'object') invalid();
  for (const [key, child] of Object.entries(value)) { if (forbidden.has(key)) invalid(); checkJson(child, depth + 1, budget); }
}
function deepCopy(value) { return JSON.parse(JSON.stringify(value)); }
function textNode(value) { return value ? [{ type: 'text', text: value }] : []; }
function headingLevel(type) {
  const match = /^(?:heading|h)([1-6])$/i.exec(type);
  return match ? Number(match[1]) : null;
}
function addIssue(issues, code, count = 1) { issues.set(code, (issues.get(code) || 0) + count); }
function issueArray(issues) { return [...issues].map(([code, count]) => ({ code, count })); }

function convertDocument(snapshot, capturedAssets = [], capturedEmbeds = []) {
  const assetsById=new Map(capturedAssets.map(asset=>[asset.sourceId,asset]));
  const embedsById=new Map(capturedEmbeds.map(embed=>[embed.sourceId,embed]));
  const entries = orderedBlocks(snapshot);
  const issues = new Map();
  const blocksById = new Map(snapshot.model.blocks.map(block => [block.id, block]));
  for (const issue of snapshot.issues) if (issue.code !== 'RICH_TEXT_RENDERING_PENDING') addIssue(issues, issue.code, issue.count);
  let nodes = [];
  const consumed = new Set();
  function convertBlock(block, issueSink = issues) {
    const type = block.type.toLowerCase();
    const decoded = decodeFeishuRichText(block.richText, block.text);
    for (const code of decoded.issues) addIssue(issueSink, code);
    const ownText = decoded.content;
    const align = { left:'left', center:'center', right:'right', justify:'justify' }[block.properties?.align];
    const paragraph = { type:'paragraph', ...(align ? {attrs:{textAlign:align}} : {}), ...(ownText.length ? {content:ownText} : {}) };
    const level = headingLevel(type);
    if (level) return [{ type: 'heading', attrs: { level, ...(align ? {textAlign:align} : {}) }, ...(ownText.length ? { content: ownText } : {}) }];
    if(type==='whiteboard') {
      const embed=embedsById.get(block.id);
      if(embed?.status==='STRUCTURE_CANDIDATE')return [{type:'localWhiteboard',attrs:{sourceId:block.id,payload:embed.payload,images:embed.images||[]}}];
    }
    if(type==='bitable'){
      const embed=embedsById.get(block.id);
      if(embed?.status==='VIEW_SNAPSHOT')return [{type:'localBase',attrs:{sourceId:block.id,payload:embed.payload}}];
    }
    if (type === 'image') {
      const asset=assetsById.get(block.id);
      if (asset?.dataUrl) {
        if (asset.code) addIssue(issueSink,asset.code);
        const dimensions={};
        for(const name of ['width','height']) if(Number.isFinite(block.resource?.[name]) && block.resource[name]>0 && block.resource[name]<=10000) dimensions[name]=block.resource[name];
        if (block.resource?.rotation || block.resource?.crop?.some(value=>value!==0)) addIssue(issueSink,'IMAGE_TRANSFORM_VERIFICATION_PENDING');
        return [{type:'image',attrs:{src:asset.dataUrl,alt:String(block.resource?.name || '').slice(0,200),...dimensions}}];
      }
      addIssue(issueSink,asset?.code || 'RESOURCE_BYTES_MISSING');
    }
    if (type === 'divider') return [{ type:'horizontalRule' }];
    if (type === 'todo') return [{type:'taskList',content:[{type:'taskItem',attrs:{checked:block.properties?.checked === true},content:[paragraph]}]}];
    if (type === 'code') return [{ type: 'codeBlock', ...(ownText.length ? { content: ownText } : {}) }];
    if (type === 'quote') return [{ type: 'blockquote', content: [{ type: 'paragraph', ...(ownText.length ? { content: ownText } : {}) }] }];
    if (type === 'bullet' || type === 'ordered') {
      const list = type === 'bullet' ? 'bulletList' : 'orderedList';
      return [{ type: list, content: [{ type: 'listItem', content: [{ type: 'paragraph', ...(ownText.length ? { content: ownText } : {}) }] }] }];
    }
    if (['page', 'root', 'document', 'divider'].includes(type)) return ownText.length ? [{ type: 'paragraph', content: ownText }] : [];
    if (['text', 'paragraph', 'title'].includes(type)) return [paragraph];
    addIssue(issueSink, 'UNSUPPORTED_BLOCK_PRESERVED');
    return [
      { type: 'preservedBlock', attrs: { sourceId: block.id, sourceType: block.type, label: block.resource?.name || block.type } },
      ...(ownText.length ? [{ type: 'paragraph', content: ownText }] : []),
    ];
  }
  const treeIssues = new Map(issues);
  try {
    const assembled=assembleDocumentTree(snapshot.model.blocks,snapshot.model.rootIds,block=>{
      if(block.type.toLowerCase()==='table' && block.table) {
        const local=new Map();
        const table=buildEditableTable(block,blocksById,child=>convertBlock(child,local));
        if(table) {
          for(const [code,count] of local)addIssue(treeIssues,code,count);
          for(const code of table.issues)addIssue(treeIssues,code);
          return {nodes:[table.node],consumed:[...table.consumed]};
        }
        addIssue(treeIssues,'TABLE_CONVERSION_INCOMPLETE');
      }
      const own=convertBlock(block,treeIssues);
      const type=block.type.toLowerCase();
      return {nodes:['bullet','ordered','todo'].includes(type) ? own[0].content[0].content : own};
    });
    nodes=assembled.nodes;
    issues.clear();for(const [code,count] of treeIssues)issues.set(code,count);
    for(const code of assembled.issues)addIssue(issues,code);
  } catch(error) {
    if(error?.message!=='DOCUMENT_TREE_INVALID')throw error;
    addIssue(issues,'DOCUMENT_TREE_FALLBACK');
  // orderedBlocks is iterative and de-duplicates cycles/orphans. Flattening to top-level
  // nodes avoids creating invalid textblock nesting from legacy parent-child layout.
  for (const { block } of entries) {
    if (consumed.has(block.id)) continue;
    if (block.type.toLowerCase() === 'table' && block.table) {
      const tableIssues = new Map();
      const table = buildEditableTable(block, blocksById, child => convertBlock(child, tableIssues));
      if (table) {
        nodes.push(table.node);
        for (const id of table.consumed) consumed.add(id);
        for (const [code, count] of tableIssues) addIssue(issues, code, count);
        for (const issue of table.issues) addIssue(issues, issue);
        continue;
      }
      addIssue(issues, 'TABLE_CONVERSION_INCOMPLETE');
    }
    // Legacy missing-geometry tables and invalid tables retain the old visible
    // placeholder plus the original flat traversal of all descendant blocks.
    nodes.push(...convertBlock(block));
  }
  }
  if (!nodes.length) nodes.push({ type: 'paragraph' });
  addIssue(issues, 'DOCUMENT_LAYOUT_VERIFICATION_PENDING');
  return { content: { type: 'doc', content: nodes }, issues: issueArray(issues) };
}
function colorStyle(value) {
  if (typeof value !== 'string' || value.length > 128) return undefined;
  const s = value.trim();
  if (/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(s) || /^rgba?\([\d\s.,%]+\)$/i.test(s) || /^[a-z]{1,24}$/i.test(s)) return { rgb: s };
  return undefined;
}
function borderStyle(value) {
  if (!value || typeof value !== 'object') return undefined;
  const rawStyle = value.style ?? value._style;
  const labels = { none: 0, thin: 1, hair: 2, dotted: 3, dashed: 4, 'dash-dot': 5, 'dash_dot': 5, 'dash-dot-dot': 6, 'dash_dot_dot': 6, double: 7, medium: 8, 'medium-dashed': 9, 'medium-dash-dot': 10, 'medium-dash-dot-dot': 11, 'slant-dash-dot': 12, thick: 13 };
  const numericStyle = Number.isInteger(rawStyle) ? rawStyle : labels[String(rawStyle || '').toLowerCase()];
  const rgb = colorStyle(value.color ?? value._color);
  return numericStyle !== undefined && numericStyle >= 0 && numericStyle <= 13 ? { s: numericStyle, cl: rgb || { rgb: '#000000' } } : undefined;
}
function safeStyle(style) {
  if (!style || typeof style !== 'object' || Array.isArray(style)) return null;
  const out = {};
  const font = typeof style._font === 'string' ? style._font : '';
  const size = /(?:^|\s)(\d+(?:\.\d+)?)\s*(?:px|pt)\b/i.exec(font);
  const family = font.replace(/(?:^|\s)(?:bold|italic|normal)(?=\s|$)/gi, ' ').replace(/(?:^|\s)\d+(?:\.\d+)?\s*(?:px|pt)(?=\s|$)/gi, ' ').trim();
  if (family && !/^(?:underline|line-through)$/i.test(family)) out.ff = family.replace(/^['"]|['"]$/g, '').slice(0, 256);
  if (size) out.fs = Number(size[1]);
  if (/\bbold\b/i.test(font)) out.bl = 1;
  if (/\bitalic\b/i.test(font)) out.it = 1;
  if (typeof style._textDecoration === 'string') {
    const decoration = style._textDecoration.toLowerCase();
    if (decoration.includes('underline')) out.ul = { s: 1, t: 12 };
    if (decoration.includes('line-through') || decoration.includes('strikethrough')) out.st = { s: 1, t: 12 };
  }
  const foreground = colorStyle(style._foreColor), background = colorStyle(style._backColor);
  if (foreground) out.cl = foreground;
  if (background) out.bg = background;
  const horizontal = { left: 1, center: 2, right: 3, justify: 4, justified: 4 }[String(style._hAlign || '').toLowerCase()];
  const vertical = { top: 1, middle: 2, center: 2, bottom: 3 }[String(style._vAlign || '').toLowerCase()];
  if (horizontal !== undefined) out.ht = horizontal;
  if (vertical !== undefined) out.vt = vertical;
  if (style._wordWrap === true) out.tb = 3;
  else if (style._wordWrap === false) out.tb = 2;
  if (typeof style._formatter === 'string' && style._formatter.length <= 256) out.n = { pattern: style._formatter };
  const bd = {};
  for (const [source, target] of [['_borderTop', 't'], ['_borderRight', 'r'], ['_borderBottom', 'b'], ['_borderLeft', 'l']]) {
    const border = borderStyle(style[source]);
    if (border) bd[target] = border;
  }
  if (Object.keys(bd).length) out.bd = bd;
  return Object.keys(out).length ? out : null;
}
function dimensionData(values, key) {
  const result = Object.create(null);
  if (!Array.isArray(values)) return result;
  for (let index = 0; index < values.length; index++) if (typeof values[index] === 'number' && Number.isFinite(values[index]) && values[index] >= 0) result[String(index)] = { [key]: values[index] };
  return result;
}
function convertSheet(snapshot) {
  const source = snapshot.model;
  const workbookId = 'imported-workbook';
  const sheets = Object.create(null), sheetOrder = [], styles = {};
  const styleIds = new Map();
  let styleSequence = 0;
  for (let index = 0; index < source.sheets.length; index++) {
    const from = source.sheets[index];
    const id = `sheet-${index + 1}`;
    const cellData = Object.create(null), rowData = Object.create(null), columnData = Object.create(null);
    for (const cell of from.cells) {
      const rowKey = String(cell.row), colKey = String(cell.column);
      if (!cellData[rowKey]) cellData[rowKey] = Object.create(null);
      const target = {};
      if (cell.value !== null) target.v = cell.value;
      if (cell.formula !== null) target.f = cell.formula;
      if (typeof cell.value === 'number') target.t = 2;
      else if (typeof cell.value === 'boolean') target.t = 3;
      else if (typeof cell.value === 'string') target.t = 1;
      const style = safeStyle(cell.style);
      if (style) {
        const styleKey = JSON.stringify(style);
        let sid = styleIds.get(styleKey);
        if (!sid) { sid = `style-${++styleSequence}`; styleIds.set(styleKey, sid); styles[sid] = { ...style }; }
        target.s = sid;
      }
      // Preserve display text when no raw value was captured; it is still a useful visible value.
      if (cell.value === null && cell.display) target.v = cell.display;
      cellData[rowKey][colKey] = target;
    }
    Object.assign(rowData, dimensionData(from.rowHeights, 'h'));
    Object.assign(columnData, dimensionData(from.columnWidths, 'w'));
    sheets[id] = { id, name: from.name, rowCount: Math.max(1, from.rows), columnCount: Math.max(1, from.columns), cellData, mergeData: from.merges.map(m => ({ startRow: m.row, endRow: m.row + m.rows - 1, startColumn: m.column, endColumn: m.column + m.columns - 1 })), rowData, columnData };
    sheetOrder.push(id);
  }
  const issues = new Map();
  for (const issue of snapshot.issues) addIssue(issues, issue.code, issue.count);
  addIssue(issues, 'SHEET_STYLE_AND_LOAD_COVERAGE_PARTIAL');
  return { content: { id: workbookId, name: snapshot.source.title, appVersion: typeof source.appVersion === 'string' ? source.appVersion : '1.0.3', locale: typeof source.locale === 'string' ? source.locale : 'zhCN', styles, sheetOrder, sheets }, issues: issueArray(issues) };
}

export function importSnapshot(snapshot, options = {}) {
  const assets=options.assets || [];
  if(!Array.isArray(assets) || assets.length>200) invalid();
  const sourceIds=new Set();
  for(const asset of assets) {
    if(!asset || typeof asset.sourceId!=='string' || asset.sourceId.length>256 || sourceIds.has(asset.sourceId)
        || !['MISSING','PREVIEW','ORIGINAL_CANDIDATE'].includes(asset.status) || typeof asset.code!=='string' || !/^[A-Z_]{1,128}$/.test(asset.code)) invalid();
    sourceIds.add(asset.sourceId);
    if(asset.dataUrl!==undefined && (!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]*={0,2}$/.test(asset.dataUrl) || asset.dataUrl.length>8_000_000
       || !Number.isSafeInteger(asset.byteLength) || asset.byteLength<1 || asset.byteLength>6*1024*1024 || !/^[a-f0-9]{64}$/.test(asset.sha256))) invalid();
  }
  validateSnapshot(snapshot);
  const embeds=validateCapturedEmbeds(snapshot,options.embeds||[]);
  checkJson(snapshot);
  let captureText;
  try { captureText = JSON.stringify(snapshot); } catch { invalid(); }
  if (new TextEncoder().encode(captureText).byteLength > MAX_CAPTURE_BYTES) throw new Error('IMPORT_TOO_LARGE');
  const capture = deepCopy(snapshot);
  const doc = createDocument(snapshot.kind, snapshot.source.title);
  const converted = snapshot.kind === 'document' ? convertDocument(snapshot, assets, embeds) : convertSheet(snapshot);
  for(const embed of embeds) {
    converted.issues.push({code:embed.code,count:1});
    if(embed.kind==='whiteboard'&&embed.resourceCount>0)converted.issues.push({code:'WHITEBOARD_RESOURCE_BYTES_PENDING',count:embed.resourceCount});
  }
  const imported = {
    ...doc,
    content: converted.content,
    provenance: { origin: 'feishu-capture', capture, roundtrip: 'PENDING',
      resources:assets.map(asset=>Object.fromEntries(['sourceId','kind','status','code','byteLength','sha256'].filter(key=>asset[key]!==undefined).map(key=>[key,asset[key]]))),
      embedded:embeds.map(embed=>({...embed,...(Array.isArray(embed.images)?{images:embed.images.map(image=>Object.fromEntries(['resourceId','status','code','byteLength','sha256'].filter(key=>image[key]!==undefined).map(key=>[key,image[key]])))}:{})})),
      ...(snapshot.kind==='document'?{audit:buildCaptureAudit(snapshot,assets,converted.content,embeds)}:{}) },
    issues: converted.issues
  };
  validateDocument(imported);
  return imported;
}

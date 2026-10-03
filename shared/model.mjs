import {validateWhiteboardPayload,validateWhiteboardImages} from './embedded-data.mjs';
import {validateBasePayload} from './base-data.mjs';
import {MAX_JSON_VALUES} from './json-limits.mjs';
export const FORMAT = 'local-feishu';
export const VERSION = 2;
export const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_DEPTH = 64;
const MAX_ITEMS = 200000;
const MAX_STRING = 8_000_000;
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);
const supportedNodes = new Set(['doc', 'paragraph', 'heading', 'text', 'bulletList', 'orderedList', 'listItem', 'blockquote', 'codeBlock', 'hardBreak', 'horizontalRule', 'table', 'tableRow', 'tableCell', 'tableHeader', 'image', 'taskList', 'taskItem', 'preservedBlock', 'columnLayout', 'column', 'localWhiteboard', 'localBase']);
const supportedMarks = new Set(['bold', 'italic', 'underline', 'strike', 'code', 'textStyle', 'color']);

function fail(code) { throw new Error(code); }
function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function isText(v, max = MAX_STRING) { return typeof v === 'string' && v.length <= max; }
function isIsoTimestamp(v) { return isText(v, 64) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(v) && !Number.isNaN(Date.parse(v)); }
function plainJson(value, depth = 0, budget = { count: 0 }) {
  if (++budget.count > MAX_JSON_VALUES) fail('DOCUMENT_TOO_LARGE');
  if (depth > MAX_DEPTH) fail('DOCUMENT_INVALID');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value === 'string' && value.length > MAX_STRING) fail('DOCUMENT_INVALID');
    return;
  }
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail('DOCUMENT_INVALID'); return; }
  if (Array.isArray(value)) { for (const item of value) plainJson(item, depth + 1, budget); return; }
  if (!isObject(value)) fail('DOCUMENT_INVALID');
  for (const [key, item] of Object.entries(value)) {
    if (forbiddenKeys.has(key)) fail('DOCUMENT_INVALID');
    plainJson(item, depth + 1, budget);
  }
}
function checkDataImage(src) {
  if (typeof src !== 'string' || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]*={0,2}$/.test(src) || src.length > 12 * 1024 * 1024) fail('DOCUMENT_INVALID');
}
function validateTiptap(value, depth = 0, counter = { count: 0 }) {
  if (depth > MAX_DEPTH || ++counter.count > MAX_ITEMS || !isObject(value) || !isText(value.type, 64) || !supportedNodes.has(value.type)) fail('DOCUMENT_INVALID');
  plainJson(value, 0);
  if (value.type === 'text' && !isText(value.text)) fail('DOCUMENT_INVALID');
  if (value.type === 'heading' && (!isObject(value.attrs) || !Number.isInteger(value.attrs.level) || value.attrs.level < 1 || value.attrs.level > 6)) fail('DOCUMENT_INVALID');
  if (value.type === 'image') checkDataImage(value.attrs?.src);
  if(value.type==='localWhiteboard') {
    try{validateWhiteboardPayload(value.attrs?.payload);validateWhiteboardImages(value.attrs?.images||[]);}catch{fail('DOCUMENT_INVALID');}
    if(!isText(value.attrs?.sourceId,256))fail('DOCUMENT_INVALID');
  }
  if(value.type==='localBase'){
    try{validateBasePayload(value.attrs?.payload);}catch{fail('DOCUMENT_INVALID');}
    if(!isText(value.attrs?.sourceId,256))fail('DOCUMENT_INVALID');
  }
  if(value.type === 'column' && (!Number.isFinite(value.attrs?.widthRatio) || value.attrs.widthRatio<=0 || value.attrs.widthRatio>1))fail('DOCUMENT_INVALID');
  if (value.attrs !== undefined && !isObject(value.attrs)) fail('DOCUMENT_INVALID');
  if (value.marks !== undefined) {
    if (!Array.isArray(value.marks) || value.marks.length > 100) fail('DOCUMENT_INVALID');
    for (const mark of value.marks) {
      if (!isObject(mark) || !supportedMarks.has(mark.type) || mark.attrs !== undefined && !isObject(mark.attrs)) fail('DOCUMENT_INVALID');
      plainJson(mark, 0);
    }
  }
  if (value.content !== undefined) {
    if (!Array.isArray(value.content)) fail('DOCUMENT_INVALID');
    for (const child of value.content) validateTiptap(child, depth + 1, counter);
  }
}
function validateSheet(content) {
  if (!isObject(content) || !isText(content.id, 256) || !isText(content.name, 256) || !isText(content.appVersion, 128) || !isText(content.locale, 64) || !isObject(content.styles) || !Array.isArray(content.sheetOrder) || !isObject(content.sheets)) fail('DOCUMENT_INVALID');
  const ids = Object.keys(content.sheets);
  if (!ids.length || ids.length > 100 || content.sheetOrder.length !== ids.length || new Set(content.sheetOrder).size !== ids.length || content.sheetOrder.some(id => !Object.hasOwn(content.sheets, id))) fail('DOCUMENT_INVALID');
  let populated = 0, mergedArea = 0;
  for (const [id, sheet] of Object.entries(content.sheets)) {
    if (!isObject(sheet) || sheet.id !== id || !isText(sheet.name, 256) || !Number.isInteger(sheet.rowCount) || sheet.rowCount < 1 || sheet.rowCount > 100000 || !Number.isInteger(sheet.columnCount) || sheet.columnCount < 1 || sheet.columnCount > 10000 || !isObject(sheet.cellData) || !Array.isArray(sheet.mergeData) || sheet.mergeData.length > 20000 || sheet.rowData !== undefined && !isObject(sheet.rowData) || sheet.columnData !== undefined && !isObject(sheet.columnData)) fail('DOCUMENT_INVALID');
    for(const [collection,limit,dimension] of [[sheet.rowData,sheet.rowCount,'h'],[sheet.columnData,sheet.columnCount,'w']]) {
      for(const [key,item] of Object.entries(collection||{})) {
        if(!/^\d+$/.test(key)||Number(key)>=limit||item!==null&&!isObject(item))fail('DOCUMENT_INVALID');
        if(item?.[dimension]!=null&&(!Number.isFinite(item[dimension])||item[dimension]<0||item[dimension]>10000))fail('DOCUMENT_INVALID');
      }
    }
    for (const [rowKey, row] of Object.entries(sheet.cellData)) {
      if (!/^\d+$/.test(rowKey) || Number(rowKey) >= sheet.rowCount || row !== null && !isObject(row)) fail('DOCUMENT_INVALID');
      if (row === null) continue;
      for (const [colKey, cell] of Object.entries(row)) {
        if (!/^\d+$/.test(colKey) || Number(colKey) >= sheet.columnCount || cell !== null && !isObject(cell)) fail('DOCUMENT_INVALID');
        if (cell === null) continue;
        populated++;
        if (populated > 150000 || cell.v !== undefined && !(cell.v === null || typeof cell.v === 'string' && isText(cell.v) || typeof cell.v === 'boolean' || typeof cell.v === 'number' && Number.isFinite(cell.v)) || cell.f !== undefined && !isText(cell.f) || cell.t !== undefined && !(typeof cell.t === 'string' || Number.isInteger(cell.t))) fail('DOCUMENT_INVALID');
      }
    }
    for (const merge of sheet.mergeData) {
      if (!isObject(merge) || !Number.isInteger(merge.startRow) || !Number.isInteger(merge.endRow) || !Number.isInteger(merge.startColumn) || !Number.isInteger(merge.endColumn) || merge.startRow < 0 || merge.startRow > merge.endRow || merge.endRow >= sheet.rowCount || merge.startColumn < 0 || merge.startColumn > merge.endColumn || merge.endColumn >= sheet.columnCount) fail('DOCUMENT_INVALID');
      mergedArea += (merge.endRow - merge.startRow + 1) * (merge.endColumn - merge.startColumn + 1);
      if (mergedArea > 150000) fail('DOCUMENT_TOO_LARGE');
    }
  }
}
function validateSlides(content) {
  if (!isObject(content) || !Number.isFinite(content.width) || !Number.isFinite(content.height) || content.width <= 0 || content.width > 10000 || content.height <= 0 || content.height > 10000 || !Array.isArray(content.pages) || content.pages.length > 1000) fail('DOCUMENT_INVALID');
  let count = 0;
  for (const page of content.pages) {
    if (!isObject(page) || !isText(page.id, 256) || !isText(page.background, 64) || !Array.isArray(page.elements)) fail('DOCUMENT_INVALID');
    for (const el of page.elements) {
      if (!isObject(el) || !isText(el.id, 256) || !['text', 'rect', 'ellipse', 'image'].includes(el.type)) fail('DOCUMENT_INVALID');
      if (++count > 10000) fail('DOCUMENT_INVALID');
      for (const n of ['x', 'y', 'width', 'height', 'rotation', 'fontSize']) if (el[n] !== undefined && (!Number.isFinite(el[n]) || Math.abs(el[n]) > 10000)) fail('DOCUMENT_INVALID');
      if (el.src !== undefined) checkDataImage(el.src);
      if (el.text !== undefined && !isText(el.text)) fail('DOCUMENT_INVALID');
    }
  }
}
function canonical(doc) { return JSON.stringify(doc); }
async function sha256(text) {
  if (!globalThis.crypto?.subtle && globalThis.localDocsNative?.request) {
    const value = await globalThis.localDocsNative.request('sha256', { text });
    if (!/^[a-f0-9]{64}$/.test(value)) fail('CRYPTO_UNAVAILABLE');
    return value;
  }
  if (!globalThis.crypto?.subtle) fail('CRYPTO_UNAVAILABLE');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
}
function cloneJson(value) { return JSON.parse(JSON.stringify(value)); }

export function createDocument(kind = 'document', title = '未命名文档') {
  if (!['document', 'sheet', 'slides'].includes(kind)) fail('DOCUMENT_INVALID');
  const now = new Date().toISOString();
  let content;
  if (kind === 'document') content = { type: 'doc', content: [{ type: 'paragraph' }] };
  else if (kind === 'sheet') {
    const id = globalThis.crypto.randomUUID(), sheetId = globalThis.crypto.randomUUID();
    content = { id, name: String(title || '未命名文档').slice(0, 256), appVersion: '1.0.3', locale: 'zhCN', styles: {}, sheetOrder: [sheetId], sheets: { [sheetId]: { id: sheetId, name: 'Sheet1', rowCount: 100, columnCount: 26, cellData: {}, mergeData: [], rowData: {}, columnData: {} } } };
  } else content = { width: 1280, height: 720, pages: [{ id: globalThis.crypto.randomUUID(), background: '#ffffff', elements: [] }] };
  const doc = { id: globalThis.crypto.randomUUID(), kind, title: String(title || '未命名文档').slice(0, 1000), createdAt: now, updatedAt: now, revision: 0, content, provenance: { origin: 'local' }, issues: [] };
  validateDocument(doc);
  return doc;
}

export function validateDocument(doc) {
  plainJson(doc);
  if (!isObject(doc) || !isText(doc.id, 36) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(doc.id) || !['document', 'sheet', 'slides'].includes(doc.kind) || !isText(doc.title, 1000) || !isIsoTimestamp(doc.createdAt) || !isIsoTimestamp(doc.updatedAt) || !Number.isSafeInteger(doc.revision) || doc.revision < 0 || !isObject(doc.provenance) || !Array.isArray(doc.issues) || doc.issues.length > 1000) fail('DOCUMENT_INVALID');
  if (!doc.provenance.origin || !isText(doc.provenance.origin, 64)) fail('DOCUMENT_INVALID');
  for (const issue of doc.issues) if (!isObject(issue) || !isText(issue.code, 128) || !Number.isSafeInteger(issue.count) || issue.count < 0) fail('DOCUMENT_INVALID');
  if (doc.kind === 'document') {
    if (!isObject(doc.content) || doc.content.type !== 'doc' || !Array.isArray(doc.content.content)) fail('DOCUMENT_INVALID');
    validateTiptap(doc.content);
  } else if (doc.kind === 'sheet') validateSheet(doc.content);
  else validateSlides(doc.content);
  if (new TextEncoder().encode(canonical(doc)).byteLength > MAX_FILE_BYTES - 256) fail('DOCUMENT_TOO_LARGE');
  return doc;
}

export async function encodeDocument(doc) {
  validateDocument(doc);
  const payload = canonical(doc);
  const envelope = { format: FORMAT, version: VERSION, sha256: await sha256(payload), document: JSON.parse(payload) };
  const encoded = JSON.stringify(envelope);
  if (new TextEncoder().encode(encoded).byteLength > MAX_FILE_BYTES) fail('DOCUMENT_TOO_LARGE');
  return encoded;
}

export async function decodeDocument(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > MAX_FILE_BYTES) fail(typeof text === 'string' ? 'DOCUMENT_TOO_LARGE' : 'DOCUMENT_INVALID');
  let envelope;
  try { envelope = JSON.parse(text); } catch { fail('DOCUMENT_INVALID'); }
  plainJson(envelope);
  if (!isObject(envelope) || envelope.format !== FORMAT || envelope.version !== VERSION || typeof envelope.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(envelope.sha256)) fail('DOCUMENT_VERSION_UNSUPPORTED');
  validateDocument(envelope.document);
  if (await sha256(canonical(envelope.document)) !== envelope.sha256) fail('DOCUMENT_HASH_MISMATCH');
  return envelope.document;
}

export function updateContent(doc, content) {
  validateDocument(doc);
  const updated = { ...doc, content: cloneJson(content), revision: doc.revision + 1, updatedAt: new Date().toISOString() };
  validateDocument(updated);
  return updated;
}

export function safeFileName(title) {
  const clean = String(title || '未命名文档').normalize('NFC').replace(/[\\/<>:"|?*\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '_').replace(/^\.+/, '').replace(/[. ]+$/, '').slice(0, 96).trim();
  return `${clean || '未命名文档'}.localdoc`;
}

import ExcelJS from 'exceljs';
import {
  AlignmentType, Document, HeadingLevel, ImageRun, LevelFormat, Packer,
  Paragraph, Table, TableCell, TableRow, TextRun
} from 'docx';
import { validateDocument } from '../../shared/model.mjs';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const warning = (context, code) => context.warnings.add(code);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const asColor = value => {
  if (typeof value !== 'string') return null;
  const color = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(color)) return color.slice(1).toUpperCase();
  if (/^[0-9a-f]{6}$/i.test(color)) return color.toUpperCase();
  return null;
};

function warnUnknownAttrs(context, attrs, recognized, code) {
  if (!isObject(attrs)) return;
  if (Object.entries(attrs).some(([key, value]) => value !== null && value !== undefined && !recognized.has(key))) warning(context, code);
}
function alignment(attrs, context) {
  const value = attrs?.textAlign ?? attrs?.alignment;
  if (value === undefined || value === null) return undefined;
  const mapped = { left: AlignmentType.LEFT, right: AlignmentType.RIGHT, center: AlignmentType.CENTER, justify: AlignmentType.JUSTIFIED }[value];
  if (!mapped) warning(context, 'DOCX_ALIGNMENT_UNSUPPORTED');
  return mapped;
}
function fontSize(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 200) return value;
  if (typeof value === 'string') {
    const match = /^(\d+(?:\.\d+)?)(px|pt)$/.exec(value.trim());
    if (match) {
      const n = Number(match[1]) * (match[2] === 'px' ? 0.75 : 1);
      if (n > 0 && n <= 200) return n;
    }
  }
  return undefined;
}
function decodeImage(src) {
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]*={0,2})$/.exec(src || '');
  if (!match) return null;
  if (match[1] === 'webp') return { unsupported: true };
  const binary = atob(match[2]);
  return { type: match[1] === 'jpeg' ? 'jpg' : 'png', data: Uint8Array.from(binary, character => character.charCodeAt(0)) };
}
function textRun(node, context) {
  const options = { text: node.text };
  for (const mark of node.marks || []) {
    if (mark.type === 'bold') options.bold = true;
    else if (mark.type === 'italic') options.italics = true;
    else if (mark.type === 'underline') options.underline = { type: 'single' };
    else if (mark.type === 'strike') options.strike = true;
    else if (mark.type === 'code') options.font = 'Consolas';
    else if (mark.type === 'color') {
      const sourceColor = mark.attrs?.color;
      const color = asColor(sourceColor);
      if (sourceColor != null && color) options.color = color;
      else if (sourceColor != null) warning(context, 'DOCX_TEXT_COLOR_UNSUPPORTED');
      warnUnknownAttrs(context, mark.attrs, new Set(['color']), 'DOCX_COLOR_MARK_ATTRIBUTE_UNMAPPED');
    } else if (mark.type === 'textStyle') {
      const attrs = mark.attrs || {};
      if (attrs.fontFamily !== undefined && attrs.fontFamily !== null) {
        if (typeof attrs.fontFamily === 'string' && attrs.fontFamily.length <= 128) options.font = attrs.fontFamily;
        else warning(context, 'DOCX_FONT_FAMILY_UNSUPPORTED');
      }
      if (attrs.fontSize !== undefined && attrs.fontSize !== null) {
        const size = fontSize(attrs.fontSize);
        if (size) options.size = Math.round(size * 2);
        else warning(context, 'DOCX_FONT_SIZE_UNSUPPORTED');
      }
      if (attrs.color !== undefined && attrs.color !== null) {
        const color = asColor(attrs.color);
        if (color) options.color = color;
        else warning(context, 'DOCX_TEXT_COLOR_UNSUPPORTED');
      }
      const supported = new Set(['fontFamily', 'fontSize', 'color']);
      if (Object.entries(attrs).some(([key, value]) => value != null && !supported.has(key))) warning(context, 'DOCX_TEXT_STYLE_ATTRIBUTE_UNMAPPED');
    }
  }
  return new TextRun(options);
}
function inlineChildren(node, context) {
  const result = [];
  for (const child of node.content || []) {
    if (child.type === 'text') result.push(textRun(child, context));
    else if (child.type === 'hardBreak') result.push(new TextRun({ break: 1 }));
    else if (child.type === 'image') {
      const image = decodeImage(child.attrs?.src);
      if (!image || image.unsupported) {
        warning(context, image?.unsupported ? 'DOCX_WEBP_IMAGE_UNSUPPORTED' : 'DOCX_IMAGE_DATA_UNSUPPORTED');
        continue;
      }
      const width = Number.isFinite(child.attrs?.width) && child.attrs.width > 0 ? Math.min(child.attrs.width, 2000) : 320;
      const height = Number.isFinite(child.attrs?.height) && child.attrs.height > 0 ? Math.min(child.attrs.height, 2000) : 240;
      if (!Number.isFinite(child.attrs?.width) || !Number.isFinite(child.attrs?.height)) warning(context, 'DOCX_IMAGE_SIZE_ASSUMED');
      result.push(new ImageRun({ type: image.type, data: image.data, transformation: { width, height }, altText: { title: String(child.attrs?.alt || 'Embedded image').slice(0, 128), description: String(child.attrs?.alt || '').slice(0, 512) } }));
      warnUnknownAttrs(context, child.attrs, new Set(['src', 'alt', 'title', 'width', 'height']), 'DOCX_IMAGE_ATTRIBUTE_UNMAPPED');
    } else throw new Error('OFFICE_UNSUPPORTED_CONTENT');
  }
  return result;
}
function paragraph(node, context, overrides = {}) {
  const attrs = node.attrs || {};
  const options = { children: inlineChildren(node, context), ...overrides };
  const align = alignment(attrs, context);
  if (align) options.alignment = align;
  if (node.type === 'heading') options.heading = HeadingLevel[`HEADING_${attrs.level}`];
  warnUnknownAttrs(context, attrs, node.type === 'heading' ? new Set(['level', 'textAlign', 'alignment']) : new Set(['textAlign', 'alignment']), 'DOCX_PARAGRAPH_ATTRIBUTE_UNMAPPED');
  return new Paragraph(options);
}
function numbering(context, ordered, start = 1) {
  const reference = `${ordered ? 'ordered' : 'bullet'}-${++context.listId}`;
  const bullets = ['•', '◦', '▪', '▫'];
  context.numbering.push({ reference, levels: Array.from({ length: 9 }, (_, level) => ({
    level,
    format: ordered ? LevelFormat.DECIMAL : LevelFormat.BULLET,
    text: ordered ? `%${level + 1}.` : bullets[level % bullets.length],
    start: level === 0 && Number.isInteger(start) && start > 0 ? Math.min(start, 100000) : 1,
    alignment: AlignmentType.START,
    style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } }
  })) });
  return reference;
}
function listParagraphs(node, context, level = 0) {
  const ordered = node.type === 'orderedList';
  const reference = numbering(context, ordered, node.attrs?.start);
  warnUnknownAttrs(context, node.attrs, ordered ? new Set(['start']) : new Set(), 'DOCX_LIST_ATTRIBUTE_UNMAPPED');
  const children = [];
  for (const item of node.content || []) {
    if (item.type !== 'listItem' && item.type !== 'taskItem') throw new Error('OFFICE_UNSUPPORTED_CONTENT');
    warnUnknownAttrs(context, item.attrs, item.type === 'taskItem' ? new Set(['checked']) : new Set(), 'DOCX_LIST_ITEM_ATTRIBUTE_UNMAPPED');
    const content = item.content || [];
    let emitted = false;
    for (const child of content) {
      if (child.type === 'paragraph') {
        const checked = item.type === 'taskItem' ? item.attrs?.checked === true : false;
        const runs = inlineChildren(child, context);
        if (checked || item.type === 'taskItem') runs.unshift(new TextRun({ text: checked ? '☑ ' : '☐ ' }));
        const options = { children: runs };
        if (!emitted) options.numbering = { reference, level: Math.min(level, 8) };
        else options.indent = { left: 720 * (Math.min(level, 8) + 1) };
        const align = alignment(child.attrs, context);
        if (align) options.alignment = align;
        warnUnknownAttrs(context, child.attrs, new Set(['textAlign', 'alignment']), 'DOCX_PARAGRAPH_ATTRIBUTE_UNMAPPED');
        children.push(new Paragraph(options)); emitted = true;
      } else if (child.type === 'bulletList' || child.type === 'orderedList' || child.type === 'taskList') {
        if (child.type === 'taskList') warning(context, 'DOCX_TASK_LIST_STATIC');
        children.push(...listParagraphs({ ...child, type: child.type === 'taskList' ? 'bulletList' : child.type }, context, level + 1)); emitted = true;
      } else { children.push(...blocks([child], context)); emitted = true; }
    }
    if (!emitted && content.length === 0) children.push(new Paragraph({ children: [new TextRun('')], numbering: { reference, level: Math.min(level, 8) } }));
  }
  return children;
}
function tableNode(node, context) {
  const rows = [];
  for (const row of node.content || []) {
    if (row.type !== 'tableRow') throw new Error('OFFICE_UNSUPPORTED_CONTENT');
    warnUnknownAttrs(context, row.attrs, new Set(), 'DOCX_TABLE_ROW_ATTRIBUTE_UNMAPPED');
    const cells = [];
    for (const cell of row.content || []) {
      if (!['tableCell', 'tableHeader'].includes(cell.type)) throw new Error('OFFICE_UNSUPPORTED_CONTENT');
      const children = blocks(cell.content || [], context).filter(child => child instanceof Paragraph || child instanceof Table);
      const cellOptions = { children: children.length ? children : [new Paragraph('')], columnSpan: Number.isInteger(cell.attrs?.colspan) && cell.attrs.colspan > 1 ? cell.attrs.colspan : undefined, rowSpan: Number.isInteger(cell.attrs?.rowspan) && cell.attrs.rowspan > 1 ? cell.attrs.rowspan : undefined };
      if (cell.attrs?.backgroundColor !== undefined && cell.attrs.backgroundColor !== null) {
        const color = asColor(cell.attrs.backgroundColor);
        if (color) cellOptions.shading = { fill: color }; else warning(context, 'DOCX_TABLE_CELL_COLOR_UNSUPPORTED');
      }
      if (cell.attrs?.colwidth !== undefined && cell.attrs.colwidth !== null) warning(context, 'DOCX_TABLE_CELL_WIDTH_UNMAPPED');
      cells.push(new TableCell(cellOptions));
      warnUnknownAttrs(context, cell.attrs, new Set(['colspan', 'rowspan', 'colwidth', 'backgroundColor']), 'DOCX_TABLE_CELL_ATTRIBUTE_UNMAPPED');
    }
    rows.push(new TableRow({ children: cells }));
  }
  if (node.attrs?.width !== undefined && node.attrs.width !== null) warning(context, 'DOCX_TABLE_WIDTH_UNMAPPED');
  warnUnknownAttrs(context, node.attrs, new Set(['width']), 'DOCX_TABLE_ATTRIBUTE_UNMAPPED');
  return new Table({ rows });
}
function blocks(nodes, context) {
  const result = [];
  for (const node of nodes || []) {
    if (node.type === 'paragraph' || node.type === 'heading') result.push(paragraph(node, context));
    else if (node.type === 'blockquote') {
      warnUnknownAttrs(context, node.attrs, new Set(), 'DOCX_BLOCKQUOTE_ATTRIBUTE_UNMAPPED');
      for (const child of node.content || []) if (child.type === 'paragraph') result.push(paragraph(child, context, { indent: { left: 720 } })); else result.push(...blocks([child], context));
    } else if (node.type === 'bulletList' || node.type === 'orderedList' || node.type === 'taskList') {
      if (node.type === 'taskList') warning(context, 'DOCX_TASK_LIST_STATIC');
      result.push(...listParagraphs(node.type === 'taskList' ? { ...node, type: 'bulletList' } : node, context));
    }
    else if (node.type === 'table') result.push(tableNode(node, context));
    else if (node.type === 'codeBlock') {
      const runs = [];
      for (const child of node.content || []) {
        if (child.type === 'text') runs.push(new TextRun({ text: child.text, font: 'Consolas' }));
        else if (child.type === 'hardBreak') runs.push(new TextRun({ break: 1, font: 'Consolas' }));
        else throw new Error('OFFICE_UNSUPPORTED_CONTENT');
      }
      result.push(new Paragraph({ children: runs }));
    }
    else if (node.type === 'horizontalRule') result.push(new Paragraph({ thematicBreak: true }));
    else if (node.type === 'preservedBlock') throw new Error('OFFICE_UNSUPPORTED_CONTENT');
    else if (node.type === 'image') result.push(new Paragraph({ children: inlineChildren({ content: [node] }, context) }));
    else throw new Error('OFFICE_UNSUPPORTED_CONTENT');
  }
  return result;
}
async function buildDocx(doc) {
  const context = { warnings: new Set(), numbering: [], listId: 0 };
  warnUnknownAttrs(context, doc.content.attrs, new Set(), 'DOCX_DOCUMENT_ATTRIBUTE_UNMAPPED');
  const children = blocks(doc.content.content, context);
  const file = new Document({
    title: doc.title,
    numbering: { config: context.numbering },
    sections: [{ children: children.length ? children : [new Paragraph('')] }]
  });
  const blob = await Packer.toBlob(file);
  return { format: 'docx', mime: DOCX_MIME, bytes: new Uint8Array(await blob.arrayBuffer()), warnings: [...context.warnings] };
}
function validFormulaResult(value) { return value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value); }
function excelColor(value) {
  const color = asColor(value);
  return color ? { argb: `FF${color}` } : undefined;
}
function underline(value, warnings) {
  if (!value || value.s === 0) return undefined;
  if (value.t !== undefined && value.t !== 10 && value.t !== 12) warnings.add('XLSX_UNDERLINE_STYLE_APPROXIMATED');
  return value.t === 10 ? 'double' : 'single';
}
function border(value) {
  if (!isObject(value)) return undefined;
  const styles = { 0: 'none', 1: 'thin', 2: 'hair', 3: 'dotted', 4: 'dashed', 5: 'dashDot', 6: 'dashDotDot', 7: 'double', 8: 'medium', 9: 'mediumDashed', 10: 'mediumDashDot', 11: 'mediumDashDotDot', 12: 'slantDashDot', 13: 'thick' };
  const style = styles[value.s];
  const color = excelColor(value.cl?.rgb);
  return style ? { style, ...(color ? { color } : {}) } : undefined;
}
function excelStyle(style, warnings) {
  if (!isObject(style)) return {};
  const font = {};
  if (typeof style.ff === 'string') font.name = style.ff;
  if (Number.isFinite(style.fs)) font.size = style.fs;
  if (style.bl === 1 || style.bl === true) font.bold = true;
  if (style.it === 1 || style.it === true) font.italic = true;
  const fontColor = excelColor(style.cl?.rgb);
  if (fontColor) font.color = fontColor;
  else if (style.cl?.th != null) warnings.add('XLSX_THEME_COLOR_UNMAPPED');
  const ul = underline(style.ul, warnings);
  if (ul) font.underline = ul;
  if (style.st?.s === 1) font.strike = true;
  const fillColor = excelColor(style.bg?.rgb);
  const output = {};
  if (Object.keys(font).length) output.font = font;
  if (fillColor) output.fill = { type: 'pattern', pattern: 'solid', fgColor: fillColor };
  const horizontal = { 1: 'left', 2: 'center', 3: 'right', 4: 'justify', 5: 'justify', 6: 'distributed' }[style.ht];
  if (style.ht != null && style.ht !== 0 && !horizontal) warnings.add('XLSX_HORIZONTAL_ALIGNMENT_UNSUPPORTED');
  const vertical = { 1: 'top', 2: 'middle', 3: 'bottom' }[style.vt];
  if (style.vt != null && style.vt !== 0 && !vertical) warnings.add('XLSX_VERTICAL_ALIGNMENT_UNSUPPORTED');
  if (style.tb != null && ![0, 1, 2, 3, false, true].includes(style.tb)) warnings.add('XLSX_WRAP_STRATEGY_UNSUPPORTED');
  const align = {};
  if (horizontal) align.horizontal = horizontal;
  if (vertical) align.vertical = vertical;
  if (style.tb === 3 || style.tb === true) align.wrapText = true;
  if (Object.keys(align).length) output.alignment = align;
  if (typeof style.n?.pattern === 'string') output.numFmt = style.n.pattern;
  const sides = { t: 'top', r: 'right', b: 'bottom', l: 'left' }, edges = {};
  for (const [short, long] of Object.entries(sides)) {
    const source = style.bd?.[short], mapped = border(source);
    if (mapped) edges[long] = mapped;
    else if (source) warnings.add('XLSX_BORDER_STYLE_UNSUPPORTED');
    if (isObject(source) && Object.keys(source).some(key => !['s', 'cl'].includes(key))) warnings.add('XLSX_BORDER_ATTRIBUTE_UNMAPPED');
  }
  if (Object.keys(edges).length) output.border = edges;
  const known = new Set(['ff', 'fs', 'bl', 'it', 'ul', 'st', 'cl', 'bg', 'ht', 'vt', 'tb', 'n', 'bd']);
  if (Object.keys(style).some(key => !known.has(key))) warnings.add('XLSX_STYLE_ATTRIBUTE_UNMAPPED');
  for (const nested of [style.cl, style.bg]) if (isObject(nested) && Object.entries(nested).some(([key, value]) => value != null && !['rgb', 'th'].includes(key))) warnings.add('XLSX_STYLE_COLOR_ATTRIBUTE_UNMAPPED');
  if (isObject(style.ul) && Object.entries(style.ul).some(([key, value]) => value != null && !['s', 'c', 'cl', 't'].includes(key))) warnings.add('XLSX_UNDERLINE_ATTRIBUTE_UNMAPPED');
  if (isObject(style.st) && Object.entries(style.st).some(([key, value]) => value != null && !['s', 'c', 'cl', 't'].includes(key))) warnings.add('XLSX_STRIKE_ATTRIBUTE_UNMAPPED');
  if (isObject(style.n) && Object.entries(style.n).some(([key, value]) => value != null && key !== 'pattern')) warnings.add('XLSX_NUMBER_FORMAT_ATTRIBUTE_UNMAPPED');
  for (const [short, colorStyle] of [['cl', style.cl], ['bg', style.bg]]) if (colorStyle?.rgb && !excelColor(colorStyle.rgb)) warnings.add('XLSX_STYLE_COLOR_UNSUPPORTED');
  if (style.bd && Object.keys(style.bd).some(key => !Object.hasOwn(sides, key))) warnings.add('XLSX_BORDER_EDGE_UNMAPPED');
  return output;
}
function safeSheetName(name, used) {
  const original = String(name ?? '');
  const candidate = original.replace(/[\\/*?:\[\]]/g, '_').replace(/^'+|'+$/g, '').slice(0, 31);
  if (!candidate || candidate !== original || used.has(candidate.toLowerCase())) throw new Error('OFFICE_SHEET_NAME_UNSUPPORTED');
  used.add(candidate.toLowerCase());
  return candidate;
}
function cellAddress(row, column) {
  let n = column + 1, letters = '';
  while (n > 0) { const rem = (n - 1) % 26; letters = String.fromCharCode(65 + rem) + letters; n = Math.floor((n - 1) / 26); }
  return `${letters}${row + 1}`;
}
function nonEmpty(value) { return isObject(value) ? Object.keys(value).length > 0 : value !== undefined && value !== null && value !== ''; }
const EMPTY_PLUGIN_RESOURCES = new Set([
  'SHEET_RANGE_PROTECTION_PLUGIN',
  'SHEET_AuthzIoMockService_PLUGIN',
  'SHEET_WORKSHEET_PROTECTION_PLUGIN',
  'SHEET_WORKSHEET_PROTECTION_POINT_PLUGIN',
  'SHEET_DEFINED_NAME_PLUGIN',
  'SHEET_RANGE_THEME_MODEL_PLUGIN'
]);
function emptyPluginPayload(data) {
  if (data === '') return true;
  if (typeof data !== 'string' || data.length > 65536) return false;
  try {
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed.length === 0 : isObject(parsed) && Object.keys(parsed).length === 0;
  } catch { return false; }
}
function hasUnmappedResources(resources) {
  if (resources == null) return false;
  if (!Array.isArray(resources)) return nonEmpty(resources);
  return resources.some(resource => {
    if (!isObject(resource) || !EMPTY_PLUGIN_RESOURCES.has(resource.name) || !emptyPluginPayload(resource.data)) return true;
    return Object.keys(resource).some(key => !['id', 'name', 'data'].includes(key));
  });
}
function configureSheet(source, sheet, warnings) {
  if (source.hidden != null && ![0, 1, 2, false, true].includes(source.hidden)) warnings.add('XLSX_SHEET_VISIBILITY_UNSUPPORTED');
  const state = source.hidden === 1 || source.hidden === true ? 'hidden' : source.hidden === 2 ? 'veryHidden' : 'visible';
  sheet.state = state;
  if (source.tabColor != null) {
    const color = excelColor(source.tabColor);
    if (color) sheet.properties.tabColor = color; else warnings.add('XLSX_TAB_COLOR_UNSUPPORTED');
  }
  if (Number.isFinite(source.defaultRowHeight) && source.defaultRowHeight >= 0) sheet.properties.defaultRowHeight = source.defaultRowHeight * 0.75;
  if (Number.isFinite(source.defaultColumnWidth) && source.defaultColumnWidth >= 0) {
    sheet.properties.defaultColWidth = Math.max(0, (source.defaultColumnWidth - 5) / 7);
    warnings.add('XLSX_COLUMN_WIDTH_APPROXIMATED');
  }
  const view = { state: 'normal' };
  if (source.showGridlines === 0 || source.showGridlines === false) view.showGridLines = false;
  else if (source.showGridlines === 1 || source.showGridlines === true) view.showGridLines = true;
  else if (source.showGridlines != null) warnings.add('XLSX_GRIDLINE_SETTING_UNSUPPORTED');
  if (source.rightToLeft === 1 || source.rightToLeft === true) view.rightToLeft = true;
  else if (source.rightToLeft != null && source.rightToLeft !== 0 && source.rightToLeft !== false) warnings.add('XLSX_TEXT_DIRECTION_UNSUPPORTED');
  if (Number.isFinite(source.zoomRatio) && source.zoomRatio > 0) view.zoomScale = Math.max(10, Math.min(400, Math.round(source.zoomRatio * 100)));
  else if (source.zoomRatio != null) warnings.add('XLSX_ZOOM_UNSUPPORTED');
  const freeze = source.freeze;
  if (isObject(freeze) && (freeze.xSplit > 0 || freeze.ySplit > 0)) {
    view.state = 'frozen';
    view.xSplit = freeze.xSplit || 0;
    view.ySplit = freeze.ySplit || 0;
    view.topLeftCell = cellAddress(freeze.startRow ?? freeze.ySplit ?? 0, freeze.startColumn ?? freeze.xSplit ?? 0);
    if ((freeze.startRow ?? freeze.ySplit ?? 0) !== (freeze.ySplit ?? 0) || (freeze.startColumn ?? freeze.xSplit ?? 0) !== (freeze.xSplit ?? 0)) warnings.add('XLSX_FREEZE_SCROLL_POSITION_UNMAPPED');
  }
  if (freeze != null && !isObject(freeze)) warnings.add('XLSX_FREEZE_UNSUPPORTED');
  if (isObject(freeze) && Object.entries(freeze).some(([key, value]) => value != null && !['xSplit', 'ySplit', 'startRow', 'startColumn'].includes(key))) warnings.add('XLSX_FREEZE_FEATURE_UNMAPPED');
  sheet.views = [view];
  if (source.rowHeader?.hidden === 1 || source.columnHeader?.hidden === 1) warnings.add('XLSX_HEADER_VISIBILITY_UNSUPPORTED');
  if (nonEmpty(source.backgroundImage)) warnings.add('XLSX_SHEET_BACKGROUND_UNSUPPORTED');
  if (hasUnmappedResources(source.resources) || nonEmpty(source.custom)) warnings.add('XLSX_SHEET_EXTENSION_DATA_UNMAPPED');
  if (source.scrollTop > 0 || source.scrollLeft > 0) warnings.add('XLSX_SHEET_SCROLL_POSITION_UNMAPPED');
  const known = new Set(['id', 'name', 'rowCount', 'columnCount', 'cellData', 'mergeData', 'rowData', 'columnData', 'hidden', 'tabColor', 'freeze', 'zoomRatio', 'showGridlines', 'rightToLeft', 'rowHeader', 'columnHeader', 'backgroundImage', 'resources', 'custom', 'scrollTop', 'scrollLeft', 'defaultColumnWidth', 'defaultRowHeight', 'defaultStyle']);
  if (Object.entries(source).some(([key, value]) => !known.has(key) && nonEmpty(value))) warnings.add('XLSX_SHEET_FEATURE_UNMAPPED');
  if (nonEmpty(source.defaultStyle)) warnings.add('XLSX_SHEET_DEFAULT_STYLE_UNMAPPED');
}
async function buildXlsx(doc) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Local document editor';
  const warnings = new Set();
  const usedNames = new Set();
  const workbookData = doc.content;
  if (workbookData.dateSystem === 'date1904') workbook.properties.date1904 = true;
  else if (workbookData.dateSystem !== undefined && workbookData.dateSystem !== 'date1900') warnings.add('XLSX_DATE_SYSTEM_UNSUPPORTED');
  if (nonEmpty(workbookData.defaultStyle)) warnings.add('XLSX_WORKBOOK_DEFAULT_STYLE_UNMAPPED');
  if (hasUnmappedResources(workbookData.resources)) warnings.add('XLSX_WORKBOOK_RESOURCES_UNMAPPED');
  if (nonEmpty(workbookData.custom)) warnings.add('XLSX_WORKBOOK_CUSTOM_DATA_UNMAPPED');
  const workbookKeys = new Set(['id', 'name', 'appVersion', 'locale', 'styles', 'sheetOrder', 'sheets', 'dateSystem', 'defaultStyle', 'resources', 'custom', 'rev']);
  if (Object.entries(workbookData).some(([key, value]) => !workbookKeys.has(key) && nonEmpty(value))) warnings.add('XLSX_WORKBOOK_FEATURE_UNMAPPED');
  for (const sheetId of doc.content.sheetOrder) {
    const source = doc.content.sheets[sheetId];
    const sheet = workbook.addWorksheet(safeSheetName(source.name, usedNames));
    configureSheet(source, sheet, warnings);
    for (const [rowText, height] of Object.entries(source.rowData || {})) {
      const row = Number(rowText), value = height?.h;
      if (Number.isInteger(row) && row >= 0 && row < source.rowCount && Number.isFinite(value) && value >= 0) sheet.getRow(row + 1).height = value * 0.75;
      if (height?.hd === 1 || height?.hd === true) sheet.getRow(row + 1).hidden = true;
      if (height?.ia || height?.ah) warnings.add('XLSX_ROW_AUTO_HEIGHT_UNSUPPORTED');
      if (height?.s != null) {
        const style = typeof height.s === 'string' ? doc.content.styles[height.s] : height.s;
        if (style && isObject(style)) Object.assign(sheet.getRow(row + 1), excelStyle(style, warnings));
        else warnings.add('XLSX_STYLE_REFERENCE_MISSING');
      }
      if (height?.custom && nonEmpty(height.custom)) warnings.add('XLSX_ROW_CUSTOM_DATA_UNMAPPED');
      if (isObject(height) && Object.entries(height).some(([key, value]) => !['h', 'hd', 'ia', 'ah', 's', 'custom'].includes(key) && nonEmpty(value))) warnings.add('XLSX_ROW_FEATURE_UNMAPPED');
    }
    for (const [columnText, width] of Object.entries(source.columnData || {})) {
      const column = Number(columnText), value = width?.w;
      if (Number.isInteger(column) && column >= 0 && column < source.columnCount && Number.isFinite(value) && value >= 0) {
        sheet.getColumn(column + 1).width = Math.max(0, (value - 5) / 7);
        warnings.add('XLSX_COLUMN_WIDTH_APPROXIMATED');
      }
      if (width?.hd === 1 || width?.hd === true) sheet.getColumn(column + 1).hidden = true;
      if (width?.s != null) {
        const style = typeof width.s === 'string' ? doc.content.styles[width.s] : width.s;
        if (style && isObject(style)) Object.assign(sheet.getColumn(column + 1), excelStyle(style, warnings));
        else warnings.add('XLSX_STYLE_REFERENCE_MISSING');
      }
      if (width?.custom && nonEmpty(width.custom)) warnings.add('XLSX_COLUMN_CUSTOM_DATA_UNMAPPED');
      if (isObject(width) && Object.entries(width).some(([key, value]) => !['w', 'hd', 's', 'custom'].includes(key) && nonEmpty(value))) warnings.add('XLSX_COLUMN_FEATURE_UNMAPPED');
    }
    for (const [rowText, row] of Object.entries(source.cellData || {})) {
      const rowIndex = Number(rowText);
      if (!row || !isObject(row) || !Number.isInteger(rowIndex)) continue;
      for (const [columnText, sourceCell] of Object.entries(row)) {
        const columnIndex = Number(columnText);
        if (!sourceCell || !isObject(sourceCell) || !Number.isInteger(columnIndex)) continue;
        const cell = sheet.getCell(rowIndex + 1, columnIndex + 1);
        if (sourceCell.p != null) warnings.add('XLSX_CELL_RICH_TEXT_UNSUPPORTED');
        if (sourceCell.linkUrl != null || sourceCell.linkId != null) warnings.add('XLSX_CELL_HYPERLINK_UNSUPPORTED');
        if (sourceCell.custom != null && nonEmpty(sourceCell.custom)) warnings.add('XLSX_CELL_CUSTOM_DATA_UNMAPPED');
        if (sourceCell.ft != null || sourceCell.fd != null || sourceCell.ref != null || sourceCell.xf != null || sourceCell.si != null) warnings.add('XLSX_FORMULA_METADATA_UNMAPPED');
        const cellKeys = new Set(['id', 'p', 's', 'v', 't', 'f', 'ft', 'fd', 'ref', 'xf', 'si', 'custom', 'linkUrl', 'linkId']);
        if (Object.entries(sourceCell).some(([key, value]) => !cellKeys.has(key) && nonEmpty(value))) warnings.add('XLSX_CELL_FEATURE_UNMAPPED');
        if (typeof sourceCell.f === 'string' && sourceCell.f.trim()) {
          const formula = sourceCell.f.trim().replace(/^=+/, '');
          const formulaValue = { formula };
          if (validFormulaResult(sourceCell.v)) formulaValue.result = sourceCell.v;
          cell.value = formulaValue;
        } else if (sourceCell.v !== undefined && sourceCell.v !== null) {
          const sourceType = sourceCell.t;
          if ((sourceType === 1 || sourceType === 4 || sourceType === 's' || sourceType === 'string') && typeof sourceCell.v !== 'string') {
            cell.value = String(sourceCell.v);
            warnings.add('XLSX_STRING_CELL_COERCED');
          } else if ((sourceType === 3 || sourceType === 'b' || sourceType === 'boolean') && typeof sourceCell.v !== 'boolean') {
            cell.value = sourceCell.v;
            warnings.add('XLSX_BOOLEAN_CELL_TYPE_MISMATCH');
          } else {
            cell.value = sourceCell.v;
            if (typeof sourceCell.v === 'string' && (sourceType === 4 || /^0\d+$/.test(sourceCell.v))) cell.numFmt = '@';
          }
          if (typeof sourceType === 'string' && !['s', 'string', 'n', 'number', 'b', 'boolean', 'f', 'formula', '4', '1', '2', '3'].includes(sourceType)) warnings.add('XLSX_CELL_TYPE_UNSUPPORTED');
        }
        const style = typeof sourceCell.s === 'string' ? doc.content.styles[sourceCell.s] : sourceCell.s;
        if (style && isObject(style)) Object.assign(cell, excelStyle(style, warnings));
        else if (sourceCell.s !== undefined && sourceCell.s !== null) warnings.add('XLSX_STYLE_REFERENCE_MISSING');
      }
    }
    for (const merge of source.mergeData || []) {
      try { sheet.mergeCells(merge.startRow + 1, merge.startColumn + 1, merge.endRow + 1, merge.endColumn + 1); }
      catch { throw new Error('OFFICE_INVALID_MERGE'); }
    }
  }
  const bytes = await workbook.xlsx.writeBuffer();
  return { format: 'xlsx', mime: XLSX_MIME, bytes: new Uint8Array(bytes), warnings: [...warnings] };
}

export async function buildOfficeFile(doc) {
  validateDocument(doc);
  if (doc.kind === 'document') return buildDocx(doc);
  if (doc.kind === 'sheet') return buildXlsx(doc);
  throw new Error('OFFICE_UNSUPPORTED_KIND');
}

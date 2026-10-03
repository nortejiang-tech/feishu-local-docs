import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createDocument } from '../shared/model.mjs';
import { buildOfficeFile } from '../app/src/office.mjs';

const require = createRequire(new URL('../app/package.json', import.meta.url));
const JSZip = require('jszip');
const ExcelJS = require('exceljs');

const doc = createDocument('document', 'Export test');

test('DOCX exports edited document structure, marks, lists, table spans, and current text', async () => {
  const current = createDocument('document', 'Edited title');
  current.provenance.capture = { sourceText: 'stale original text' };
  current.content = { type: 'doc', content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Edited heading' }] },
    { type: 'paragraph', attrs: { textAlign: 'center' }, content: [{ type: 'text', text: 'Styled ', marks: [{ type: 'bold' }, { type: 'italic' }, { type: 'underline' }, { type: 'strike' }, { type: 'color', attrs: { color: '#123456' } }] }, { type: 'text', text: 'code', marks: [{ type: 'code' }] }, { type: 'text', text: ' font', marks: [{ type: 'textStyle', attrs: { fontFamily: 'Arial', fontSize: '16px', color: '#aabbcc' } }] }] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'List entry' }] }] }] },
    { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Quoted text' }] }] },
    { type: 'table', content: [
      { type: 'tableRow', content: [
        { type: 'tableCell', attrs: { colspan: 2 }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Merged columns' }] }] },
        { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Row span' }] }] }
      ] },
      { type: 'tableRow', content: [
        { type: 'tableCell', attrs: { rowspan: 2 }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Vertical merge' }] }] },
        { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Bottom cell' }] }] }
      ] },
      { type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Last row' }] }] }] }
    ] }
  ] };
  const result = await buildOfficeFile(current);
  assert.equal(result.format, 'docx');
  assert.equal(result.mime, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.ok(result.bytes instanceof Uint8Array && result.bytes.length > 1000);
  const zip = await JSZip.loadAsync(result.bytes);
  const xml = await zip.file('word/document.xml').async('string');
  assert.match(xml, /Edited heading/);
  assert.match(xml, /Styled/);
  assert.match(xml, /w:b/);
  assert.match(xml, /w:i/);
  assert.match(xml, /w:u/);
  assert.match(xml, /w:strike/);
  assert.match(xml, /w:color w:val="123456"/);
  assert.match(xml, /List entry/);
  assert.match(xml, /Quoted text/);
  assert.match(xml, /w:gridSpan w:val="2"/);
  assert.match(xml, /w:vMerge/);
  assert.ok(!xml.includes('stale original text'));
  assert.deepEqual(result.warnings, []);
});

test('DOCX inserts supported local raster data images and warns when dimensions are assumed', async () => {
  const current = createDocument('document', 'Image');
  current.content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'image', attrs: { src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p2sAAAAASUVORK5CYII=', alt: 'pixel' } }] }] };
  const result = await buildOfficeFile(current);
  const zip = await JSZip.loadAsync(result.bytes);
  assert.ok(Object.keys(zip.files).some(path => path.startsWith('word/media/')));
  assert.ok(result.warnings.includes('DOCX_IMAGE_SIZE_ASSUMED'));
});

test('DOCX rejects preserved blocks and reports unsupported formatting explicitly', async () => {
  const preserved = createDocument();
  preserved.content = { type: 'doc', content: [{ type: 'preservedBlock', attrs: { sourceId: 'x', sourceType: 'whiteboard', label: 'whiteboard' } }] };
  await assert.rejects(buildOfficeFile(preserved), /OFFICE_UNSUPPORTED_CONTENT/);
  const formatted = createDocument();
  formatted.content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'textStyle', attrs: { backgroundColor: '#ff0000' } }] }] }] };
  const result = await buildOfficeFile(formatted);
  assert.ok(result.warnings.includes('DOCX_TEXT_STYLE_ATTRIBUTE_UNMAPPED'));
});

test('XLSX reopens with edited values, cached formulas, types, styles, merges, dimensions, and all sheets', async () => {
  const current = createDocument('sheet', 'Planning');
  current.provenance.capture = { old: 'stale source workbook text' };
  const firstId = current.content.sheetOrder[0];
  const secondId = 'sheet-two';
  current.content.sheetOrder.push(secondId);
  current.content.sheets[secondId] = { id: secondId, name: 'Second', rowCount: 20, columnCount: 10, cellData: { '0': { '0': { v: 'second sheet' } } }, mergeData: [], rowData: {}, columnData: {} };
  current.content.styles = { s1: { ff: 'Arial', fs: 14, bl: 1, it: 1, ul: { s: 1, t: 12 }, st: { s: 1 }, cl: { rgb: '#123456' }, bg: { rgb: '#abcdef' }, ht: 2, vt: 3, tb: 3, n: { pattern: '0.00' }, bd: { t: { s: 1, cl: { rgb: '#000000' } } } } };
  const sheet = current.content.sheets[firstId];
  sheet.name = 'First';
  sheet.cellData = {
    '0': { '0': { v: 'edited current value', t: 1, s: 's1' }, '2': { v: '00123', t: 1 }, '3': { v: 0, t: 2 }, '4': { v: false, t: 3 } },
    '1': { '0': { f: '=SUM(D1:D1)', v: 0, t: 2 } },
    '2': null,
    '3': { '0': null }
  };
  sheet.mergeData = [{ startRow: 4, endRow: 5, startColumn: 0, endColumn: 1 }];
  sheet.rowData = { '0': { h: 31.5 } };
  sheet.columnData = { '1': { w: 22 } };

  const result = await buildOfficeFile(current);
  assert.equal(result.format, 'xlsx');
  assert.equal(result.mime, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.ok(result.bytes instanceof Uint8Array && result.bytes.length > 1000);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(result.bytes);
  assert.equal(workbook.worksheets.length, 2);
  const first = workbook.getWorksheet('First');
  assert.equal(first.getCell('A1').value, 'edited current value');
  assert.equal(first.getCell('A1').font.name, 'Arial');
  assert.equal(first.getCell('A1').font.bold, true);
  assert.equal(first.getCell('A1').fill.fgColor.argb, 'FFABCDEF');
  assert.equal(first.getCell('A1').alignment.horizontal, 'center');
  assert.equal(first.getCell('A1').alignment.vertical, 'bottom');
  assert.equal(first.getCell('A1').numFmt, '0.00');
  assert.equal(first.getCell('A2').value.formula, 'SUM(D1:D1)');
  const zip = await JSZip.loadAsync(result.bytes);
  const worksheetXml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  assert.match(worksheetXml, /<c r="A2"><f>SUM\(D1:D1\)<\/f><v>0<\/v><\/c>/);
  assert.equal(first.getCell('C1').value, '00123');
  assert.equal(first.getCell('D1').value, 0);
  assert.equal(first.getCell('E1').value, false);
  assert.equal(first.getRow(1).height, 23.625);
  assert.equal(first.getColumn(2).width, (22 - 5) / 7);
  assert.ok(first.getCell('A5').isMerged);
  assert.ok(first.getCell('B6').isMerged);
  assert.equal(workbook.getWorksheet('Second').getCell('A1').value, 'second sheet');
  assert.deepEqual(result.warnings, ['XLSX_COLUMN_WIDTH_APPROXIMATED']);
  assert.ok(!String(first.getCell('A1').value).includes('stale source'));
});

test('XLSX preserves styled blank cells and reports unmapped style data', async () => {
  const current = createDocument('sheet');
  const id = current.content.sheetOrder[0];
  current.content.styles = { custom: { ff: 'Arial', customStyle: true } };
  current.content.sheets[id].cellData = { '0': { '0': { s: 'custom' } } };
  const result = await buildOfficeFile(current);
  assert.ok(result.warnings.includes('XLSX_STYLE_ATTRIBUTE_UNMAPPED'));
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(result.bytes);
  assert.equal(workbook.worksheets[0].getCell('A1').font.name, 'Arial');
});

test('export validates input and rejects slides explicitly', async () => {
  const malformed = createDocument(); malformed.revision = -1;
  await assert.rejects(buildOfficeFile(malformed), /DOCUMENT_INVALID/);
  await assert.rejects(buildOfficeFile(createDocument('slides')), /OFFICE_UNSUPPORTED_KIND/);
});

test('DOCX ignores default null Tiptap attrs, supports nested lists and numbers only first paragraph per item', async () => {
  const current = createDocument('document', 'Editor JSON defaults');
  current.content = { type: 'doc', attrs: { class: null }, content: [
    { type: 'paragraph', attrs: { textAlign: null, class: null }, content: [
      { type: 'text', text: 'Default attrs' },
      { type: 'text', text: ' null style', marks: [{ type: 'color', attrs: { color: null } }, { type: 'textStyle', attrs: { fontFamily: null, fontSize: null, color: null, backgroundColor: null } }] }
    ] },
    { type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'listItem', attrs: { class: null }, content: [
      { type: 'paragraph', attrs: { textAlign: null }, content: [{ type: 'text', text: 'Numbered once' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Continuation' }] },
      { type: 'bulletList', attrs: { tight: null }, content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Nested item' }] }] }] }
    ] }] },
    { type: 'table', attrs: { width: null }, content: [{ type: 'tableRow', attrs: { class: null }, content: [{ type: 'tableCell', attrs: { colspan: 1, rowspan: 1, colwidth: null, backgroundColor: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Cell' }] }] }] }] }
  ] };
  const result = await buildOfficeFile(current);
  assert.deepEqual(result.warnings, []);
  const zip = await JSZip.loadAsync(result.bytes);
  const xml = await zip.file('word/document.xml').async('string');
  const numberingXml = await zip.file('word/numbering.xml').async('string');
  assert.match(xml, /Numbered once/);
  assert.match(xml, /Continuation/);
  assert.match(xml, /Nested item/);
  assert.equal((xml.match(/<w:numPr>/g) || []).length, 2);
  assert.ok((numberingXml.match(/<w:lvl /g) || []).length >= 18);
});

test('DOCX reports static task state and ignored table widths', async () => {
  const current = createDocument('document');
  current.content = { type: 'doc', content: [
    { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Task' }] }] }] },
    { type: 'table', attrs: { width: 640 }, content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Wide cell' }] }] }] }] }
  ] };
  const result = await buildOfficeFile(current);
  assert.ok(result.warnings.includes('DOCX_TASK_LIST_STATIC'));
  assert.ok(result.warnings.includes('DOCX_TABLE_WIDTH_UNMAPPED'));
});

test('XLSX maps sheet visibility and freeze panes while warning for unsupported native data', async () => {
  const current = createDocument('sheet', 'Feature snapshot');
  const id = current.content.sheetOrder[0];
  const sheet = current.content.sheets[id];
  sheet.hidden = 2;
  sheet.tabColor = '#123456';
  sheet.freeze = { xSplit: 1, ySplit: 2, startRow: 2, startColumn: 1 };
  sheet.showGridlines = 0;
  sheet.backgroundImage = { source: 'inline-data', imageSourceType: 0 };
  sheet.cellData = { '0': { '0': { v: 'cell', p: { body: [] }, linkUrl: 'https://example.test', ft: 'array' } } };
  current.content.resources = { commentThreads: [{ id: 'thread' }] };
  const result = await buildOfficeFile(current);
  for (const code of ['XLSX_SHEET_BACKGROUND_UNSUPPORTED', 'XLSX_CELL_RICH_TEXT_UNSUPPORTED', 'XLSX_CELL_HYPERLINK_UNSUPPORTED', 'XLSX_FORMULA_METADATA_UNMAPPED', 'XLSX_WORKBOOK_RESOURCES_UNMAPPED']) assert.ok(result.warnings.includes(code), code);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(result.bytes);
  const reopened = workbook.worksheets[0];
  assert.equal(reopened.state, 'veryHidden');
  assert.equal(reopened.properties.tabColor.argb, 'FF123456');
  assert.equal(reopened.views[0].state, 'frozen');
  assert.equal(reopened.views[0].xSplit, 1);
  assert.equal(reopened.views[0].ySplit, 2);
  assert.equal(reopened.views[0].showGridLines, false);
});

test('XLSX blocks worksheet names it would have to rewrite', async () => {
  const current = createDocument('sheet');
  current.content.sheets[current.content.sheetOrder[0]].name = 'Invalid/Name';
  await assert.rejects(buildOfficeFile(current), /OFFICE_SHEET_NAME_UNSUPPORTED/);
});

test('XLSX ignores only known empty Univer plugin resources', async () => {
  const current = createDocument('sheet', 'Empty resources');
  current.content.resources = [
    { data: '', name: 'SHEET_RANGE_PROTECTION_PLUGIN' },
    { data: '{}', name: 'SHEET_AuthzIoMockService_PLUGIN' },
    { data: '{}', name: 'SHEET_WORKSHEET_PROTECTION_PLUGIN' },
    { data: '{}', name: 'SHEET_WORKSHEET_PROTECTION_POINT_PLUGIN' },
    { data: '{}', name: 'SHEET_DEFINED_NAME_PLUGIN' },
    { data: '{}', name: 'SHEET_RANGE_THEME_MODEL_PLUGIN' }
  ];
  let result = await buildOfficeFile(current);
  assert.ok(!result.warnings.includes('XLSX_WORKBOOK_RESOURCES_UNMAPPED'));

  current.content.resources.push({ data: '{"protectedRanges":[1]}', name: 'SHEET_RANGE_PROTECTION_PLUGIN' });
  current.content.resources.push({ data: '', name: 'SHEET_UNKNOWN_PLUGIN' });
  result = await buildOfficeFile(current);
  assert.ok(result.warnings.includes('XLSX_WORKBOOK_RESOURCES_UNMAPPED'));
});

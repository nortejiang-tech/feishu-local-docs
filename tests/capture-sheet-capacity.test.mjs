import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { capturePage } from '../extension/capture.mjs';
import { importSnapshot } from '../shared/import-snapshot.mjs';
import {
  createDocument,
  updateContent,
  encodeDocument,
  decodeDocument,
  validateDocument,
} from '../shared/model.mjs';
import { MAX_JSON_VALUES } from '../shared/json-limits.mjs';

const SOURCE_URL = 'https://team.feishu.cn/sheets/synthetic';
const SOURCE_PATH = new URL(SOURCE_URL).origin + new URL(SOURCE_URL).pathname;
const SHEET_NAMES = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
const SHEET_COLUMNS = [20, 20, 20, 20, 37, 26];
const ROWS = 200;
const STYLED_CELLS = ROWS * SHEET_COLUMNS.reduce((a, b) => a + b, 0);
const INERT_STYLE = {
  _font: '11px Arial',
  _hAlign: 'left',
  _vAlign: 'middle',
  _wordWrap: false,
  _foreColor: '#000000',
  _backColor: '#ffffff',
};
const STYLE_KEYS = Object.keys(INERT_STYLE);

async function runCapture({ columns = SHEET_COLUMNS, rows = ROWS, sheetCount = SHEET_NAMES.length, seeded = false } = {}) {
  const source = `(${capturePage.toString()})({ expectedSource: ${JSON.stringify(SOURCE_PATH)} })`;
  const sheets = Array.from({ length: sheetCount }, (_unused, index) => ({
    _name: SHEET_NAMES[index] ?? `sheet-${index}`,
    getRowCount: () => rows,
    getColumnCount: () => columns[index],
    getValue: (row, column) => {
      if (index === 0 && row === 0 && column === 0) return 0;
      if (index === 0 && row === 0 && column === 1) return false;
      if (index === 0 && row === 0 && column === 2) return 'unchanged';
      if (seeded && row === 0 && column === 0) return `seed-${index}`;
      return null;
    },
    getText: (row, column) => {
      if (index === 0 && row === 0 && column === 0) return '0';
      if (index === 0 && row === 0 && column === 1) return 'FALSE';
      if (index === 0 && row === 0 && column === 2) return 'unchanged';
      return '';
    },
    getFormula: (row, column) => (index === 0 && row === 1 && column === 0 ? '=A1+1' : null),
    getStyle: () => ({ ...INERT_STYLE }),
    getSpans: () => (index === 0 ? [{ startRow: 0, endRow: 1, startCol: 3, endCol: 5 }] : []),
    getRowHeight: () => 24,
    getColumnWidth: () => 120,
  }));
  const sandbox = {
    location: {
      href: SOURCE_URL,
      origin: new URL(SOURCE_URL).origin,
      pathname: new URL(SOURCE_URL).pathname,
    },
    document: { title: 'Synthetic Workbook - 飞书云文档' },
    window: { spread: { sheets } },
    URL,
    Date,
    Math,
    JSON,
    Number,
    String,
    Object,
    Array,
    Set,
    Map,
    Error,
    RegExp,
    setTimeout,
  };
  const context = vm.createContext(sandbox);
  const script = new vm.Script('globalThis.__captureResult = ' + source, { filename: 'synthetic-capture.vm.js' });
  script.runInContext(context, { timeout: 30000 });
  return await context.__captureResult;
}

function rejectionCode(promise) {
  return promise.then(
    () => 'EXPECTED_REJECTION',
    (error) => error?.message,
  );
}

// Production builds cellData/rowData/columnData with Object.create(null);
// canonical JSON comparison keeps realm/prototype noise out of the structural assert.
function canon(value) {
  return JSON.parse(JSON.stringify(value));
}

test('serialized capture -> import -> edit -> encode/decode preserves a six-sheet workbook', async () => {
  const result = await runCapture();
  assert.equal(result.ok, true, `capture failed: ${JSON.stringify(result)}`);
  const capture = result.snapshot;

  // The capture must be the real workbook, not a stub or a discarded model.
  assert.equal(capture.kind, 'sheet');
  assert.equal(capture.model.sheets.length, 6);
  assert.equal(capture.source.url, SOURCE_PATH);
  assert.equal(capture.source.title, 'Synthetic Workbook');
  const capturedStyledCells = capture.model.sheets.reduce((total, sheet) => total + sheet.cells.length, 0);
  assert.equal(capturedStyledCells, STYLED_CELLS);
  for (const sheet of capture.model.sheets) {
    assert.equal(sheet.rowHeights.length, ROWS);
    assert.equal(sheet.columnWidths.length, sheet.columns);
    for (const cell of sheet.cells) {
      for (const key of STYLE_KEYS) assert.equal(cell.style[key], INERT_STYLE[key]);
    }
  }

  // Cross-realm copy exactly as the extension host performs after JSON transport.
  const portable = JSON.parse(JSON.stringify(capture));
  const originalCapture = JSON.parse(JSON.stringify(capture));
  const imported = importSnapshot(portable);

  assert.equal(imported.kind, 'sheet');
  assert.equal(imported.provenance.origin, 'feishu-capture');
  assert.deepEqual(canon(imported.provenance.capture), canon(originalCapture));

  const workbook = imported.content;
  assert.equal(workbook.sheetOrder.length, 6);
  assert.equal(Object.keys(workbook.sheets).length, 6);

  let importedStyledCells = 0;
  for (let index = 0; index < 6; index++) {
    const sheet = workbook.sheets[workbook.sheetOrder[index]];
    assert.equal(sheet.rowCount, ROWS);
    assert.equal(sheet.columnCount, SHEET_COLUMNS[index]);
    let count = 0;
    for (const row of Object.values(sheet.cellData)) count += Object.keys(row).length;
    importedStyledCells += count;
    assert.equal(count, ROWS * SHEET_COLUMNS[index]);
    assert.equal(sheet.rowData['0'].h, 24);
    assert.equal(sheet.columnData['0'].w, 120);
  }
  assert.equal(importedStyledCells, STYLED_CELLS);

  const first = workbook.sheets[workbook.sheetOrder[0]];
  // Zero and false survive as distinct typed values.
  assert.equal(first.cellData['0']['0'].v, 0);
  assert.equal(first.cellData['0']['0'].t, 2);
  assert.equal(first.cellData['0']['1'].v, false);
  assert.equal(first.cellData['0']['1'].t, 3);
  assert.equal(first.cellData['0']['2'].v, 'unchanged');
  assert.equal(first.cellData['0']['2'].t, 1);
  // Formula survives on its own cell.
  assert.equal(first.cellData['1']['0'].f, '=A1+1');
  // Half-open native merge {0,1}x{3,5} becomes inclusive 0..0 x 3..4.
  assert.deepEqual(first.mergeData, [{ startRow: 0, endRow: 0, startColumn: 3, endColumn: 4 }]);
  // Representative translated style from the inert native style.
  const styleId = first.cellData['0']['0'].s;
  assert.equal(typeof styleId, 'string');
  assert.deepEqual(workbook.styles[styleId], {
    ff: 'Arial',
    fs: 11,
    ht: 1,
    vt: 2,
    tb: 2,
    cl: { rgb: '#000000' },
    bg: { rgb: '#ffffff' },
  });

  // Edit a cloned local cell, then updateContent + encode/decode roundtrip.
  const editedContent = JSON.parse(JSON.stringify(workbook));
  const editSheetId = workbook.sheetOrder[1];
  editedContent.sheets[editSheetId].cellData['5'] = editedContent.sheets[editSheetId].cellData['5'] || {};
  editedContent.sheets[editSheetId].cellData['5']['3'] = { v: 'synthetic-edit', t: 1, s: styleId };
  const updated = updateContent(imported, editedContent);
  assert.equal(updated.revision, imported.revision + 1);
  assert.equal(updated.content.sheets[editSheetId].cellData['5']['3'].v, 'synthetic-edit');

  const encoded = await encodeDocument(updated);
  const decoded = await decodeDocument(encoded);
  assert.deepEqual(canon(decoded), canon(updated));
  assert.equal(decoded.content.sheets[editSheetId].cellData['5']['3'].v, 'synthetic-edit');
  assert.equal(decoded.content.sheets[workbook.sheetOrder[0]].cellData['0']['0'].v, 0);
  assert.equal(decoded.content.sheets[workbook.sheetOrder[0]].cellData['0']['1'].v, false);
  assert.equal(decoded.provenance.capture.model.sheets.length, 6);

  // The source capture object is untouched by import, edit, encode and decode.
  assert.deepEqual(canon(capture), canon(originalCapture));
  assert.equal(capture.model.sheets.length, 6);
  assert.equal(capture.model.sheets.reduce((total, sheet) => total + sheet.cells.length, 0), STYLED_CELLS);
});

test('single 200 x 77 styled sheet imports and roundtrips (old-budget regression)', async () => {
  const result = await runCapture({ sheetCount: 1, columns: [77] });
  assert.equal(result.ok, true, `capture failed: ${JSON.stringify(result)}`);
  const capture = result.snapshot;
  assert.equal(capture.model.sheets[0].cells.length, 200 * 77);

  const imported = importSnapshot(JSON.parse(JSON.stringify(capture)));
  const sheet = imported.content.sheets[imported.content.sheetOrder[0]];
  assert.equal(sheet.rowCount, 200);
  assert.equal(sheet.columnCount, 77);
  let count = 0;
  for (const row of Object.values(sheet.cellData)) count += Object.keys(row).length;
  assert.equal(count, 200 * 77);

  const encoded = await encodeDocument(imported);
  const decoded = await decodeDocument(encoded);
  assert.deepEqual(canon(decoded), canon(imported));
});

test('structural budget rejects oversized snapshots and documents with specific codes', async () => {
  assert.equal(MAX_JSON_VALUES, 2000000);

  const small = await runCapture({ sheetCount: 1, rows: 2, columns: [6] });
  assert.equal(small.ok, true, `capture failed: ${JSON.stringify(small.snapshot)}`);
  const overloaded = JSON.parse(JSON.stringify(small.snapshot));
  // One extra inert field pushes the structural value count past the shared budget.
  overloaded.inertPadding = new Array(MAX_JSON_VALUES).fill(null);

  assert.equal(await rejectionCode(Promise.resolve().then(() => importSnapshot(overloaded))), 'IMPORT_TOO_LARGE');

  const doc = createDocument('sheet', 'synthetic');
  doc.provenance.extra = new Array(MAX_JSON_VALUES).fill(null);
  assert.equal(await rejectionCode(Promise.resolve().then(() => validateDocument(doc))), 'DOCUMENT_TOO_LARGE');
});

test('malformed input keeps its existing invalid codes', async () => {
  const small = await runCapture({ sheetCount: 1, rows: 2, columns: [6] });
  assert.equal(small.ok, true, `capture failed: ${JSON.stringify(small.snapshot)}`);

  // Forbidden object key smuggled in through JSON.parse.
  const poisoned = JSON.parse(JSON.stringify(small.snapshot));
  poisoned.inert = JSON.parse('{"__proto__":{"polluted":true},"rest":1}');
  assert.equal(await rejectionCode(Promise.resolve().then(() => importSnapshot(poisoned))), 'IMPORT_INVALID');

  // Undefined required field is caught by the archive validator first.
  const withUndefined = JSON.parse(JSON.stringify(small.snapshot));
  withUndefined.model.sheets[0].cells[0].display = undefined;
  assert.equal(await rejectionCode(Promise.resolve().then(() => importSnapshot(withUndefined))), 'ARCHIVE_INVALID');

  // Object nested deeper than the 64 level cap.
  let deep = { leaf: 1 };
  for (let i = 0; i < 70; i++) deep = { child: deep };
  const withDeep = JSON.parse(JSON.stringify(small.snapshot));
  withDeep.inert = deep;
  assert.equal(await rejectionCode(Promise.resolve().then(() => importSnapshot(withDeep))), 'IMPORT_INVALID');

  // Out-of-bounds merge never reaches the importer; validateSnapshot rejects it first.
  const badMerge = JSON.parse(JSON.stringify(small.snapshot));
  badMerge.model.sheets[0].merges = [{ row: 0, column: 0, rows: 3, columns: 1 }];
  assert.equal(await rejectionCode(Promise.resolve().then(() => importSnapshot(badMerge))), 'ARCHIVE_INVALID');

  // Document-level structural invalidity is DOCUMENT_INVALID, not a size code.
  let docDeep = { leaf: 1 };
  for (let i = 0; i < 70; i++) docDeep = { child: docDeep };
  const deepDoc = createDocument('sheet', 'synthetic');
  deepDoc.provenance.extra = docDeep;
  assert.equal(await rejectionCode(Promise.resolve().then(() => validateDocument(deepDoc))), 'DOCUMENT_INVALID');

  const poisonedDoc = createDocument('sheet', 'synthetic');
  poisonedDoc.provenance.extra = JSON.parse('{"__proto__":{"x":1}}');
  assert.equal(await rejectionCode(Promise.resolve().then(() => validateDocument(poisonedDoc))), 'DOCUMENT_INVALID');
});

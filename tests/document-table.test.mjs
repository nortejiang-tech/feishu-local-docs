import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDemo } from '../extension/demo.mjs';
import { importSnapshot } from '../shared/import-snapshot.mjs';
import { preflightDocumentContent } from '../app/src/editors/editor-schema.mjs';

function snapshot(blocks) {
  const value = makeDemo('document');
  value.model.blocks = blocks;
  value.model.rootIds = ['table'];
  return value;
}

function tableBlock({ rowIds = ['r1', 'r2'], columnIds = ['c1', 'c2'], headerRow = true, cells, columnWidths = [80, 120] }) {
  return { id: 'table', type: 'table', text: '', parentId: null, children: cells.map(cell => cell.blockId), properties: {}, richText: null,
    table: { rowIds, columnIds, columnWidths, headerRow, cells } };
}

function paragraph(id, parentId, text, children = []) {
  return { id, type: 'paragraph', text, parentId, children: children.map(child => child.id), properties: {}, richText: null };
}

function bodyCell(id, row, column, text = '') {
  const body = paragraph(`${id}-p`, id, text);
  return [{ id, type: 'table_cell', text: '', parentId: 'table', children: [body.id], properties: {}, richText: null }, body];
}

test('converts captured table geometry to ordered editable rows, headers and widths', () => {
  const cells = [
    { row: 0, column: 0, blockId: 'a', rowSpan: 1, columnSpan: 1 },
    { row: 0, column: 1, blockId: 'b', rowSpan: 1, columnSpan: 1 },
    { row: 1, column: 0, blockId: 'c', rowSpan: 1, columnSpan: 1 },
    { row: 1, column: 1, blockId: 'd', rowSpan: 1, columnSpan: 1 },
  ];
  const blocks = [tableBlock({ cells }), ...bodyCell('a', 0, 0, 'A1'), ...bodyCell('b', 0, 1, 'B1'), ...bodyCell('c', 1, 0, 'A2'), ...bodyCell('d', 1, 1, 'B2')];
  const before = structuredClone(blocks);
  const imported = importSnapshot(snapshot(blocks));
  const table = imported.content.content.find(node => node.type === 'table');
  assert.ok(table);
  assert.equal(imported.content.content.filter(node => node.type === 'preservedBlock').length, 0, 'all table cell records must be consumed, not appended as placeholders');
  assert.equal(table.content.length, 2);
  assert.deepEqual(table.content[0].content.map(node => node.type), ['tableHeader', 'tableHeader']);
  assert.equal(table.content[0].content[0].attrs.colwidth[0], 80);
  assert.deepEqual(table.content[1].content.map(node => node.content[0].content[0].text), ['A2', 'B2']);
  const allText = JSON.stringify(table);
  for (const text of ['A1', 'B1', 'A2', 'B2']) assert.equal(allText.split(text).length - 1, 1);
  assert.deepEqual(blocks, before);
  assert.deepEqual(preflightDocumentContent(imported.content), imported.content);
});

test('colspan consumes a separate empty covered cell and its flat traversal entry', () => {
  const cells = [
    { row: 0, column: 0, blockId: 'main', rowSpan: 1, columnSpan: 2 },
    { row: 0, column: 1, blockId: 'covered', rowSpan: 1, columnSpan: 1 },
    { row: 1, column: 0, blockId: 'lower-a', rowSpan: 1, columnSpan: 1 },
    { row: 1, column: 1, blockId: 'lower-b', rowSpan: 1, columnSpan: 1 },
  ];
  const blocks = [tableBlock({ cells, headerRow: false }), ...bodyCell('main', 0, 0, 'merged'),
    { id: 'covered', type: 'table_cell', text: '', parentId: 'table', children: ['covered-p'], properties: {}, richText: null },
    paragraph('covered-p', 'covered', ''),
    ...bodyCell('lower-a', 1, 0, 'x'), ...bodyCell('lower-b', 1, 1, 'y')];
  const imported = importSnapshot(snapshot(blocks));
  const table = imported.content.content.find(node => node.type === 'table');
  assert.equal(table.content[0].content.length, 1);
  assert.equal(table.content[0].content[0].attrs.colspan, 2);
  assert.ok(!imported.content.content.some(node => node.type === 'preservedBlock'));
  assert.equal(imported.content.content.length, 1, 'empty covered paragraphs must not be appended');
  assert.equal(JSON.stringify(imported.content).split('merged').length - 1, 1);
  assert.ok(!imported.issues.some(issue => issue.code === 'TABLE_CONVERSION_INCOMPLETE'));
  preflightDocumentContent(imported.content);
});

test('text in a covered position rejects conversion and remains visible once', () => {
  const cells = [
    { row: 0, column: 0, blockId: 'main', rowSpan: 1, columnSpan: 2 },
    { row: 0, column: 1, blockId: 'covered', rowSpan: 1, columnSpan: 1 },
    { row: 1, column: 0, blockId: 'lower-a', rowSpan: 1, columnSpan: 1 },
    { row: 1, column: 1, blockId: 'lower-b', rowSpan: 1, columnSpan: 1 },
  ];
  const blocks = [tableBlock({ cells }), ...bodyCell('main', 0, 0, 'main'), ...bodyCell('covered', 0, 1, 'must remain'),
    ...bodyCell('lower-a', 1, 0, 'x'), ...bodyCell('lower-b', 1, 1, 'y')];
  const imported = importSnapshot(snapshot(blocks));
  assert.equal(imported.content.content.some(node => node.type === 'table'), false);
  assert.equal(JSON.stringify(imported.content).split('must remain').length - 1, 1);
  assert.equal(imported.issues.find(issue => issue.code === 'TABLE_CONVERSION_INCOMPLETE')?.count, 1);
});

test('missing geometry stays on the legacy path; malformed geometry falls back visibly', () => {
  const legacy = tableBlock({ cells: [] });
  delete legacy.table;
  const legacyImported = importSnapshot(snapshot([legacy, ...bodyCell('x', 0, 0, 'legacy text')]));
  assert.ok(!legacyImported.issues.some(issue => issue.code === 'TABLE_CONVERSION_INCOMPLETE'));
  assert.ok(legacyImported.content.content.some(node => node.attrs?.sourceId === 'table'));

  const invalid = tableBlock({ cells: [
    { row: 0, column: 0, blockId: 'x', rowSpan: 1, columnSpan: 1 },
  ] });
  const invalidImported = importSnapshot(snapshot([invalid, ...bodyCell('x', 0, 0, 'fallback')]));
  assert.equal(invalidImported.issues.find(issue => issue.code === 'TABLE_CONVERSION_INCOMPLETE')?.count, 1);
  assert.equal(JSON.stringify(invalidImported.content).split('fallback').length - 1, 1);
});

test('missing refs, cycles and shared body descendants all fall back without consuming content', () => {
  const cells = [
    { row: 0, column: 0, blockId: 'a', rowSpan: 1, columnSpan: 1 },
    { row: 0, column: 1, blockId: 'b', rowSpan: 1, columnSpan: 1 },
    { row: 1, column: 0, blockId: 'c', rowSpan: 1, columnSpan: 1 },
    { row: 1, column: 1, blockId: 'd', rowSpan: 1, columnSpan: 1 },
  ];
  const baseCells = ['a', 'b', 'c', 'd'].flatMap((id, index) => bodyCell(id, Math.floor(index / 2), index % 2, id));
  const cases = [];
  cases.push([tableBlock({ cells }), baseCells.filter(block => block.id !== 'd')]);
  const cycle = structuredClone(baseCells); cycle.find(block => block.id === 'a-p').children = ['a-p']; cases.push([tableBlock({ cells }), cycle]);
  const shared = structuredClone(baseCells); shared.find(block => block.id === 'b').children = ['a-p']; cases.push([tableBlock({ cells }), shared]);
  for (const [table, body] of cases) {
    const imported = importSnapshot(snapshot([table, ...body]));
    assert.ok(!imported.content.content.some(node => node.type === 'table'));
    assert.equal(imported.issues.find(issue => issue.code === 'TABLE_CONVERSION_INCOMPLETE')?.count, 1);
    assert.ok(JSON.stringify(imported.content).includes('preservedBlock'));
  }
});

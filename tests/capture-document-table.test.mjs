import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { capturePage } from '../extension/capture.mjs';

const source = 'https://sample.feishu.cn/docx/sample';
function block(id, type, snapshot = {}) {
  return { type, struct: { id, record: { id, snapshot: { parent_id: 'root', children: [], ...snapshot } } } };
}
async function run(blocks) {
  const context = vm.createContext({
    window: { PageMain: { editor: { editor: { api: { modelService: { allBlockModels: blocks } } } } } },
    location: { href: source, origin: 'https://sample.feishu.cn', pathname: '/docx/sample' },
    document: { title: 'Table test' }, URL, setTimeout
  });
  return JSON.parse(JSON.stringify(await vm.runInContext(`(${capturePage.toString()})({expectedSource:${JSON.stringify(source)}})`, context)));
}
function tableSnapshot(overrides = {}) {
  return {
    rows_id: ['r0', 'r1'], columns_id: ['c0', 'c1'], header_row: true,
    column_set: { c0: { column_width: 276 }, c1: { column_width: null } },
    cell_set: {
      r0c0: { block_id: 'a', merge_info: { row_span: 1, col_span: 1 } },
      r0c1: { block_id: 'b', merge_info: { row_span: 1, col_span: 1 } },
      r1c0: { block_id: 'c', merge_info: { row_span: 1, col_span: 1 } },
      r1c1: { block_id: 'd', merge_info: { row_span: 1, col_span: 1 } }
    }, ...overrides
  };
}
function withTable(snapshot) {
  return [block('t', 'table', snapshot), ...['a', 'b', 'c', 'd'].map(id => block(id, 'table_cell'))];
}

test('captures ordered table geometry, widths, header state, and cell references', async () => {
  const result = await run(withTable(tableSnapshot()));
  assert.equal(result.ok, true, JSON.stringify(result));
  const table = result.snapshot.model.blocks[0].table;
  assert.deepEqual(table, {
    rowIds: ['r0', 'r1'], columnIds: ['c0', 'c1'], columnWidths: [276, null], headerRow: true,
    cells: [
      { row: 0, column: 0, blockId: 'a', rowSpan: 1, columnSpan: 1 },
      { row: 0, column: 1, blockId: 'b', rowSpan: 1, columnSpan: 1 },
      { row: 1, column: 0, blockId: 'c', rowSpan: 1, columnSpan: 1 },
      { row: 1, column: 1, blockId: 'd', rowSpan: 1, columnSpan: 1 }
    ]
  });
  assert.equal(result.snapshot.issues.some(issue => issue.code === 'BLOCK_LAYOUT_NOT_CAPTURED'), false);
  assert.equal(result.snapshot.model.blocks.slice(1).some(cell => cell.type === 'table_cell'), true);
});

test('retains merge spans and zero-span covered coordinates', async () => {
  const cellSet = {
    r0c0: { block_id: 'a', merge_info: { row_span: 2, col_span: 2 } },
    r0c1: { block_id: 'b', merge_info: { row_span: 0, col_span: 0 } },
    r1c0: { block_id: 'c', merge_info: { row_span: 0, col_span: 0 } },
    r1c1: { block_id: 'd', merge_info: { row_span: 0, col_span: 0 } }
  };
  const result = await run(withTable(tableSnapshot({ cell_set: cellSet })));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.snapshot.model.blocks[0].table.cells.map(cell => [cell.rowSpan, cell.columnSpan]), [[2, 2], [0, 0], [0, 0], [0, 0]]);
});

test('fails malformed explicit geometry without exposing page values', async () => {
  for (const snapshot of [
    tableSnapshot({ rows_id: {} }),
    tableSnapshot({ column_set: { c0: { column_width: 'private-value' }, c1: { column_width: 2 } } }),
    tableSnapshot({ cell_set: { r0c0: { block_id: 'missing-private-id', merge_info: { row_span: 1, col_span: 1 } } } }),
    tableSnapshot({ cell_set: { r0c0: { block_id: 'a', merge_info: { row_span: 3, col_span: 1 } } } })
  ]) {
    const result = await run(withTable(snapshot));
    assert.deepEqual(result, { ok: false, code: 'MODEL_SHAPE_CHANGED' });
    assert.equal(JSON.stringify(result).includes('private'), false);
  }
});

test('copies page arrays by index and never calls their map or toJSON methods', async () => {
  const rows = ['r0', 'r1'];
  rows.map = () => { throw new Error('private map'); };
  rows.toJSON = () => { throw new Error('private serialization'); };
  const result = await run(withTable(tableSnapshot({ rows_id: rows })));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.snapshot.model.blocks[0].table.rowIds, ['r0', 'r1']);
});

test('keeps legacy tables and table cells compatible when geometry is absent', async () => {
  const result = await run([block('t', 'table', { children: ['cell'] }), block('cell', 'table_cell')]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal('table' in result.snapshot.model.blocks[0], false);
  assert.equal(result.snapshot.issues.find(issue => issue.code === 'BLOCK_LAYOUT_NOT_CAPTURED')?.count, 1);
});

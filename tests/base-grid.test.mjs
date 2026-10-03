import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBaseGrid } from '../shared/base-grid.mjs';

test('native table rankInfo and option IDs drive projection; display names are not option identities',()=>{
 const p={format:'feishu-bitable-table',table:{fieldMap:{S:{name:'Status',type:3,property:{options:[{id:'opt1',name:'Done',color:2}]}}},recordMap:{R2:{S:{value:'Done'}},R1:{S:{value:'opt1'}}},views:[],viewMap:{},rankInfo:{rankMap:{R2:'i1',R1:'i0'}}}};
 const r=buildBaseGrid(p);assert.equal(r.order,'RANK');assert.deepEqual(r.rows.map(x=>x.id),['R1','R2']);assert.equal(r.rows[0].cells[0].display,'Done');assert.equal(r.rows[1].cells[0].editable,false);
});
test('styled text fragments cannot be presented as flattenable editable text',()=>{const p={format:'feishu-bitable-table',table:{fieldMap:{A:{name:'Text',type:1}},recordMap:{R:{A:{value:[{type:'text',text:'styled',bold:true}]}}},views:[],viewMap:{}}};assert.equal(buildBaseGrid(p).rows[0].cells[0].editable,false);});

const snap = (v) => JSON.stringify(v);

function payload({ fields, records, viewFields, viewRecords, ranks, viewId = 'V1' } = {}) {
  return {
    format: 'feishu-bitable-table',
    table: {
      meta: { id: 'T1' },
      fieldMap: fields,
      recordMap: records,
      views: [viewId],
      rankInfo: {rankMap:ranks ?? {}},
      viewMap: {
        [viewId]: {
          id: viewId,
          name: 'grid',
          type: 'grid',
          property: { fields: viewFields ?? [], records: viewRecords ?? [], sortInfo: [], filterInfo: null, group: [] }
        }
      }
    }
  };
}

const text = (s) => ({ value: [{ type: 'text', text: s }] });

test('column order: view.fields A,B wins over fieldMap insertion B,A', () => {
  const p = payload({
    fields: { B: { name: 'Beta', type: 1 }, A: { name: 'Alpha', type: 1 } },
    records: { R1: { A: text('a'), B: text('b') } },
    viewFields: ['A', 'B']
  });
  const r = buildBaseGrid(p, 'V1');
  assert.deepEqual(r.columns.map((c) => c.id), ['A', 'B']);
  assert.equal(r.viewPending, true);
});

test('row order: ranks i0/i1 sort to R1,R2 despite recordMap insertion R2,R1', () => {
  const p = payload({
    fields: { A: { name: 'A', type: 1 } },
    records: { R2: { A: text('x') }, R1: { A: text('y') } },
    viewFields: ['A'],
    ranks: { R2: 'i1', R1: 'i0' }
  });
  const r = buildBaseGrid(p, 'V1');
  assert.deepEqual(r.rows.map((x) => x.id), ['R1', 'R2']);
  assert.equal(r.order, 'RANK');
});

test('duplicate ranks fall back to capture order', () => {
  const p = payload({
    fields: { A: { name: 'A', type: 1 } },
    records: { R2: { A: text('x') }, R1: { A: text('y') } },
    viewFields: ['A'],
    ranks: { R2: 'same', R1: 'same' }
  });
  const r = buildBaseGrid(p, 'V1');
  assert.deepEqual(r.rows.map((x) => x.id), ['R2', 'R1']);
  assert.equal(r.order, 'CAPTURE');
});

test('view.records dedupes and drops missing, then appends remaining rows', () => {
  const p = payload({
    fields: { A: { name: 'A', type: 1 } },
    records: { R2: { A: text('x') }, R1: { A: text('y') } },
    viewFields: ['A'],
    viewRecords: ['R2', 'R2', 'missing']
  });
  const r = buildBaseGrid(p, 'V1');
  assert.deepEqual(r.rows.map((x) => x.id), ['R2', 'R1']);
  assert.equal(r.order, 'VIEW_RECORDS');
});

test('text fragments join; mixed text+mention is read-only unsupported', () => {
  const p = payload({
    fields: { A: { name: 'A', type: 1 }, B: { name: 'B', type: 1 } },
    records: {
      R1: { A: { value: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } },
      B: null
    }
  });
  p.table.recordMap.R1.B = { value: [{ type: 'text', text: 'x' }, { type: 'mention', text: 'y' }] };
  const r = buildBaseGrid(p, 'V1');
  const a = r.rows[0].cells.find((c) => c.fieldId === 'A');
  assert.deepEqual([a.display, a.value, a.editable], ['ab', 'ab', true]);
  const b = r.rows[0].cells.find((c) => c.fieldId === 'B');
  assert.deepEqual([b.display, b.value, b.editable], ['暂不支持的内容', null, false]);
  assert.equal(r.unsupportedCells, 1);
});

test('select: native option ID maps to display label, unknown ID stays read-only', () => {
  const p = payload({
    fields: {
      S: {
        name: 'S',
        type: 3,
        property: {
          options: [
            { id: 'o1', name: 'One', color: 3, secret: 'no' },
            { id: 'o2', name: 'Two', color: 'red' },
            { name: 'noId', color: 1 }
          ]
        }
      }
    },
    records: { R1: { S: { value: 'o1' } }, R2: { S: { value: 'nope' } } },
    viewFields: ['S']
  });
  const r = buildBaseGrid(p, 'V1');
  assert.deepEqual(r.columns[0].options, [
    { id: 'o1', name: 'One', color: 3 },
    { id: 'o2', name: 'Two', color: 0 }
  ]);
  const c1 = r.rows[0].cells[0];
  assert.deepEqual([c1.display, c1.value, c1.editable], ['One', 'o1', true]);
  const c2 = r.rows[1].cells[0];
  assert.deepEqual([c2.display, c2.value, c2.editable], ['未知选项', null, false]);
  assert.equal(r.unsupportedCells, 1);
});

test('date: epoch 0 -> ISO string with epoch preserved; invalid date unsupported', () => {
  const p = payload({
    fields: { D: { name: 'D', type: 5 } },
    records: { R1: { D: { value: 0 } }, R2: { D: { value: 'nope' } } },
    viewFields: ['D']
  });
  const r = buildBaseGrid(p, 'V1');
  assert.deepEqual(r.rows[0].cells[0], { fieldId: 'D', display: '1970-01-01T00:00:00.000Z', editable: true, value: 0 });
  assert.deepEqual(r.rows[1].cells[0], { fieldId: 'D', display: '暂不支持的内容', editable: false, value: null });
  assert.equal(r.unsupportedCells, 1);
});

test('unsupported field type counts once per row and never leaks raw data', () => {
  const p = payload({
    fields: { U: { name: 'U', type: 17 }, A: { name: 'A', type: 1 } },
    records: {
      R1: { U: { value: { url: 'https://evil.invalid' } }, A: text('a') },
      R2: { U: { value: 'anything' }, A: text('b') }
    },
    viewFields: ['U', 'A']
  });
  const r = buildBaseGrid(p, 'V1');
  assert.equal(r.rows.length, 2);
  for (const row of r.rows) {
    assert.deepEqual(row.cells[0], { fieldId: 'U', display: '暂不支持的字段', editable: false, value: null });
  }
  // one unsupported cell per row; the supported text column never counts
  assert.equal(r.unsupportedCells, 2);
  assert.equal(snap(r).includes('evil.invalid'), false);
});

test('missing view falls back to first view; missing cell is blank', () => {
  const p = payload({
    fields: { A: { name: 'A', type: 1 }, B: { name: 'B', type: 1 } },
    records: { R1: { A: text('a') } },
    viewFields: ['A']
  });
  const r = buildBaseGrid(p, 'NOPE');
  assert.deepEqual(r.columns.map((c) => c.id), ['A', 'B']);
  assert.deepEqual(r.rows[0].cells[1], { fieldId: 'B', display: '', editable: true, value: null });
  assert.equal(r.unsupportedCells, 0);
});

test('malformed top-level input returns empty result and never mutates source', () => {
  for (const bad of [null, undefined, 42, 'x', [], {}, { format: 'other', table: {} }, { format: 'feishu-bitable-table' }]) {
    assert.deepEqual(buildBaseGrid(bad, 'V1'), {
      columns: [],
      rows: [],
      order: 'CAPTURE',
      unsupportedCells: 0,
      viewPending: true
    });
  }
  const p = payload({
    fields: { A: { name: 'A', type: 1 }, U: { name: 'U', type: 9 } },
    records: { R2: { A: text('x'), U: { value: 1 } }, R1: { A: text('y') } },
    viewFields: ['A'],
    ranks: { R2: 'i1', R1: 'i0' }
  });
  const before = snap(p);
  buildBaseGrid(p, 'V1');
  assert.equal(snap(p), before);
});

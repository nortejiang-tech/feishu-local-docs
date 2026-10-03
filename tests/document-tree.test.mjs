import test from 'node:test';
import assert from 'node:assert/strict';

import { assembleDocumentTree, MAX_BLOCKS, MAX_DEPTH } from '../shared/document-tree.mjs';

const INVALID = 'DOCUMENT_TREE_INVALID';

/** Minimal deterministic leaf renderer: every block becomes one paragraph. */
function paraLeaf(block) {
  return { nodes: [{ type: 'paragraph', attrs: { id: block.id }, content: [{ type: 'text', text: block.text ?? '' }] }] };
}

function block(id, type, children = [], extra = {}) {
  return {
    id,
    type,
    parentId: null,
    children: [...children],
    text: extra.text ?? '',
    properties: extra.properties ?? {},
  };
}

function expectInvalid(fn) {
  assert.throws(fn, (err) => {
    assert.equal(err instanceof Error, true);
    assert.equal(err.message, INVALID);
    return true;
  });
}

function leafCalls(blocks, rootIds, renderLeaf = paraLeaf) {
  const calls = [];
  const wrapped = (b) => {
    calls.push(b.id);
    return renderLeaf(b);
  };
  const result = assembleDocumentTree(blocks, rootIds, wrapped);
  return { ...result, calls };
}

/* ------------------------------------------------------------------ lists */

test('adjacent bullet siblings group into one bulletList with listItems', () => {
  const blocks = [block('a', 'bullet', [], { text: 'one' }), block('b', 'bullet', [], { text: 'two' })];
  const { nodes, issues } = assembleDocumentTree(blocks, ['a', 'b'], paraLeaf);
  assert.deepEqual(issues, []);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].type, 'bulletList');
  assert.deepEqual(nodes[0].attrs, undefined);
  assert.deepEqual(nodes[0].content.map((i) => i.type), ['listItem', 'listItem']);
  assert.deepEqual(nodes[0].content[0].content[0].content[0].text, 'one');
  assert.deepEqual(nodes[0].content[1].content[0].content[0].text, 'two');
});

test('ordered list group carries attrs.start = 1', () => {
  const blocks = [block('a', 'ordered', [], { text: 'x' }), block('b', 'ordered', [], { text: 'y' })];
  const { nodes } = assembleDocumentTree(blocks, ['a', 'b'], paraLeaf);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].type, 'orderedList');
  assert.deepEqual(nodes[0].attrs, { start: 1 });
  assert.equal(nodes[0].content.length, 2);
});

test('todo items become taskList/taskItem with checked from properties', () => {
  const blocks = [
    block('a', 'todo', [], { properties: { checked: true } }),
    block('b', 'todo', [], { properties: { checked: false } }),
    block('c', 'todo', [], { properties: {} }),
    block('d', 'todo', [], { properties: { checked: 'yes' } }),
  ];
  const { nodes } = assembleDocumentTree(blocks, ['a', 'b', 'c', 'd'], paraLeaf);
  assert.equal(nodes[0].type, 'taskList');
  assert.deepEqual(
    nodes[0].content.map((i) => [i.type, i.attrs.checked]),
    [
      ['taskItem', true],
      ['taskItem', false],
      ['taskItem', false],
      ['taskItem', false],
    ],
  );
});

test('non-list node interrupts a list group', () => {
  const blocks = [
    block('b1', 'bullet', [], { text: 'a' }),
    block('p', 'paragraph', [], { text: 'mid' }),
    block('b2', 'bullet', [], { text: 'b' }),
  ];
  const { nodes } = assembleDocumentTree(blocks, ['b1', 'p', 'b2'], paraLeaf);
  assert.deepEqual(nodes.map((n) => n.type), ['bulletList', 'paragraph', 'bulletList']);
  assert.equal(nodes[0].content.length, 1);
  assert.equal(nodes[2].content.length, 1);
});

test('switching list type creates distinct lists and keeps order', () => {
  const blocks = [
    block('a', 'bullet', [], { text: '1' }),
    block('b', 'bullet', [], { text: '2' }),
    block('c', 'ordered', [], { text: '3' }),
    block('d', 'todo', [], { text: '4' }),
    block('e', 'ordered', [], { text: '5' }),
  ];
  const { nodes } = assembleDocumentTree(blocks, ['a', 'b', 'c', 'd', 'e'], paraLeaf);
  assert.deepEqual(nodes.map((n) => n.type), ['bulletList', 'orderedList', 'taskList', 'orderedList']);
  assert.deepEqual(nodes[0].content.map((i) => i.content[0].content[0].text), ['1', '2']);
  assert.equal(nodes[1].content[0].content[0].content[0].text, '3');
  assert.equal(nodes[3].content[0].content[0].content[0].text, '5');
});

test('nested list children stay inside their parent listItem', () => {
  const child = block('n1', 'bullet', [], { text: 'nested' });
  const parent = block('p1', 'bullet', ['n1'], { text: 'parent' });
  const tail = block('t1', 'bullet', [], { text: 'tail' });
  const { nodes } = assembleDocumentTree([parent, child, tail], ['p1', 't1'], paraLeaf);

  assert.deepEqual(nodes.map((n) => n.type), ['bulletList']);
  const list = nodes[0];
  assert.equal(list.content.length, 2);
  const parentItem = list.content[0];
  assert.deepEqual(parentItem.content.map((n) => n.type), ['paragraph', 'bulletList']);
  assert.equal(parentItem.content[1].content.length, 1);
  // nested item never re-emitted at top level
  const flat = JSON.stringify(nodes);
  assert.equal(flat.split('"nested"').length - 1, 1);
});

test('empty list item supplies a paragraph', () => {
  const empty = block('e', 'bullet', [], { text: '' });
  const emptyTodo = block('t', 'todo', [], { text: '' });
  const { nodes } = assembleDocumentTree([empty, emptyTodo], ['e', 't'], paraLeaf);
  // bullet and todo are different kinds -> two containers
  assert.deepEqual(nodes.map((n) => n.type), ['bulletList', 'taskList']);
  assert.deepEqual(nodes[0].content[0].content, [{ type: 'paragraph' }]);
  assert.deepEqual(nodes[1].content[0].content, [{ type: 'paragraph' }]);
});

test('leaf call order is exactly retained for mixed siblings', () => {
  const blocks = [
    block('h', 'heading', [], { text: 'H' }),
    block('b1', 'bullet', [], { text: 'b1' }),
    block('b2', 'bullet', [], { text: 'b2' }),
    block('q', 'quote', [], { text: 'Q' }),
    block('o1', 'ordered', [], { text: 'o1' }),
  ];
  const { calls } = leafCalls(blocks, ['h', 'b1', 'b2', 'q', 'o1']);
  assert.deepEqual(calls, ['h', 'b1', 'b2', 'q', 'o1']);
});

/* --------------------------------------------------- tables / consumed ids */

test('table consumed descendants are skipped and never leaf-called', () => {
  const table = block('tbl', 'table', ['c1', 'c2']);
  const c1 = block('c1', 'table_cell', [], { text: 'a' });
  const c2 = block('c2', 'table_cell', [], { text: 'b' });
  const after = block('after', 'paragraph', [], { text: 'after' });

  const calls = [];
  const render = (b) => {
    calls.push(b.id);
    if (b.id === 'tbl') return { nodes: [{ type: 'table', attrs: { rows: 1 } }], consumed: ['c1', 'c2'] };
    return { nodes: [{ type: 'paragraph', content: [{ type: 'text', text: b.text }] }] };
  };

  const { nodes, issues } = assembleDocumentTree([table, c1, c2, after], ['tbl', 'after'], render);
  assert.deepEqual(issues, []);
  assert.deepEqual(calls, ['tbl', 'after']);
  assert.deepEqual(nodes.map((n) => n.type), ['table', 'paragraph']);
});

test('consumed ids inside a list item subtree are skipped too', () => {
  const item = block('li', 'bullet', ['tbl'], { text: 'row' });
  const table = block('tbl', 'table', ['cell']);
  const cell = block('cell', 'table_cell', [], { text: 'x' });
  const calls = [];
  const render = (b) => {
    calls.push(b.id);
    if (b.id === 'tbl') return { nodes: [{ type: 'table' }], consumed: ['cell'] };
    return { nodes: [{ type: 'paragraph', content: [{ type: 'text', text: b.text }] }] };
  };
  const { nodes } = assembleDocumentTree([item, table, cell], ['li'], render);
  assert.deepEqual(calls, ['li', 'tbl']);
  assert.equal(nodes[0].type, 'bulletList');
  assert.deepEqual(nodes[0].content[0].content.map((n) => n.type), ['paragraph', 'table']);
});

test('unknown consumed id throws', () => {
  const blocks = [block('tbl', 'table', [])];
  const render = () => ({ nodes: [{ type: 'table' }], consumed: ['ghost'] });
  expectInvalid(() => assembleDocumentTree(blocks, ['tbl'], render));
});

/* ---------------------------------------------------- transparent wrappers */

test('page/root/document/view are transparent and only leaf-called when text nonempty', () => {
  const page = block('page', 'page', ['doc'], { text: 'PAGE' });
  const doc = block('doc', 'document', ['view'], { text: '' });
  const view = block('view', 'view', ['p1'], { text: 'VIEW' });
  const p1 = block('p1', 'paragraph', [], { text: 'body' });

  const { calls, nodes } = leafCalls([page, doc, view, p1], ['page'], paraLeaf);
  assert.deepEqual(calls, ['page', 'view', 'p1']);
  assert.deepEqual(nodes.map((n) => n.type), ['paragraph', 'paragraph', 'paragraph']);
  assert.equal(nodes[0].attrs.id, 'page');
  assert.equal(nodes[1].attrs.id, 'view');
  assert.equal(nodes[2].attrs.id, 'p1');
});

test('empty transparent wrapper with no children emits nothing', () => {
  const page = block('page', 'page', []);
  const { nodes, issues } = assembleDocumentTree([page], ['page'], paraLeaf);
  assert.deepEqual(nodes, []);
  assert.deepEqual(issues, []);
});

/* --------------------------------------------------------------- columns */

test('grid produces columnLayout with explicit width ratios', () => {
  const grid = block('g', 'grid', ['c1', 'c2']);
  const c1 = block('c1', 'grid_column', ['p1'], { properties: { width_ratio: 0.6 } });
  const c2 = block('c2', 'grid_column', [], { properties: { width_ratio: 0.4 } });
  const p1 = block('p1', 'paragraph', [], { text: 'left' });

  const { nodes } = assembleDocumentTree([grid, c1, c2, p1], ['g'], paraLeaf);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].type, 'columnLayout');
  assert.deepEqual(nodes[0].content.map((c) => [c.type, c.attrs.widthRatio]), [
    ['column', 0.6],
    ['column', 0.4],
  ]);
  assert.deepEqual(nodes[0].content[0].content.map((n) => n.type), ['paragraph']);
  assert.equal(nodes[0].content[0].content[0].attrs.id, 'p1');
  // empty column falls back to a paragraph
  assert.deepEqual(nodes[0].content[1].content, [{ type: 'paragraph' }]);
});

test('missing width_ratio yields equal-share ratio and zero/invalid ratio throws', () => {
  const grid = block('g', 'grid', ['c1']);
  const c1 = block('c1', 'grid_column', []);
  const { nodes } = assembleDocumentTree([grid, c1], ['g'], paraLeaf);
  assert.equal(nodes[0].content[0].attrs.widthRatio, 1);

  for (const bad of [0, -0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '0.5']) {
    const g2 = block('g2', 'grid', ['x1']);
    const x1 = block('x1', 'grid_column', [], { properties: { width_ratio: bad } });
    expectInvalid(() => assembleDocumentTree([g2, x1], ['g2'], paraLeaf));
  }
  // ratio exactly 1 is allowed
  const g3 = block('g3', 'grid', ['y1']);
  const y1 = block('y1', 'grid_column', [], { properties: { width_ratio: 1 } });
  const r3 = assembleDocumentTree([g3, y1], ['g3'], paraLeaf);
  assert.equal(r3.nodes[0].content[0].attrs.widthRatio, 1);
});

test('grid without columns falls back to paragraph with DOCUMENT_GRID_EMPTY', () => {
  const grid = block('g', 'grid', []);
  const { nodes, issues } = assembleDocumentTree([grid], ['g'], paraLeaf);
  assert.deepEqual(nodes, [{ type: 'paragraph' }]);
  assert.deepEqual(issues, ['DOCUMENT_GRID_EMPTY']);
});

test('standalone grid_column emits a column inside one columnLayout with orphan issue', () => {
  const col = block('c', 'grid_column', ['p'], { properties: { width_ratio: 0.5 } });
  const p = block('p', 'paragraph', [], { text: 'solo' });
  const { nodes, issues } = assembleDocumentTree([col, p], null, paraLeaf);
  assert.deepEqual(issues, ['DOCUMENT_COLUMN_ORPHAN_INCLUDED']);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].type, 'columnLayout');
  assert.equal(nodes[0].content.length, 1);
  assert.equal(nodes[0].content[0].type, 'column');
  assert.equal(nodes[0].content[0].attrs.widthRatio, 0.5);
  assert.equal(nodes[0].content[0].content[0].attrs.id, 'p');
});

test('non-column child inside a grid throws instead of silently dropping', () => {
  const grid = block('g', 'grid', ['bad']);
  const bad = block('bad', 'paragraph', []);
  expectInvalid(() => assembleDocumentTree([grid, bad], ['g'], paraLeaf));
});

test('grid and grid_column need not invoke the callback', () => {
  const grid = block('g', 'grid', ['c']);
  const c = block('c', 'grid_column', []);
  const calls = [];
  const render = (b) => {
    calls.push(b.id);
    return { nodes: [{ type: 'paragraph' }] };
  };
  const { nodes } = assembleDocumentTree([grid, c], ['g'], render);
  assert.deepEqual(calls, []);
  assert.equal(nodes[0].type, 'columnLayout');
});

/* ------------------------------------------------------- integrity errors */

test('duplicate ids throw', () => {
  const blocks = [block('a', 'paragraph'), block('a', 'paragraph')];
  expectInvalid(() => assembleDocumentTree(blocks, ['a'], paraLeaf));
});

test('unknown child reference throws', () => {
  const blocks = [block('a', 'paragraph', ['missing'])];
  expectInvalid(() => assembleDocumentTree(blocks, ['a'], paraLeaf));
});

test('unknown root id throws', () => {
  const blocks = [block('a', 'paragraph')];
  expectInvalid(() => assembleDocumentTree(blocks, ['a', 'ghost'], paraLeaf));
});

test('cycle throws', () => {
  const a = block('a', 'page', ['b']);
  const b = block('b', 'page', ['c']);
  const c = block('c', 'page', ['a']);
  expectInvalid(() => assembleDocumentTree([a, b, c], ['a'], paraLeaf));
});

test('self reference throws', () => {
  const a = block('a', 'page', ['a']);
  expectInvalid(() => assembleDocumentTree([a], ['a'], paraLeaf));
});

test('shared child between two parents throws', () => {
  const shared = block('s', 'paragraph', []);
  const p1 = block('p1', 'page', ['s']);
  const p2 = block('p2', 'page', ['s']);
  expectInvalid(() => assembleDocumentTree([shared, p1, p2], ['p1', 'p2'], paraLeaf));
});

test('same child listed twice under one parent throws', () => {
  const c = block('c', 'paragraph', []);
  const p = block('p', 'page', ['c', 'c']);
  expectInvalid(() => assembleDocumentTree([p, c], ['p'], paraLeaf));
});

test('root parent consistency is not enforced (legacy external parent ids)', () => {
  const a = block('a', 'paragraph', [], { parentId: 'not-in-this-batch' });
  const res = assembleDocumentTree([a], ['a'], paraLeaf);
  assert.equal(res.nodes.length, 1);
  assert.deepEqual(res.issues, []);
});

test('depth limit: nesting beyond MAX_DEPTH throws', () => {
  const depth = MAX_DEPTH + 1;
  const blocks = [];
  for (let i = 0; i < depth; i += 1) {
    blocks.push(block(`w${i}`, 'page', i + 1 < depth ? [`w${i + 1}`] : []));
  }
  expectInvalid(() => assembleDocumentTree(blocks, ['w0'], paraLeaf));

  // exactly at the limit must succeed
  const okBlocks = [];
  for (let i = 0; i < MAX_DEPTH; i += 1) {
    okBlocks.push(block(`v${i}`, 'page', i + 1 < MAX_DEPTH ? [`v${i + 1}`] : []));
  }
  const ok = assembleDocumentTree(okBlocks, ['v0'], paraLeaf);
  assert.equal(ok.nodes.length, 0);
});

test('block count limit', () => {
  assert.equal(MAX_BLOCKS, 20000);
  const blocks = [];
  for (let i = 0; i <= MAX_BLOCKS; i += 1) blocks.push(block(`b${i}`, 'paragraph'));
  expectInvalid(() => assembleDocumentTree(blocks, null, paraLeaf));
});

/* ------------------------------------------------------------- orphans */

test('unreferenced orphans append in original input order with issue', () => {
  const root = block('r', 'page', ['k'], { text: 'root' });
  const kid = block('k', 'paragraph', [], { text: 'kid' });
  const orphanB = block('ob', 'paragraph', [], { text: 'orphan-b' });
  const orphanA = block('oa', 'paragraph', [], { text: 'orphan-a' });

  const { nodes, issues } = assembleDocumentTree([root, kid, orphanB, orphanA], ['r'], paraLeaf);
  assert.deepEqual(issues, ['DOCUMENT_ORPHAN_INCLUDED', 'DOCUMENT_ORPHAN_INCLUDED']);
  assert.deepEqual(nodes.map((n) => n.attrs.id), ['r', 'k', 'ob', 'oa']);
});

test('orphan list blocks still group when adjacent', () => {
  const o1 = block('o1', 'bullet', [], { text: 'x' });
  const o2 = block('o2', 'bullet', [], { text: 'y' });
  const { nodes, issues } = assembleDocumentTree([o1, o2], [], paraLeaf);
  assert.deepEqual(issues, ['DOCUMENT_ORPHAN_INCLUDED', 'DOCUMENT_ORPHAN_INCLUDED']);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].type, 'bulletList');
  assert.equal(nodes[0].content.length, 2);
});

test('rootIds omitted still resolves every top-level block', () => {
  const a = block('a', 'paragraph', [], { text: 'a' });
  const b = block('b', 'page', ['c'], { text: '' });
  const c = block('c', 'paragraph', [], { text: 'c' });
  const { nodes, issues } = assembleDocumentTree([a, b, c], null, paraLeaf);
  assert.deepEqual(issues, []);
  assert.deepEqual(nodes.map((n) => n.attrs.id), ['a', 'c']);
});

/* --------------------------------------------------------- immutability */

test('input blocks are not mutated', () => {
  const blocks = [block('p', 'page', ['a', 'b'], { text: 'P' }), block('a', 'bullet', []), block('b', 'ordered', [])];
  const snapshot = JSON.parse(JSON.stringify(blocks));
  assembleDocumentTree(blocks, ['p'], paraLeaf);
  assert.deepEqual(blocks, snapshot);
});

test('callback result objects stay mutable and our nodes are independent copies', () => {
  let captured = null;
  const render = (b) => {
    const result = { nodes: [{ type: 'paragraph', content: [{ type: 'text', text: b.text }] }], consumed: [] };
    captured = result;
    return result;
  };
  const { nodes } = assembleDocumentTree([block('x', 'paragraph', [], { text: 'hi' })], ['x'], render);

  assert.equal(Object.isFrozen(captured), false);
  assert.equal(Object.isFrozen(captured.nodes), false);
  assert.equal(Object.isFrozen(captured.nodes[0]), false);

  // Mutating our output must not reach back into the callback result.
  nodes[0].content[0].text = 'changed';
  assert.equal(captured.nodes[0].content[0].text, 'hi');
});

test('callback may not be bypassed: non-function renderLeaf throws', () => {
  expectInvalid(() => assembleDocumentTree([block('a', 'paragraph')], ['a'], null));
});

test('malformed callback result throws', () => {
  expectInvalid(() => assembleDocumentTree([block('a', 'paragraph')], ['a'], () => ({ nodes: 'nope' })));
  expectInvalid(() => assembleDocumentTree([block('a', 'paragraph')], ['a'], () => 'nope'));
  // undefined nodes/consumed tolerated as empty
  const res = assembleDocumentTree([block('a', 'paragraph')], ['a'], () => ({}));
  assert.deepEqual(res.nodes, []);
});

test('malformed block shapes throw', () => {
  expectInvalid(() => assembleDocumentTree('nope', [], paraLeaf));
  expectInvalid(() => assembleDocumentTree([null], [], paraLeaf));
  expectInvalid(() => assembleDocumentTree([{ id: '', type: 'paragraph' }], [], paraLeaf));
  expectInvalid(() => assembleDocumentTree([{ id: 'a' }], ['a'], paraLeaf)); // type missing
  expectInvalid(() => assembleDocumentTree([block('a', 'page', 'nope')], ['a'], paraLeaf));
  expectInvalid(() => assembleDocumentTree([block('a', 'page', [42])], ['a'], paraLeaf));
});

test('type matching is case/whitespace tolerant for grouping', () => {
  const blocks = [block('a', ' Bullet ', []), block('b', 'BULLET', [])];
  const { nodes } = assembleDocumentTree(blocks, ['a', 'b'], paraLeaf);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].type, 'bulletList');
});

test('empty input yields empty result', () => {
  const { nodes, issues } = assembleDocumentTree([], [], paraLeaf);
  assert.deepEqual(nodes, []);
  assert.deepEqual(issues, []);
});

test('empty list parent with nested list begins with an editable paragraph',()=>{
 const result=assembleDocumentTree([block('a','bullet',['b']),block('b','bullet',[],{text:'child'})],['a'],paraLeaf);
 assert.equal(result.nodes[0].content[0].content[0].type,'paragraph');
 assert.equal(result.nodes[0].content[0].content[1].type,'bulletList');
});

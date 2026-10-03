import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { capturePage } from '../extension/capture.mjs';
import { validateSnapshot } from '../extension/archive.mjs';

async function run(window = {}, href = 'https://team.feishu.cn/sheets/sample?auth=not-a-real-secret#section', overrides = {}) {
  const u = new URL(href);
  const context = vm.createContext({ window, location: { href, origin: u.origin, pathname: u.pathname }, document: { title: '合成样本 - 飞书云文档' }, URL, setTimeout, expectedSource: u.origin + u.pathname, ...overrides });
  // Exercise exactly the serialized function used by chrome.scripting.
  const result = await vm.runInContext(`(${capturePage.toString()})({expectedSource})`, context);
  return JSON.parse(JSON.stringify(result));
}
function sheet(overrides = {}) {
  return {
    _name: '测试表', getRowCount: () => 3, getColumnCount: () => 2,
    getValue: (r, c) => r === 0 && c === 0 ? 0 : r === 1 && c === 0 ? false : null,
    getText: (r, c) => r === 0 && c === 0 ? '0' : r === 1 && c === 0 ? 'FALSE' : '',
    getFormula: (r, c) => r === 2 && c === 0 ? '=A1+1' : '',
    getStyle: (r, c) => r === 0 && c === 0 ? { _font: 'bold 12px Arial', _backColor: '#eee', secret: 'must-not-copy', _borderLeft: { color: '#000', style: 1 } } : {},
    getSpans: () => [{ row: 0, col: 0, rowCount: 1, colCount: 2 }],
    getRowHeight: () => 24, getColumnWidth: () => 120, ...overrides
  };
}
function block(id, type, children = [], parent = null, text = undefined) {
  return { type, struct: { id, record: { snapshot: { children, parent_id: parent, text, author: 'must-not-copy', comments: ['private'], align: 'left' } } } };
}
function doc(blocks) { return { PageMain: { editor: { editor: { api: { modelService: { allBlockModels: blocks } } } } } }; }
const rich = { initialAttributedTexts: { text: { '1': '世界', '0': '你好' }, attribs: { '0': '*0+2', '1': '*1+2' } }, apool: { numToAttrib: { '0': ['bold', 'true'], '1': ['author', 'must-not-copy'] } } };

test('rejects unsupported sources including suffix impostors before model access', async () => {
  for (const href of ['http://team.feishu.cn/sheets/a', 'https://team.feishu.cn.evil.test/sheets/a', 'https://evil.test/sheets/a', 'https://team.feishu.cn/settings']) assert.deepEqual(await run({}, href), { ok: false, code: 'UNSUPPORTED_SOURCE' });
});
test('slides fail explicitly without emitting a successful empty archive', async () => {
  assert.deepEqual(await run({}, 'https://team.feishu.cn/slides/a'), { ok: false, code: 'SLIDES_ADAPTER_PENDING' });
});
test('missing or changed models do not produce empty successful snapshots', async () => {
  assert.equal((await run()).code, 'MODEL_UNAVAILABLE');
  assert.equal((await run({ spread: { sheets: [{ getRowCount() {} }] } })).code, 'MODEL_SHAPE_CHANGED');
});
test('sheets keep types, formula, display, styles, dimensions and merge positions', async () => {
  const source = sheet(); Object.freeze(source);
  const result = await run({ spread: { sheets: [source] } });
  assert.equal(result.ok, true); validateSnapshot(result.snapshot);
  const s = result.snapshot.model.sheets[0];
  assert.equal(s.cells.length, 3); assert.equal(s.cells[0].value, 0); assert.equal(s.cells[1].value, false);
  assert.equal(s.cells[2].formula, '=A1+1'); assert.equal(s.cells[2].value, null);
  assert.equal(s.cells[0].style._backColor, '#eee'); assert.equal(s.cells[0].style.secret, undefined);
  assert.deepEqual(s.merges, [{ row: 0, column: 0, rows: 1, columns: 2 }]);
  assert.deepEqual(s.rowHeights, [24, 24, 24]); assert.deepEqual(s.columnWidths, [120, 120]);
  assert.equal(result.snapshot.source.url, 'https://team.feishu.cn/sheets/sample');
  assert.equal(result.snapshot.fidelity.complete, false); assert.equal(result.snapshot.fidelity.status, 'PENDING');
});
test('unloaded or empty sheets are reported as ambiguous', async () => {
  const empty = sheet({ getValue: () => null, getFormula: () => '', getStyle: () => ({}) });
  const result = await run({ spread: { sheets: [empty] } });
  assert.ok(result.snapshot.issues.some(x => x.code === 'EMPTY_OR_UNLOADED_SHEET'));
  assert.ok(result.snapshot.issues.some(x => x.code === 'FORMULA_COVERAGE_UNVERIFIED'));
});
test('oversized ranges and invalid merges fail without partial output', async () => {
  assert.equal((await run({ spread: { sheets: [sheet({ getRowCount: () => 100000, getColumnCount: () => 10 })] } })).code, 'CELL_RANGE_LIMIT');
  assert.equal((await run({ spread: { sheets: [sheet({ getSpans: () => [{ row: 2, col: 0, rowCount: 2, colCount: 1 }] })] } })).code, 'MODEL_SHAPE_CHANGED');
});
test('page exception details and credential-like text never appear in errors', async () => {
  const result = await run({ spread: { sheets: [sheet({ getValue() { throw new Error('private-cookie=DO_NOT_ECHO'); } })] } });
  assert.deepEqual(result, { ok: false, code: 'PAGE_READ_FAILED' });
});
test('complex values remain explicit unsupported items, not fake strings', async () => {
  const result = await run({ spread: { sheets: [sheet({ getValue: () => ({ secret: 'not-for-export' }) })] } });
  assert.ok(result.snapshot.issues.some(x => x.code === 'NON_SCALAR_VALUE'));
  assert.ok(!JSON.stringify(result).includes('not-for-export'));
});
test('document keeps text order and tree while excluding author and comments', async () => {
  const blocks = [block('p', 'page', ['t', 'i']), block('t', 'text', [], 'p', rich), block('i', 'image', [], 'p')];
  const before = JSON.stringify(blocks);
  const result = await run(doc(blocks), 'https://team.feishu.cn/wiki/doc');
  assert.equal(result.ok, true); validateSnapshot(result.snapshot);
  assert.equal(result.snapshot.model.blocks[1].text, '你好世界');
  assert.deepEqual(result.snapshot.model.blocks[1].richText.attributes, { '0': ['bold', 'true'] });
  assert.deepEqual(result.snapshot.model.rootIds, ['p']);
  assert.ok(result.snapshot.issues.some(x => x.code === 'EMBEDDED_CONTENT_NOT_CAPTURED'));
  assert.ok(!JSON.stringify(result).includes('must-not-copy')); assert.equal(JSON.stringify(blocks), before);
});
test('unresolved children and unknown types remain in the report', async () => {
  const result = await run(doc([block('p', 'page', ['missing', 'new']), block('new', 'custom_widget', [], 'p')]));
  assert.ok(result.snapshot.issues.some(x => x.code === 'UNRESOLVED_CHILD'));
  assert.ok(result.snapshot.issues.some(x => x.code === 'UNKNOWN_BLOCK_TYPE'));
});
test('changed text schemas are retained as issues and duplicate IDs fail', async () => {
  const unknown = await run(doc([block('p', 'text', [], null, { unsupported: 'x' })]));
  assert.ok(unknown.snapshot.issues.some(x => x.code === 'TEXT_SHAPE_UNKNOWN'));
  assert.equal((await run(doc([block('p', 'page'), block('p', 'text')]))).code, 'BLOCK_ID_INVALID');
});
test('rich links cannot preserve URL authentication or become executable', async () => {
  const text = structuredClone(rich);
  text.apool.numToAttrib = { '0': ['link', 'https://example.test/path?token=PRIVATE#secret'], '1': ['link', 'javascript:alert(1)'] };
  const result = await run(doc([block('p', 'text', [], null, text)]));
  assert.deepEqual(result.snapshot.model.blocks[0].richText.attributes, { '0': ['link', 'https://example.test/path'] });
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});
test('timeout and navigation during capture are detected', async () => {
  class Clock extends Date { static times = 0; static now() { return Clock.times++ * 13000; } }
  assert.equal((await run({ spread: { sheets: [sheet()] } }, undefined, { Date: Clock })).code, 'CAPTURE_TIMEOUT');
  const location = { href: 'https://team.feishu.cn/sheets/a', origin: 'https://team.feishu.cn', pathname: '/sheets/a' };
  const changed = sheet({ getValue() { location.pathname = '/sheets/b'; return null; } });
  assert.equal((await run({ spread: { sheets: [changed] } }, undefined, { location, expectedSource: location.origin + location.pathname })).code, 'SOURCE_CHANGED');
});
test('last getter crossing deadline cannot emit success', async () => {
  let now = 0; class Clock extends Date { static now() { return now; } }
  const late = sheet({ getRowCount: () => 1, getColumnCount: () => 1, getValue: () => null, getSpans: () => { now = 13001; return []; } });
  assert.deepEqual(await run({ spread: { sheets: [late] } }, undefined, { Date: Clock }), { ok: false, code: 'CAPTURE_TIMEOUT' });
});
test('same-origin navigation before capture is rejected before reading models', async () => {
  let reads = 0;
  const other = sheet({ getValue() { reads++; return null; } });
  const result = await run({ spread: { sheets: [other] } }, undefined, { expectedSource: 'https://team.feishu.cn/sheets/original' });
  assert.deepEqual(result, { ok: false, code: 'SOURCE_CHANGED' }); assert.equal(reads, 0);
});

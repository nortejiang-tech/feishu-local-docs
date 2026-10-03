import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../extension/metrics.mjs';

test('document counts type distribution and characters without using raw fields', () => {
  const snapshot = { kind: 'document', model: { blocks: [
    { type: 'text', text: '中文', raw: { text: 'ignore' } },
    { type: 'text', text: 'abc' }, { type: 'image' }, { text: 18 }
  ] } };
  assert.deepEqual(summarize(snapshot), { kind: 'document', items: 4, textCharacters: 5, byType: { text: 2, image: 1, unknown: 1 } });
});
test('empty and zero-valued cells remain distinct from formula strings', () => {
  const snapshot = { kind: 'sheet', model: { sheets: [
    { cells: [{ value: 0 }, { value: false }, { value: '' }, { value: null, formula: '=A1+1' }, { value: 3, formula: '' }, { style: { color: 'red' } }], merges: [{ r: 0 }] },
    { cells: [{ value: 'text', formula: '=A1' }], merges: [] }
  ] } };
  assert.deepEqual(summarize(snapshot), { kind: 'sheet', items: 2, cells: 7, nonemptyValues: 4, formulas: 2, merges: 1 });
});
test('missing arrays are empty', () => {
  assert.deepEqual(summarize({ kind: 'sheet' }), { kind: 'sheet', items: 0, cells: 0, nonemptyValues: 0, formulas: 0, merges: 0 });
  assert.deepEqual(summarize({ kind: 'document', model: {} }), { kind: 'document', items: 0, textCharacters: 0, byType: {} });
});
test('unknown inputs are explicit', () => {
  for (const value of [null, undefined, {}, { kind: 'slides' }]) assert.deepEqual(summarize(value), { kind: 'unknown', items: 0 });
});
test('does not mutate input', () => {
  const snapshot = { kind: 'sheet', model: { sheets: [{ cells: [{ value: false }], merges: [] }] } };
  const before = structuredClone(snapshot);
  summarize(snapshot);
  assert.deepEqual(snapshot, before);
});
test('data type names do not resolve inherited properties', () => {
  const result = summarize({ kind: 'document', model: { blocks: [{ type: '__proto__' }, { type: 'constructor' }, { type: '__proto__' }] } });
  assert.equal(Object.getPrototypeOf(result.byType), Object.prototype);
  assert.equal(Object.hasOwn(result.byType, '__proto__'), true);
  assert.equal(result.byType.__proto__, 2);
  assert.equal(result.byType.constructor, 1);
});

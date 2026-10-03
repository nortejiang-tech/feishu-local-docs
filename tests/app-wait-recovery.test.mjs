import test from 'node:test';
import assert from 'node:assert/strict';
import { withDeadline } from '../app/src/operation-deadline.mjs';
import { createDocument } from '../shared/model.mjs';
import { loadLibrary, saveLocal } from '../app/src/io.mjs';

function fakeClock() {
  let nextId = 0;
  const pending = new Map();
  return {
    pending,
    setTimeout(callback, delay) { const id = ++nextId; pending.set(id, { callback, delay }); return id; },
    clearTimeout(id) { pending.delete(id); },
    fireNext() { const [id, timer] = pending.entries().next().value; pending.delete(id); timer.callback(); },
  };
}

test('deadline rejects late completion, consumes late failures, and clears its timer', async () => {
  const clock = fakeClock();
  let resolveWork;
  let continued = false;
  const work = new Promise(resolve => { resolveWork = resolve; });
  const result = withDeadline(work, 10, clock);
  result.then(() => { continued = true; }, () => {});
  assert.equal(clock.pending.size, 1);
  clock.fireNext();
  await assert.rejects(result, error => error.message === 'OPERATION_TIMEOUT');
  resolveWork('late');
  await work;
  await Promise.resolve();
  assert.equal(continued, false);
  assert.equal(clock.pending.size, 0);

  const rejectClock = fakeClock();
  let rejectWork;
  let followed = false;
  const rejectedLate = new Promise((_, reject) => { rejectWork = reject; });
  const rejectedResult = withDeadline(rejectedLate, 10, rejectClock);
  rejectedResult.then(() => { followed = true; }, () => {});
  rejectClock.fireNext();
  await assert.rejects(rejectedResult, error => error.message === 'OPERATION_TIMEOUT');
  rejectWork(new Error('late private failure'));
  await Promise.resolve();
  assert.equal(followed, false);
  assert.equal(rejectClock.pending.size, 0);
});

test('deadline can settle normally and clears the timer', async () => {
  const clock = fakeClock();
  assert.equal(await withDeadline(Promise.resolve('done'), 10, clock), 'done');
  await Promise.resolve();
  assert.equal(clock.pending.size, 0);
});

test('timed out save does not block later ordered saves and hides bridge errors', async () => {
  const clock = fakeClock();
  const writes = [];
  let finishFirst;
  globalThis.window = { localDocsNative: { request: async (action, { text }) => {
    const doc = JSON.parse(text).document;
    writes.push(doc.title);
    if (writes.length === 1) return new Promise((resolve, reject) => { finishFirst = { resolve, reject }; });
    return { savedAt: 'later' };
  } } };
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = clock.setTimeout;
  globalThis.clearTimeout = clock.clearTimeout;
  try {
    const firstDoc = createDocument('document', 'First snapshot');
    const first = saveLocal(firstDoc);
    for (let i = 0; i < 100 && writes.length === 0; i++) await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(writes, ['First snapshot']);
    clock.fireNext();
    await assert.rejects(first, error => error.message === '保存尚未确认完成，当前编辑仍保留，请稍后重试。');
    const next = saveLocal(createDocument('document', 'Second snapshot'));
    await next;
    assert.deepEqual(writes, ['First snapshot', 'Second snapshot']);
    finishFirst.reject(new Error('private bridge detail'));
    await Promise.resolve();
    assert.deepEqual(writes, ['First snapshot', 'Second snapshot']);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('encoding timeout releases the save queue without a late hash starting a stale write', async () => {
  const clock = fakeClock();
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const originalNativeDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localDocsNative');
  const firstDoc = createDocument('document', 'Hash stalled');
  const nextDoc = createDocument('document', 'Next write');
  let finishHash;
  let hashCalls = 0;
  const actions = [];
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
  globalThis.setTimeout = clock.setTimeout;
  globalThis.clearTimeout = clock.clearTimeout;
  const bridge = { request: async (action) => {
    actions.push(action);
    if (action === 'sha256' && hashCalls++ === 0) return new Promise((resolve, reject) => { finishHash = { resolve, reject }; });
    if (action === 'sha256') return 'f'.repeat(64);
    return { savedAt: 'later' };
  } };
  globalThis.window = { localDocsNative: bridge };
  globalThis.localDocsNative = bridge;
  try {
    const first = saveLocal(firstDoc);
    for (let i = 0; i < 100 && !finishHash; i++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(finishHash);
    clock.fireNext();
    await assert.rejects(first, error => error.message === '保存尚未确认完成，当前编辑仍保留，请稍后重试。');
    const later = saveLocal(nextDoc);
    await later;
    finishHash.reject(new Error('late hash failure'));
    await Promise.resolve();
    assert.deepEqual(actions.filter(action => action === 'save'), ['save']);
  } finally {
    if (originalCryptoDescriptor) Object.defineProperty(globalThis, 'crypto', originalCryptoDescriptor);
    else delete globalThis.crypto;
    if (originalNativeDescriptor) Object.defineProperty(globalThis, 'localDocsNative', originalNativeDescriptor);
    else delete globalThis.localDocsNative;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('native library listing has a bounded wait and does not expose late bridge errors', async () => {
  const clock = fakeClock();
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let finishList;
  globalThis.setTimeout = clock.setTimeout;
  globalThis.clearTimeout = clock.clearTimeout;
  globalThis.window = { localDocsNative: { request: async action => {
    assert.equal(action, 'list');
    return new Promise((resolve, reject) => { finishList = { resolve, reject }; });
  } } };
  try {
    const listing = loadLibrary();
    for (let i = 0; i < 100 && !finishList; i++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(finishList);
    clock.fireNext();
    await assert.rejects(listing, /操作尚未确认完成/);
    finishList.reject(new Error('private late list failure'));
    await Promise.resolve();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

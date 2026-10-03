import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDemo } from '../extension/demo.mjs';
import { serializeArchive, parseArchive, renderPreview, fileName, orderedBlocks, validateSnapshot } from '../extension/archive.mjs';

test('both types survive serialize and reopen without changing model data', async () => {
  for (const kind of ['document', 'sheet']) {
    const sample = makeDemo(kind); const archived = await serializeArchive(sample);
    assert.deepEqual(await parseArchive(archived), sample);
    assert.equal(JSON.parse(archived).status, 'PENDING');
  }
});
test('modified payload fails checksum verification', async () => {
  const archive = JSON.parse(await serializeArchive(makeDemo())); archive.snapshot.model.blocks[1].text = 'changed';
  await assert.rejects(parseArchive(JSON.stringify(archive)), /ARCHIVE_HASH_MISMATCH/);
});
test('unverified success flags and removed mandatory gaps cannot be re-exported', async () => {
  const s = makeDemo(); s.fidelity.status = 'PASS'; s.fidelity.complete = true;
  await assert.rejects(serializeArchive(s), /ARCHIVE_INVALID/);
  const missing = makeDemo(); missing.issues = [];
  await assert.rejects(serializeArchive(missing), /ARCHIVE_INVALID/);
});
test('invalid JSON and unknown versions are rejected', async () => {
  await assert.rejects(parseArchive('not json'), /ARCHIVE_INVALID/);
  await assert.rejects(parseArchive('{"format":"fdocpack","version":99}'), /ARCHIVE_VERSION_UNSUPPORTED/);
});
test('oversized file is rejected before parsing', async () => {
  await assert.rejects(parseArchive(' '.repeat(24000001)), /ARCHIVE_TOO_LARGE/);
});
test('malformed arrays, coordinates, IDs and issue counts are rejected', () => {
  let s = makeDemo('sheet'); s.model.sheets[0].cells[0].row = -1; assert.throws(() => validateSnapshot(s), /ARCHIVE_INVALID/);
  s = makeDemo(); s.model.blocks[1].id = s.model.blocks[0].id; assert.throws(() => validateSnapshot(s), /ARCHIVE_INVALID/);
  s = makeDemo(); s.issues = [{ code: 'X', count: '1' }]; assert.throws(() => validateSnapshot(s), /ARCHIVE_INVALID/);
  s = makeDemo('sheet'); s.model.sheets[0].cells.push(s.model.sheets[0].cells[0]); assert.throws(() => validateSnapshot(s), /ARCHIVE_INVALID/);
});
test('hostile content is inert in downloadable HTML with no external URLs', () => {
  const s = makeDemo(); s.source.title = '</title><script>alert(1)</script>';
  s.model.blocks[1].text = '<img src="https://evil.test/leak" onerror="alert(1)"><script>alert(2)</script>';
  const html = renderPreview(s);
  assert.ok(!html.includes('<script')); assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img')); assert.ok(html.includes("default-src 'none'"));
  assert.ok(!html.includes('href="https://')); assert.ok(html.includes('PENDING'));
});
test('document preview follows children rather than unordered model enumeration', () => {
  const s = makeDemo(); s.model.blocks.reverse();
  assert.deepEqual(orderedBlocks(s).map(x => x.block.id), ['root', 'title', 'intro', 'list', 'board']);
});
test('cycles and orphaned blocks terminate and appear exactly once', () => {
  const s = makeDemo(); s.model.blocks[0].parentId = 'board'; s.model.blocks[4].children = ['root'];
  const order = orderedBlocks(s); assert.equal(order.length, 5); assert.equal(new Set(order.map(x => x.block.id)).size, 5);
});
test('sheet HTML preserves the formula text without calculating it', () => {
  const html = renderPreview(makeDemo('sheet')); assert.ok(html.includes('=SUM(B2:B3)')); assert.ok(html.includes('20'));
});
test('filenames cannot contain directory traversal, control or bidi characters', () => {
  const name = fileName('../秘密/资料\u202e\n', 'fdocpack.json');
  assert.ok(!/[\\/\u202e\n]/.test(name)); assert.ok(!name.startsWith('.')); assert.ok(name.endsWith('_部分归档.fdocpack.json'));
});

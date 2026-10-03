import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDemo } from '../extension/demo.mjs';
import { createDocument, decodeDocument, encodeDocument, safeFileName, updateContent, validateDocument } from '../shared/model.mjs';
import { importSnapshot } from '../shared/import-snapshot.mjs';

const editedContent = kind => kind === 'document'
  ? { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '修改后的段落', marks: [{ type: 'bold' }] }] }] }
  : { id: 'book', name: '编辑后', appVersion: '0.20.0', locale: 'zhCN', styles: {}, sheetOrder: ['s'], sheets: { s: { id: 's', name: 'Sheet1', rowCount: 100, columnCount: 26, cellData: { '0': { '0': { v: '修改后', t: 1 } } }, mergeData: [], rowData: {}, columnData: {} } } };

test('document and sheet survive edit, encode, decode and reopen', async () => {
  for (const kind of ['document', 'sheet']) {
    const original = createDocument(kind, '本地稿');
    const edited = updateContent(original, editedContent(kind));
    assert.equal(original.revision, 0);
    assert.equal(edited.revision, 1);
    assert.deepEqual(await decodeDocument(await encodeDocument(edited)), edited);
  }
});

test('integrity, size, and dangerous object keys are rejected', async () => {
  const encoded = await encodeDocument(createDocument());
  const envelope = JSON.parse(encoded);
  envelope.document.title = '篡改';
  await assert.rejects(decodeDocument(JSON.stringify(envelope)), /DOCUMENT_HASH_MISMATCH/);
  await assert.rejects(decodeDocument(' '.repeat(32 * 1024 * 1024 + 1)), /DOCUMENT_TOO_LARGE/);
  const poisoned = JSON.parse('{"format":"local-feishu","version":2,"sha256":"' + '0'.repeat(64) + '","document":{"__proto__":{},"id":"x"}}');
  await assert.rejects(decodeDocument(JSON.stringify(poisoned)), /DOCUMENT_INVALID/);
  const invalidSize = createDocument('sheet');
  invalidSize.content.sheets[invalidSize.content.sheetOrder[0]].rowCount = 100001;
  assert.throws(() => validateDocument(invalidSize), /DOCUMENT_INVALID/);
});

test('capture import preserves source snapshot and exposes document text', () => {
  const snapshot = makeDemo('document');
  const imported = importSnapshot(snapshot);
  assert.equal(imported.provenance.roundtrip, 'PENDING');
  assert.deepEqual(imported.provenance.capture, snapshot);
  assert.ok(JSON.stringify(imported.content).includes('每一份知识，都值得被好好保存。'));
  imported.provenance.capture.model.blocks[1].text = 'changed copy';
  assert.equal(snapshot.model.blocks[1].text, '每一份知识，都值得被好好保存。');
  assert.ok(imported.issues.some(issue => issue.code === 'ROUNDTRIP_NOT_IMPLEMENTED'));
});

test('sheet import retains formulas, merges, dimensions, style and app version', () => {
  const snapshot = makeDemo('sheet');
  snapshot.model.appVersion = '0.21.3';
  snapshot.model.sheets[0].cells[0].style = { _font: 'bold 12pt Arial', _foreColor: '#123456', _backColor: '#abcdef', _hAlign: 'center', _vAlign: 'middle', _wordWrap: true, _formatter: '0.00', _borderTop: { color: '#111111', style: 'thin' }, privateEditorField: 'retained in capture' };
  snapshot.model.sheets[0].merges = [{ row: 0, column: 0, rows: 1, columns: 2 }];
  snapshot.model.sheets[0].rowHeights = [32];
  snapshot.model.sheets[0].columnWidths = [120, 180];
  const imported = importSnapshot(snapshot);
  const sheetId = imported.content.sheetOrder[0];
  const sheet = imported.content.sheets[sheetId];
  assert.equal(imported.content.appVersion, '0.21.3');
  assert.equal(sheet.cellData['3']['1'].f, '=SUM(B2:B3)');
  assert.deepEqual(sheet.mergeData, [{ startRow: 0, endRow: 0, startColumn: 0, endColumn: 1 }]);
  assert.deepEqual(sheet.rowData['0'], { h: 32 });
  assert.deepEqual(sheet.columnData['1'], { w: 180 });
  assert.deepEqual(imported.content.styles[sheet.cellData['0']['0'].s], { ff: 'Arial', fs: 12, bl: 1, cl: { rgb: '#123456' }, bg: { rgb: '#abcdef' }, ht: 2, vt: 2, tb: 3, n: { pattern: '0.00' }, bd: { t: { s: 1, cl: { rgb: '#111111' } } } });
  assert.equal(imported.provenance.capture.model.sheets[0].cells[0].style.privateEditorField, 'retained in capture');
});

test('unsafe links, bad filenames and malformed document shapes are rejected', () => {
  const doc = createDocument();
  doc.content.content[0] = { type: 'image', attrs: { src: 'https://example.test/a.png' } };
  assert.throws(() => validateDocument(doc), /DOCUMENT_INVALID/);
  assert.equal(safeFileName('../资料\u202e'), '_资料_.localdoc');
  assert.throws(() => updateContent(createDocument(), { type: 'doc', content: [{ type: 'heading', attrs: { level: 7 } }] }), /DOCUMENT_INVALID/);
});


test('legacy block traversal emits flat valid nodes and retains unknown and deep-cycle text once', () => {
  const sample = makeDemo('document');
  const parent = sample.model.blocks.find(block => block.id === 'board');
  parent.text = '未知容器自己的文字';
  parent.children = ['cycle'];
  sample.model.blocks.push({ id: 'cycle', type: 'unknownChild', text: '子块文字', parentId: 'board', children: ['board'], properties: {}, richText: null });
  const imported = importSnapshot(sample);
  const tops = imported.content.content;
  const outputText = node => node.type === 'text' ? node.text : (node.content || []).map(outputText).join('');
  const allText = tops.map(outputText).join('');
  assert.equal(allText.split('未知容器自己的文字').length - 1, 1);
  assert.equal(allText.split('子块文字').length - 1, 1);
  const textblocks = new Set(['paragraph', 'heading', 'codeBlock']);
  const visit = node => {
    if (textblocks.has(node.type)) assert.ok((node.content || []).every(child => child.type === 'text'), `${node.type} may contain inline text only`);
    if (node.type === 'preservedBlock') assert.equal(node.content, undefined, 'preservedBlock stays a placeholder leaf');
    for (const child of node.content || []) visit(child);
  };
  for (const node of tops) visit(node);
  assert.ok(tops.some(node => node.type === 'preservedBlock' && node.attrs.sourceId === 'board'));

  const deep = makeDemo('document');
  deep.model.blocks = Array.from({ length: 3000 }, (_, index) => ({ id: `d${index}`, type: index ? 'unknown' : 'page', text: `t${index}`, parentId: index ? `d${index - 1}` : null, children: index < 2999 ? [`d${index + 1}`] : [], properties: {}, richText: null }));
  deep.model.rootIds = ['d0'];
  const deepImported = importSnapshot(deep);
  assert.equal(deepImported.content.content.length, 5999); // each unsupported node plus its visible text paragraph
  assert.ok(deepImported.content.content.some(node => node.type === 'paragraph' && outputText(node) === 't2999'));
});

test('sheet bounds count populated cells rather than blank dimension product and accept null tombstones', () => {
  const doc = createDocument('sheet');
  const sheet = doc.content.sheets[doc.content.sheetOrder[0]];
  sheet.rowCount = 100000;
  sheet.columnCount = 10000;
  sheet.cellData = { '0': null, '99999': { '9999': null } };
  assert.equal(validateDocument(doc), doc);
  assert.equal(doc.content.appVersion, '1.0.3');
  doc.id = 'not-a-uuid';
  assert.throws(() => validateDocument(doc), /DOCUMENT_INVALID/);
});

test('encode snapshots content before asynchronous hashing', async () => {
  const doc = createDocument('document', 'Before');
  const pending = encodeDocument(doc);
  doc.title = 'After';
  const reopened = await decodeDocument(await pending);
  assert.equal(reopened.title, 'Before');
});

test('small malicious input cannot expand into a billion merged cells', () => {
  const doc = createDocument('sheet');
  const sheet = doc.content.sheets[doc.content.sheetOrder[0]];
  sheet.rowCount = 100000; sheet.columnCount = 10000;
  sheet.mergeData = [{startRow:0,endRow:99999,startColumn:0,endColumn:9999}];
  assert.throws(()=>validateDocument(doc), /DOCUMENT_TOO_LARGE/);
});

test('sheet dimension metadata cannot allocate outside declared bounds', () => {
 const doc=createDocument('sheet');const sheet=doc.content.sheets[doc.content.sheetOrder[0]];
 sheet.rowData={'999999999':{hd:1}};
 assert.throws(()=>validateDocument(doc),/DOCUMENT_INVALID/);
 sheet.rowData={};sheet.columnData={'-1':{w:88}};
 assert.throws(()=>validateDocument(doc),/DOCUMENT_INVALID/);
});

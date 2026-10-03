import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCaptureAudit } from '../shared/capture-audit.mjs';

const CELL_COUNT = 918;

function makeSnapshot({ duplicates = 0, issues = [] } = {}) {
  const blocks = [{ id: 'h1', type: 'Heading' }];

  blocks.push({
    id: 'tbl-1',
    type: 'table',
    table: { rows: 51, columns: 18 },
  });
  for (let i = 0; i < CELL_COUNT; i += 1) {
    blocks.push({ id: `cell-${i}`, type: 'table_cell' });
  }

  blocks.push(
    {
      id: 'img-preview',
      type: 'IMAGE',
      resource: { kind: 'IMAGE', resourceId: 'res-opaque-1', name: '封面图' },
    },
    {
      id: 'img-missing',
      type: 'image',
      resource: { kind: 'image', resourceId: 'res-opaque-2', name: '   ' },
    },
    {
      id: 'file-candidate',
      type: 'file',
      resource: { kind: 'file', resourceId: 'res-opaque-3', name: '合同.pdf' },
    },
    {
      id: 'wb-original',
      type: 'whiteboard',
      resource: { kind: 'whiteboard', resourceId: 'res-opaque-4', name: '架构图' },
    },
    {
      id: 'base-unknown-status',
      type: 'bitable',
      resource: { kind: 'bitable', resourceId: 'res-opaque-5' },
    },
    {
      id: 'embed-fallback',
      type: 'fallback',
      resource: { kind: 'fallback', resourceId: 'res-opaque-6', name: '外链卡片' },
    },
    {
      id: 'assetless-image',
      type: 'image',
      resource: { kind: 'image', resourceId: 'res-opaque-7', name: '丢图' },
    },
    {
      id: 'named-unknown',
      type: 'embed',
      resource: { kind: 'video', resourceId: 'res-opaque-8', name: '视频' },
    },
  );

  for (let i = 0; i < duplicates; i += 1) {
    blocks.push({
      id: 'img-preview',
      type: 'image',
      resource: { kind: 'image', resourceId: 'res-opaque-1', name: '封面图' },
    });
  }

  return {
    kind: 'document',
    model: { blocks },
    issues,
    fidelity: { status: 'PARTIAL', complete: false, assets: 6, roundtrip: false },
  };
}

function makeAssets() {
  return [
    {
      sourceId: 'img-preview',
      kind: 'image',
      status: 'PREVIEW',
      byteLength: 2048,
      dataUrl: 'data:image/png;base64,AAAA',
    },
    // Duplicate asset record for the same source: first one must win.
    {
      sourceId: 'img-preview',
      kind: 'image',
      status: 'ORIGINAL',
      byteLength: 999999,
      dataUrl: 'data:image/png;base64,BBBB',
    },
    {
      sourceId: 'img-missing',
      kind: 'image',
      status: 'FAILED',
      code: 'RESOURCE_DOWNLOAD_FAILED',
      byteLength: 0,
      dataUrl: '',
    },
    {
      sourceId: 'file-candidate',
      kind: 'file',
      status: 'ORIGINAL_CANDIDATE',
      byteLength: 4096,
      dataUrl: 'data:application/pdf;base64,CCCC',
    },
    {
      sourceId: 'wb-original',
      kind: 'whiteboard',
      status: 'ORIGINAL',
      code: 'ORIGINAL_STORED',
      byteLength: 8192,
      dataUrl: 'data:image/svg+xml;base64,DDDD',
    },
    {
      sourceId: 'base-unknown-status',
      kind: 'bitable',
      status: 'SYNCED',
      byteLength: 512,
      dataUrl: 'data:application/json;base64,EEEE',
    },
    {
      sourceId: 'embed-fallback',
      kind: 'fallback',
      status: 'PREVIEW',
      byteLength: 256,
      dataUrl: 'data:text/html;base64,FFFF',
    },
    // No record for 'assetless-image' on purpose.
  ];
}

const content = {
  type: 'doc',
  content: [
    { type: 'heading', content: [{ type: 'text' }] },
    {
      type: 'table',
      content: [
        {
          type: 'table_row',
          content: [
            { type: 'table_cell', content: [{ type: 'paragraph' }] },
            {
              type: 'table_cell',
              content: [
                { type: 'paragraph', content: [{ type: 'image' }] },
                { type: 'image' },
              ],
            },
          ],
        },
      ],
    },
    {
      type: 'blockquote',
      content: [{ type: 'table', content: [{ type: 'table_cell' }] }],
    },
  ],
};

test('never declares full fidelity and reports raw block records', () => {
  const report = buildCaptureAudit(makeSnapshot(), makeAssets(), content);
  assert.equal(report.status, 'PENDING');
  assert.equal(report.capturedBlocks, 928);
  assert.ok(!JSON.stringify(report).includes('PASS'));
});

test('type tally is case insensitive and lexically sorted', () => {
  const report = buildCaptureAudit(makeSnapshot(), makeAssets(), content);
  assert.deepEqual(report.types[0], { type: 'bitable', count: 1 });
  assert.deepEqual(report.types.slice(-3), [
    { type: 'table', count: 1 },
    { type: 'table_cell', count: CELL_COUNT },
    { type: 'whiteboard', count: 1 },
  ]);
  const byType = Object.fromEntries(report.types.map((t) => [t.type, t.count]));
  assert.equal(byType.table_cell, CELL_COUNT);
  assert.equal(byType.heading, 1);
  assert.equal(byType.embed, 1);
  const sorted = [...report.types].sort((a, b) => (a.type < b.type ? -1 : 1));
  assert.deepEqual(report.types, sorted);
});

test('record counts are not confused with resource counts', () => {
  const report = buildCaptureAudit(makeSnapshot(), makeAssets(), content);
  assert.equal(report.counts.tables, 1);
  assert.equal(report.counts.tableCells, CELL_COUNT);
  assert.equal(report.counts.images, 3);
  assert.equal(report.counts.files, 1);
  assert.equal(report.counts.whiteboards, 1);
  assert.equal(report.counts.bases, 1);
  assert.equal(report.counts.otherEmbeds, 1);
});

test('renderer coverage counts nodes recursively', () => {
  const report = buildCaptureAudit(makeSnapshot(), makeAssets(), content);
  assert.equal(report.counts.editableTables, 2);
  assert.equal(report.counts.renderedImages, 2);
  assert.equal(buildCaptureAudit({}, [], null).counts.editableTables, 0);
  assert.equal(buildCaptureAudit({}, [], null).counts.renderedImages, 0);
});

test('object rows keep capture order, labels and small fields only', () => {
  const report = buildCaptureAudit(makeSnapshot(), makeAssets(), content);
  assert.deepEqual(
    report.objects.map((o) => o.sourceId),
    [
      'img-preview',
      'img-missing',
      'file-candidate',
      'wb-original',
      'base-unknown-status',
      'embed-fallback',
      'assetless-image',
    ],
  );
  assert.deepEqual(Object.keys(report.objects[0]), [
    'sourceId',
    'kind',
    'label',
    'status',
    'code',
    'byteLength',
  ]);
  assert.equal(report.objects[0].label, '封面图');
  // Blank name falls back to the Chinese label.
  assert.equal(report.objects[1].label, '图片');
  assert.equal(report.objects[4].label, '多维表格');
  assert.equal(report.objects[5].label, '外链卡片');

  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes('data:'));
  assert.ok(!serialized.includes('res-opaque-'));
  assert.ok(!serialized.includes('dataUrl'));
  assert.ok(!serialized.includes('resourceId'));
});

test('asset status mapping and byte accounting', () => {
  const report = buildCaptureAudit(makeSnapshot(), makeAssets(), content);
  const rows = Object.fromEntries(report.objects.map((o) => [o.sourceId, o]));

  assert.equal(rows['img-preview'].status, 'PREVIEW');
  assert.equal(rows['img-preview'].byteLength, 2048);
  assert.equal(rows['img-preview'].code, 'RESOURCE_VERIFICATION_PENDING');

  assert.equal(rows['file-candidate'].status, 'ORIGINAL_CANDIDATE');
  assert.equal(rows['file-candidate'].code, 'RESOURCE_VERIFICATION_PENDING');
  assert.equal(rows['file-candidate'].byteLength, 4096);

  assert.equal(rows['wb-original'].status, 'ORIGINAL');
  assert.equal(rows['wb-original'].code, 'ORIGINAL_STORED');
  assert.equal(rows['wb-original'].byteLength, 8192);

  // Unknown asset status with bytes is never trusted.
  assert.equal(rows['base-unknown-status'].status, 'UNVERIFIED');
  assert.equal(rows['base-unknown-status'].code, 'RESOURCE_VERIFICATION_PENDING');

  // Bytes present but dataUrl empty is treated as missing.
  assert.equal(rows['img-missing'].status, 'MISSING');
  assert.equal(rows['img-missing'].code, 'RESOURCE_DOWNLOAD_FAILED');
  assert.equal(rows['img-missing'].byteLength, 0);

  // No asset record at all.
  assert.equal(rows['assetless-image'].status, 'MISSING');
  assert.equal(rows['assetless-image'].code, 'RESOURCE_BYTES_MISSING');

  assert.equal(report.counts.resourcesWithBytes, 5);
  assert.equal(report.counts.previewResources, 2);
  assert.equal(report.counts.missingResources, 2);
});

test('gaps aggregate synthetic codes and sort lexically', () => {
  const report = buildCaptureAudit(makeSnapshot(), makeAssets(), content);
  const gaps = Object.fromEntries(report.gaps.map((g) => [g.code, g.count]));
  assert.equal(gaps.RESOURCE_PREVIEW_ONLY, 2);
  // candidate + unknown-status UNVERIFIED
  assert.equal(gaps.RESOURCE_VERIFICATION_PENDING, 4);
  assert.equal(gaps.ROUNDTRIP_VERIFICATION_PENDING, 1);
  assert.equal(gaps.RESOURCE_DOWNLOAD_FAILED, 1);
  assert.equal(gaps.RESOURCE_BYTES_MISSING, 1);
  const sorted = [...report.gaps].sort((a, b) => (a.code < b.code ? -1 : 1));
  assert.deepEqual(report.gaps, sorted);
  assert.ok(report.gaps.every((g) => g.count > 0));
});

test('ORIGINAL adds no synthetic gap but audit stays pending', () => {
  const snap = {
    kind: 'document',
    model: {
      blocks: [
        {
          id: 'only',
          type: 'image',
          resource: { kind: 'image', resourceId: 'r1', name: 'a' },
        },
      ],
    },
    issues: [],
  };
  const assets = [
    {
      sourceId: 'only',
      status: 'ORIGINAL',
      code: 'ORIGINAL_STORED',
      byteLength: 10,
      dataUrl: 'data:image/png;base64,AA',
    },
  ];
  const report = buildCaptureAudit(snap, assets, null);
  const gaps = Object.fromEntries(report.gaps.map((g) => [g.code, g.count]));
  assert.deepEqual(Object.keys(gaps).sort(), ['ORIGINAL_STORED', 'ROUNDTRIP_VERIFICATION_PENDING']);
  assert.equal(gaps.ROUNDTRIP_VERIFICATION_PENDING, 1);
  assert.equal(report.status, 'PENDING');
  assert.equal(report.counts.resourcesWithBytes, 1);
});

test('duplicate block records count raw but dedupe objects', () => {
  const report = buildCaptureAudit(makeSnapshot({ duplicates: 2 }), makeAssets(), content);
  assert.equal(report.capturedBlocks, 930);
  assert.equal(report.types.find((t) => t.type === 'image').count, 5);
  assert.equal(report.objects.length, 7);
  assert.equal(report.counts.images, 3);
  const gaps = Object.fromEntries(report.gaps.map((g) => [g.code, g.count]));
  assert.equal(gaps.DUPLICATE_BLOCK_ID, 2);
});

test('snapshot issues aggregate without double counting object codes', () => {
  const issues = [
    { code: 'RESOURCE_DOWNLOAD_FAILED', count: 3 },
    { code: 'RESOURCE_DOWNLOAD_FAILED' },
    { code: 'DOC_TRIMMED', count: 0 },
    { code: 'DOC_TRIMMED', count: -5 },
    { code: '', count: 4 },
    { code: 'ROUNDTRIP_VERIFICATION_PENDING', count: 2 },
    null,
  ];
  const report = buildCaptureAudit(makeSnapshot({ issues }), makeAssets(), content);
  const gaps = Object.fromEntries(report.gaps.map((g) => [g.code, g.count]));
  // Four aggregate snapshot issues plus the independently missing object.
  assert.equal(gaps.RESOURCE_DOWNLOAD_FAILED, 5);
  // Explicit invalid counts are ignored.
  assert.ok(!('DOC_TRIMMED' in gaps));
  // synthetic roundtrip gap is already present from the snapshot
  assert.equal(gaps.ROUNDTRIP_VERIFICATION_PENDING, 2);
  assert.ok(!('' in gaps));
});

test('explicit snapshot issue for the same source and code is not doubled', () => {
  const snap = {
    model: {
      blocks: [
        { id: 's1', type: 'image', resource: { kind: 'image', name: 'x' } },
        { id: 's2', type: 'image', resource: { kind: 'image', name: 'y' } },
      ],
    },
    issues: [{ code: 'RESOURCE_BYTES_MISSING', sourceId: 's1' }],
  };
  const report = buildCaptureAudit(snap, [], null);
  const gaps = Object.fromEntries(report.gaps.map((g) => [g.code, g.count]));
  assert.equal(gaps.RESOURCE_BYTES_MISSING, 2);
  assert.equal(report.counts.missingResources, 2);
});

test('synthetic codes named like explicit codes do not inflate gaps', () => {
  const snap = {
    model: {
      blocks: [
        {
          id: 'a',
          type: 'image',
          resource: { kind: 'image', name: 'a' },
        },
      ],
    },
    issues: [],
  };
  const assets = [
    {
      sourceId: 'a',
      status: 'ORIGINAL',
      code: 'ROUNDTRIP_VERIFICATION_PENDING',
      byteLength: 4,
      dataUrl: 'data:image/png;base64,AA',
    },
  ];
  const report = buildCaptureAudit(snap, assets, null);
  const gaps = Object.fromEntries(report.gaps.map((g) => [g.code, g.count]));
  assert.deepEqual(gaps, { ROUNDTRIP_VERIFICATION_PENDING: 1 });
});

test('input is never mutated', () => {
  const snap = makeSnapshot({
    duplicates: 1,
    issues: [{ code: 'DOC_TRIMMED', count: 2 }],
  });
  const assets = makeAssets();
  const frozenSnap = structuredClone(snap);
  const frozenAssets = structuredClone(assets);
  const frozenContent = structuredClone(content);

  const report = buildCaptureAudit(snap, assets, content);
  assert.deepEqual(snap, frozenSnap);
  assert.deepEqual(assets, frozenAssets);
  assert.deepEqual(content, frozenContent);
  assert.equal(report.capturedBlocks, 929);
});

test('degenerate inputs produce a safe pending report', () => {
  const report = buildCaptureAudit(undefined, undefined, undefined);
  assert.equal(report.status, 'PENDING');
  assert.equal(report.capturedBlocks, 0);
  assert.deepEqual(report.types, []);
  assert.deepEqual(report.objects, []);
  assert.deepEqual(report.gaps, [{ code: 'ROUNDTRIP_VERIFICATION_PENDING', count: 1 }]);
  assert.deepEqual(report.counts, {
    tables: 0,
    tableCells: 0,
    images: 0,
    files: 0,
    whiteboards: 0,
    bases: 0,
    otherEmbeds: 0,
    editableTables: 0,
    renderedImages: 0,
    resourcesWithBytes: 0,
    previewResources: 0,
    missingResources: 0,
    structuredWhiteboards: 0,
    structuredBases: 0,
  });
  assert.equal(JSON.parse(JSON.stringify(report)).status, 'PENDING');
});
test('native drawing data is counted separately from image bytes and editable support',()=>{
 const snap={model:{blocks:[{id:'board',type:'whiteboard'}]},issues:[]};
 const drawing={sourceId:'board',status:'STRUCTURE_CANDIDATE',code:'WHITEBOARD_EDITOR_PENDING',payload:{nodes:[{id:'node'}]},byteLength:42,resourceCount:1};
 const r=buildCaptureAudit(snap,[],null,[drawing]);
 assert.equal(r.counts.structuredWhiteboards,1);assert.equal(r.counts.resourcesWithBytes,0);
 assert.equal(r.objects[0].status,'STRUCTURE_CANDIDATE');assert.equal(r.status,'PENDING');
 assert.ok(r.gaps.some(x=>x.code==='WHITEBOARD_RESOURCE_BYTES_PENDING'));
 assert.ok(!JSON.stringify(r).includes('"nodes"'));
});

// Planner coverage for faults on ordinary blocks and native iframe fallback.
test('duplicate ordinary records and iframe embeds remain explicit',()=>{
 const report=buildCaptureAudit({model:{blocks:[{id:'p',type:'text'},{id:'p',type:'text'},{id:'i',type:'iframe'}]},issues:[]});
 assert.equal(report.capturedBlocks,3);
 assert.equal(report.counts.otherEmbeds,1);
 assert.deepEqual(report.objects.map(x=>x.kind),['fallback']);
 assert.equal(report.gaps.find(x=>x.code==='DUPLICATE_BLOCK_ID').count,1);
});
test('explicit preview code is counted once and existing verification issues are retained',()=>{
 const snapshot={model:{blocks:[{id:'img',type:'image'}]},issues:[{code:'ROUNDTRIP_VERIFICATION_PENDING',count:2},{code:'RESOURCE_PREVIEW_ONLY',sourceId:'img'}]};
 const report=buildCaptureAudit(snapshot,[{sourceId:'img',status:'PREVIEW',code:'RESOURCE_PREVIEW_ONLY',byteLength:10,dataUrl:'data:image/png;base64,AA'}]);
 assert.equal(report.gaps.find(x=>x.code==='RESOURCE_PREVIEW_ONLY').count,1);
 assert.equal(report.gaps.find(x=>x.code==='ROUNDTRIP_VERIFICATION_PENDING').count,2);
});

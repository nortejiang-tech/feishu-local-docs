import test from 'node:test';
import assert from 'node:assert/strict';

import { buildWhiteboardScene } from '../shared/whiteboard-scene.mjs';

/** Minimal native-shaped fixture builder (kept tiny on purpose). */
function node(id, base = {}, extra = {}) {
  return {
    id,
    info: {
      baseV2: { x: 0, y: 0, width: 10, height: 10, angle: 0, ...base },
      ...extra,
    },
    children: [],
  };
}

function imageNode(id, base = {}, key = `res-${id}`) {
  return node(id, base, {
    fillV2: { fillStyleList: { data: [{ active: true, imageFillItem: { resource: { key } } }] } },
  });
}

function sceneOf(...nodes) {
  return buildWhiteboardScene({
    format: 'feishu-whiteboard-page-detail',
    nodes,
    meta: { page: 'p1' },
  });
}

function itemById(scene, id) {
  const found = scene.items.filter((i) => i.id === id);
  assert.equal(found.length, 1, `expected exactly one item ${id}`);
  return found[0];
}

test('two-image scene with negative coordinates projects geometry, bounds and kinds', () => {
  const scene = sceneOf(
    imageNode('a', { x: -120.5, y: -40, width: 60, height: 30 }),
    imageNode('b', { x: 10, y: 5, width: 200, height: 80 }),
  );

  assert.deepEqual(
    scene.items.map((i) => [i.id, i.kind, i.resourceId]),
    [
      ['a', 'image', 'res-a'],
      ['b', 'image', 'res-b'],
    ],
  );
  assert.deepEqual(scene.bounds, { x: -120.5, y: -40, width: 330.5, height: 125 });
  assert.equal(scene.unsupportedCount, 0);
  assert.equal(scene.omittedCount, 0);
  assert.deepEqual(itemById(scene, 'a'), {
    id: 'a',
    x: -120.5,
    y: -40,
    width: 60,
    height: 30,
    angle: 0,
    text: '',
    resourceId: 'res-a',
    kind: 'image',
  });
});

test('text nodes project text; unknown nodes are unsupported but still rendered', () => {
  const scene = sceneOf(
    node('t', { x: 1, y: 2, width: 4, height: 5 }, { textV2: { text: 'hello' } }),
    node('u', { x: 3, y: 3, width: 2, height: 2 }),
  );

  assert.equal(itemById(scene, 't').kind, 'text');
  assert.equal(itemById(scene, 't').text, 'hello');
  assert.equal(itemById(scene, 't').resourceId, '');
  assert.equal(itemById(scene, 'u').kind, 'unknown');
  // unknown kinds are unsupported (angle is 0 here, so this counts kind only)
  assert.equal(scene.unsupportedCount, 1);
  assert.equal(scene.omittedCount, 0);
});

test('nonzero angle keeps native value but counts as unsupported (units unverified)', () => {
  const scene = sceneOf(imageNode('rot', { angle: 1.57 }));
  assert.equal(itemById(scene, 'rot').angle, 1.57);
  assert.equal(scene.unsupportedCount, 1);
});

test('missing angle defaults to zero and is not unsupported', () => {
  const base = { x: 0, y: 0, width: 5, height: 5 };
  const scene = sceneOf({ id: 'no-angle', info: { baseV2: base, textV2: { text: 'x' } }, children: [] });
  assert.equal(itemById(scene, 'no-angle').angle, 0);
  assert.equal(scene.unsupportedCount, 0);
});

test('malformed geometry omits the bad node but keeps its valid siblings', () => {
  const scene = sceneOf(
    imageNode('nan', { x: Number.NaN }),
    imageNode('zero-w', { width: 0 }),
    imageNode('neg-h', { height: -3 }),
    imageNode('huge', { x: 1000001 }),
    imageNode('bad-angle', { angle: 'pi' }),
    imageNode('ok', { x: 0, y: 0, width: 1, height: 1 }),
  );

  assert.deepEqual(scene.items.map((i) => i.id), ['ok']);
  assert.equal(scene.omittedCount, 5);
  assert.deepEqual(scene.bounds, { x: 0, y: 0, width: 1, height: 1 });
});

test('boundary values at exactly 1,000,000 are accepted', () => {
  const scene = sceneOf(imageNode('edge', { x: -1000000, width: 1000000, angle: 1000000 }));
  assert.equal(scene.items.length, 1);
  assert.equal(scene.omittedCount, 0);
});

test('missing id, missing info/base are omitted', () => {
  const scene = sceneOf(
    { info: { baseV2: { x: 0, y: 0, width: 1, height: 1, angle: 0 } }, children: [] },
    { id: 'no-info', children: [] },
    { id: 'no-base', info: {}, children: [] },
    imageNode('good'),
  );
  assert.deepEqual(scene.items.map((i) => i.id), ['good']);
  assert.equal(scene.omittedCount, 3);
});

test('duplicate ids are omitted once per repeat', () => {
  const scene = sceneOf(imageNode('dup'), imageNode('dup'), imageNode('other'));
  assert.deepEqual(scene.items.map((i) => i.id), ['dup', 'other']);
  assert.equal(scene.omittedCount, 1);
});

test('object cycles are broken and counted as omissions', () => {
  const parent = node('p', { x: 0, y: 0, width: 10, height: 10 });
  const child = node('c', { x: 1, y: 1, width: 2, height: 2 });
  parent.children.push(child);
  child.children.push(parent); // cycle back to an already-visited object

  const scene = sceneOf(parent);
  assert.deepEqual(scene.items.map((i) => i.id), ['p', 'c']);
  assert.equal(scene.omittedCount, 1);
});

test('string children references never recurse and never crash', () => {
  const scene = sceneOf(node('p', {}, { textV2: { text: 'root' } }), 'ref-1', 42, null);
  assert.deepEqual(scene.items.map((i) => i.id), ['p']);
  // non-object root entries are omitted; string refs are not traversed
  assert.equal(scene.omittedCount, 3);
});

test('nested children are traversed and contribute to bounds', () => {
  const child = imageNode('child', { x: 50, y: 50, width: 25, height: 25 });
  const mid = node('mid', { x: 10, y: 10, width: 10, height: 10 });
  mid.children.push(child);
  const scene = sceneOf(mid);
  assert.deepEqual(scene.items.map((i) => i.id), ['mid', 'child']);
  assert.deepEqual(scene.bounds, { x: 10, y: 10, width: 65, height: 65 });
});

test('over-depth nodes are refused and counted', () => {
  const root = node('root', { x: 0, y: 0, width: 1, height: 1 });
  let cursor = root;
  for (let i = 0; i < 50; i += 1) {
    const next = node(`n${i}`, { x: i, y: i, width: 1, height: 1 });
    cursor.children.push(next);
    cursor = next;
  }
  const scene = sceneOf(root);
  // Chain: root at depth 1, descendants n0..n49 at depth 2..51.
  // MAX_DEPTH=48 admits 48 items at depths1..48. The depth49 subtree is
  // refused as one branch; its descendants are never traversed.
  assert.deepEqual(
    scene.items.map((i) => i.id),
    ['root', ...Array.from({ length: 47 }, (_, k) => `n${k}`)],
  );
  assert.equal(scene.omittedCount, 1);
  assert.ok(!scene.items.some((i) => i.id !== 'root' && Number(i.id.slice(1)) >= 48));
});
test('an image may also carry text; oversized image text is not silently discarded',()=>{
 const image=imageNode('image');image.info.textV2={text:'caption'};
 assert.equal(sceneOf(image).items[0].text,'caption');
 image.info.textV2.text='x'.repeat(100001);assert.equal(sceneOf(image).omittedCount,1);
});
test('invalid containers keep valid child objects and ignore string references',()=>{
 const container={id:'bad',info:{},children:[imageNode('child'),'child']};
 const scene=sceneOf(container);assert.deepEqual(scene.items.map(item=>item.id),['child']);assert.equal(scene.omittedCount,1);
});

test('visited budget stops traversal without throwing', () => {
  const nodes = [];
  for (let i = 0; i < 20003; i += 1) nodes.push(imageNode(`b${i}`, { x: i, y: 0 }));
  const scene = buildWhiteboardScene({ format: 'feishu-whiteboard-page-detail', nodes, meta: {} });
  assert.equal(scene.items.length, 20000);
  assert.equal(scene.omittedCount, 3);
});

test('over-long text refuses the node instead of truncating', () => {
  const scene = sceneOf(
    node('long', {}, { textV2: { text: 'x'.repeat(100001) } }),
    node('ok', {}, { textV2: { text: 'x'.repeat(100000) } }),
  );
  assert.deepEqual(scene.items.map((i) => i.id), ['ok']);
  assert.equal(scene.omittedCount, 1);
  assert.equal(scene.items[0].text.length, 100000);
});

test('empty input yields the empty scene bounds', () => {
  for (const payload of [
    { format: 'feishu-whiteboard-page-detail', nodes: [], meta: {} },
    { format: 'feishu-whiteboard-page-detail', nodes: 'nope', meta: {} },
    null,
    undefined,
    'nonsense',
  ]) {
    const scene = buildWhiteboardScene(payload);
    assert.deepEqual(scene, {
      items: [],
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      unsupportedCount: 0,
      omittedCount: 0,
    });
  }
});

test('bounds clamp degenerate spans to at least 1', () => {
  const scene = sceneOf(imageNode('a', { x: 5, y: 5, width: 1, height: 1 }));
  assert.deepEqual(scene.bounds, { x: 5, y: 5, width: 1, height: 1 });
});

test('input is not mutated and no extra metadata is projected', () => {
  const payload = {
    format: 'feishu-whiteboard-page-detail',
    nodes: [
      imageNode('a', { x: -1, y: 2, width: 3, height: 4 }, 'key-a'),
      node('b', { x: 0, y: 0, width: 1, height: 1, angle: 9 }, {
        textV2: { text: 'hi' },
        secretMetadata: { token: 'do-not-project' },
      }),
    ],
    meta: { page: 'p1', owner: 'someone' },
  };
  const before = JSON.parse(JSON.stringify(payload));

  const scene = buildWhiteboardScene(payload);

  assert.deepEqual(JSON.parse(JSON.stringify(payload)), before);
  const allowedKeys = ['id', 'x', 'y', 'width', 'height', 'angle', 'text', 'resourceId', 'kind'];
  for (const item of scene.items) {
    assert.deepEqual(Object.keys(item).sort(), [...allowedKeys].sort());
    const json = JSON.stringify(item);
    assert.ok(!json.includes('do-not-project'));
    assert.ok(!json.includes('secretMetadata'));
    assert.ok(!json.includes('http'));
  }
  assert.deepEqual(Object.keys(scene).sort(), ['bounds', 'items', 'omittedCount', 'unsupportedCount']);
  assert.deepEqual(Object.keys(scene.bounds).sort(), ['height', 'width', 'x', 'y']);
});

test('inactive image fill falls back to text/unknown kind', () => {
  const scene = sceneOf({
    id: 'inactive',
    info: {
      baseV2: { x: 0, y: 0, width: 1, height: 1, angle: 0 },
      fillV2: {
        fillStyleList: {
          data: [
            { active: false, imageFillItem: { resource: { key: 'ignored' } } },
            { active: true, imageFillItem: { resource: { key: 123 } } },
          ],
        },
      },
      textV2: { text: 'fallback' },
    },
    children: [],
  });
  const item = itemById(scene, 'inactive');
  assert.equal(item.kind, 'text');
  assert.equal(item.resourceId, '');
  assert.equal(item.text, 'fallback');
  assert.equal(scene.unsupportedCount, 0);
});

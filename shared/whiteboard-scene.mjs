// Pure geometry projection for a partial whiteboard renderer.
//
// This module is NOT a security validator and NOT a fidelity verdict. It takes a
// native page-detail payload (already validated/preserved elsewhere by the caller)
// and projects a best-effort list of renderable items plus diagnostics.
//
// No IO, no DOM, no dependencies, no dynamic evaluation, no mutation of input.

const MAX_VISITED_NODES = 20000;
const MAX_DEPTH = 48;
const MAX_ABS_VALUE = 1000000;
const MAX_TEXT_LENGTH = 100000;

const EMPTY_BOUNDS = Object.freeze({ x: 0, y: 0, width: 1, height: 1 });

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Classify one node against the geometry contract.
 *
 * Returns { ok: false } when the node must be omitted, otherwise the projected
 * fields plus the kind that drives unsupported accounting.
 */
function classifyNode(node) {
  const info = isPlainObject(node) ? node.info : null;
  const base = isPlainObject(info) ? info.baseV2 : null;
  if (!base) return { ok: false };

  const x = base.x;
  const y = base.y;
  const width = base.width;
  const height = base.height;
  // angle defaults to 0 when absent; a present-but-invalid angle is not silently 0.
  const angle = base.angle === undefined ? 0 : base.angle;

  if (!finiteNumber(x) || !finiteNumber(y)) return { ok: false };
  if (!finiteNumber(width) || !finiteNumber(height)) return { ok: false };
  if (!finiteNumber(angle)) return { ok: false };
  if (!(width > 0) || !(height > 0)) return { ok: false };
  if (
    Math.abs(x) > MAX_ABS_VALUE ||
    Math.abs(y) > MAX_ABS_VALUE ||
    Math.abs(width) > MAX_ABS_VALUE ||
    Math.abs(height) > MAX_ABS_VALUE ||
    Math.abs(angle) > MAX_ABS_VALUE
  ) {
    return { ok: false };
  }

  const kind = resolveKind(info);
  if (kind.text.length > MAX_TEXT_LENGTH) {
    // Over-long text refuses the whole node rather than truncating silently.
    return { ok: false };
  }

  return { ok: true, x, y, width, height, angle, kind };
}

function firstActiveImageFill(info) {
  const fill = isPlainObject(info) ? info.fillV2 : null;
  const list = isPlainObject(fill) ? fill.fillStyleList : null;
  const data = isPlainObject(list) && Array.isArray(list.data) ? list.data : null;
  if (!data) return null;
  for (const entry of data) {
    if (!isPlainObject(entry) || entry.active !== true) continue;
    const item = isPlainObject(entry.imageFillItem) ? entry.imageFillItem : null;
    const resource = isPlainObject(item) ? item.resource : null;
    const key = resource ? resource.key : null;
    if (typeof key === 'string' && key.length > 0) return key;
  }
  return null;
}

function resolveKind(info) {
  const text=typeof info?.textV2?.text==='string'?info.textV2.text:'';
  const resourceId = firstActiveImageFill(info);
  if (resourceId !== null) return { name: 'image', resourceId, text };
  if (typeof text === 'string' && text.length > 0) return { name: 'text', text };
  return { name: 'unknown', resourceId: '', text:'' };
}

function emptyScene() {
  return { items: [], bounds: { ...EMPTY_BOUNDS }, unsupportedCount: 0, omittedCount: 0 };
}

/**
 * Build a renderable scene projection from a native whiteboard page payload.
 *
 * Traversal is iterative (explicit stack, never recursion) and bounded by
 * MAX_VISITED_NODES / MAX_DEPTH. Cycles are detected with a WeakSet; repeated
 * object visits, duplicate ids, invalid geometry, over-depth and over-budget
 * nodes are counted in omittedCount but never abort sibling rendering.
 */
export function buildWhiteboardScene(payload) {
  if (!isPlainObject(payload)) return emptyScene();

  const roots = Array.isArray(payload.nodes) ? payload.nodes : null;
  if (!roots) return emptyScene();

  const items = [];
  const seenObjects = new WeakSet();
  const seenIds = new Set();
  let visited = 0;
  let omittedCount = 0;
  let unsupportedCount = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const stack = [{ node: roots, depth: 0 }];

  while (stack.length > 0) {
    const frame = stack.pop();
    const node = frame.node;

    // The root frame carries the array itself; expand it without budget cost.
    if (Array.isArray(node)) {
      if (frame.depth > 0) {
        omittedCount += 1;
        continue;
      }
      for (let i = node.length - 1; i >= 0; i -= 1) {
        stack.push({ node: node[i], depth: 1 });
      }
      continue;
    }

    if (!isPlainObject(node)) {
      // String references (and other non-object entries) never recurse.
      omittedCount += 1;
      continue;
    }

    if (frame.depth > MAX_DEPTH) {
      omittedCount += 1;
      continue;
    }

    if (visited >= MAX_VISITED_NODES) {
      omittedCount += 1;
      continue;
    }
    visited += 1;

    if (seenObjects.has(node)) {
      // Cycle or repeated object reference.
      omittedCount += 1;
      continue;
    }
    seenObjects.add(node);
    // A malformed container must not suppress its valid child objects.
    if(Array.isArray(node.children))for(let i=node.children.length-1;i>=0;i--)if(isPlainObject(node.children[i]))stack.push({node:node.children[i],depth:frame.depth+1});

    const id = typeof node.id === 'string' && node.id.length > 0 ? node.id : null;
    if (id === null) {
      omittedCount += 1;
      continue;
    }
    if (seenIds.has(id)) {
      omittedCount += 1;
      continue;
    }

    const projected = classifyNode(node);
    if (!projected.ok) {
      // Reserve the id so a later duplicate of an omitted node is also omitted
      // exactly once per occurrence below.
      seenIds.add(id);
      omittedCount += 1;
      continue;
    }

    seenIds.add(id);

    const kind = projected.kind.name;
    if (kind === 'unknown' || projected.angle !== 0) {
      // Angle units and shape rendering are unverified: count, do not interpret.
      unsupportedCount += 1;
    }

    items.push({
      id,
      x: projected.x,
      y: projected.y,
      width: projected.width,
      height: projected.height,
      angle: projected.angle,
      text: projected.kind.text,
      resourceId: kind === 'image' ? projected.kind.resourceId : '',

      kind,
    });

    minX = Math.min(minX, projected.x);
    minY = Math.min(minY, projected.y);
    maxX = Math.max(maxX, projected.x + projected.width);
    maxY = Math.max(maxY, projected.y + projected.height);

  }

  const bounds =
    items.length === 0
      ? { ...EMPTY_BOUNDS }
      : {
          x: minX,
          y: minY,
          width: Math.max(maxX - minX, 1),
          height: Math.max(maxY - minY, 1),
        };

  return { items, bounds, unsupportedCount, omittedCount };
}

export default buildWhiteboardScene;

/**
 * Pure document tree / list / column assembly.
 *
 * No I/O, no DOM, no imports, no dynamic code evaluation.
 *
 * Input block shape:
 *   { id:string, type:string, parentId:string|null, children:string[], text:string, properties:object }
 *
 * renderLeaf(block) -> { nodes: TiptapNode[], consumed?: string[] }
 *   - `nodes` are already-validated converted own content supplied by the caller.
 *   - `consumed` lists descendant ids owned by a compound object (e.g. table cells).
 *
 * assembleDocumentTree(blocks, rootIds, renderLeaf) -> { nodes, issues: string[] }
 */

const MAX_BLOCKS = 20000;
const MAX_DEPTH = 64;

const INVALID = 'DOCUMENT_TREE_INVALID';

const TRANSPARENT_TYPES = new Set(['page', 'root', 'document', 'view']);
const BULLET_TYPES = new Set(['bullet', 'bullet_list_item', 'bulletitem', 'list_item_bullet', 'bullet-list-item']);
const ORDERED_TYPES = new Set(['ordered', 'ordered_list_item', 'orderedlistitem', 'list_item_ordered', 'ordered-list-item']);
const TODO_TYPES = new Set(['todo', 'task', 'task_item', 'taskitem', 'todo_item', 'todoitem', 'task-item', 'todo-item']);
const GRID_TYPES = new Set(['grid']);
const COLUMN_TYPES = new Set(['grid_column', 'gridcolumn', 'grid-column']);

function fail() {
  throw new Error(INVALID);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function hasText(block) {
  return typeof block.text === 'string' && block.text.length > 0;
}

function normalizeType(type) {
  if (typeof type !== 'string') fail();
  return type.trim().toLowerCase();
}

function paragraph() {
  return { type: 'paragraph' };
}

function childrenOf(block) {
  if (block.children === undefined || block.children === null) return [];
  if (!Array.isArray(block.children)) fail();
  return block.children;
}

function propertiesOf(block) {
  if (block.properties === undefined || block.properties === null) return {};
  if (!isPlainObject(block.properties)) fail();
  return block.properties;
}

/**
 * Normalise the block collection into an ordered array plus an id -> block map.
 * Enforces block count, id shape and id uniqueness.
 */
function indexBlocks(blocks) {
  if (!Array.isArray(blocks)) fail();
  if (blocks.length > MAX_BLOCKS) fail();

  const order = [];
  const map = new Map();

  for (const raw of blocks) {
    if (!isPlainObject(raw)) fail();
    if (!isNonEmptyString(raw.id)) fail();
    if (map.has(raw.id)) fail();
    map.set(raw.id, raw);
    order.push(raw.id);
  }

  return { order, map };
}

/**
 * Validate the child reference graph: every reference known, no child shared
 * between two parents, no child listed twice, no cycles.
 */
function validateGraph(map, order) {
  const parentOf = new Map();

  for (const id of order) {
    const block = map.get(id);
    for (const childId of childrenOf(block)) {
      if (!isNonEmptyString(childId)) fail();
      if (!map.has(childId)) fail();
      if (childId === id) fail();
      if (parentOf.has(childId)) fail();
      parentOf.set(childId, id);
    }
  }

  // One linear walk over parent links also bounds the captured hierarchy.
  const depths=new Map();
  for(const start of order) {
    if(depths.has(start))continue;
    const path=[],active=new Set();let current=start;
    while(current!==undefined && !depths.has(current)) {
      if(active.has(current))fail();
      active.add(current);path.push(current);
      if(path.length>MAX_DEPTH)fail();
      current=parentOf.get(current);
    }
    let depth=current===undefined?0:depths.get(current);
    for(let i=path.length-1;i>=0;i--) {if(++depth>MAX_DEPTH)fail();depths.set(path[i],depth);}
  }

  return parentOf;
}

function emptyCallbackResult(result) {
  if (result === undefined || result === null) return { nodes: [], consumed: [] };
  if (!isPlainObject(result)) fail();
  const nodes = result.nodes === undefined || result.nodes === null ? [] : result.nodes;
  const consumed = result.consumed === undefined || result.consumed === null ? [] : result.consumed;
  if (!Array.isArray(nodes) || !Array.isArray(consumed)) fail();
  return { nodes, consumed };
}

/**
 * Call renderLeaf and immediately snapshot its result, without changing the
 * callback result, so later edits cannot change what we already recorded.
 */
function invokeLeaf(block, ctx) {
  const result = ctx.renderLeaf(block);
  const snapshot = emptyCallbackResult(result);
  const consumed = snapshot.consumed;
  for (const id of consumed) {
    if (!isNonEmptyString(id)) fail();
    if (!ctx.map.has(id)) fail();
    ctx.consumed.add(id);
  }
  const nodes = snapshot.nodes.map((node) => structuredClone(node));
  return nodes;
}

/**
 * Convert a single block into zero or more nodes.
 */
function convertBlock(block, depth, ctx) {
  if (depth > MAX_DEPTH) fail();
  if (ctx.visited.has(block.id)) return [];
  ctx.visited.add(block.id);

  const type = normalizeType(block.type);
  const children = childrenOf(block);

  if (COLUMN_TYPES.has(type)) {
    ctx.visited.delete(block.id);
    ctx.issues.push('DOCUMENT_COLUMN_ORPHAN_INCLUDED');
    return columnLayout([convertColumn(block,depth,ctx,1)]);
  }
  if (GRID_TYPES.has(type)) {
    return convertGrid(children, depth, ctx);
  }

  if (TRANSPARENT_TYPES.has(type)) {
    const out = hasText(block) ? invokeLeaf(block, ctx) : [];
    return out.concat(convertChildren(children, depth + 1, ctx));
  }

  // Leaf-ish block: own converted content first, then converted children.
  // List grouping happens at the sibling level (convertChildren), never here.
  const own = invokeLeaf(block, ctx);
  return own.concat(convertChildren(children, depth + 1, ctx));
}

/**
 * Convert a batch of sibling blocks (same level) so that adjacent list-item
 * siblings group into one list container.
 */
function convertSiblings(siblingBlocks, depth, ctx) {
  const entries = [];
  for (const block of siblingBlocks) {
    if (ctx.consumed.has(block.id)) continue;
    if (ctx.visited.has(block.id)) continue;
    entries.push({ id: block.id, block, type: normalizeType(block.type) });
  }
  return assembleEntries(entries, depth, ctx);
}

/**
 * Resolve child ids to sibling entries, skipping consumed/visited ones, then
 * assemble them (which handles adjacent list grouping).
 */
function convertChildren(childIds, depth, ctx) {
  const entries = [];
  for (const childId of childIds) {
    if (ctx.consumed.has(childId)) continue;
    if (ctx.visited.has(childId)) continue;
    const child = ctx.map.get(childId);
    if (!child) fail();
    entries.push({ id: childId, block: child, type: normalizeType(child.type) });
  }
  return assembleEntries(entries, depth, ctx);
}

/**
 * Given an ordered list of sibling entries, group adjacent list-item siblings of
 * the same kind into one list container; anything else interrupts the group.
 */
function assembleEntries(entries, depth, ctx) {
  const out = [];
  let i = 0;
  while (i < entries.length) {
    const entry = entries[i];
    if(ctx.consumed.has(entry.id)||ctx.visited.has(entry.id)){i++;continue;}
    const kind = listKind(entry.type);
    if (kind !== null) {
      const group = [];
      while (i < entries.length && listKind(entries[i].type) === kind) {
        group.push(entries[i]);
        i += 1;
      }
      out.push(buildList(kind, group, depth, ctx));
      continue;
    }
    out.push(...convertBlock(entry.block, depth, ctx));
    i += 1;
  }
  return out;
}

function listKind(type) {
  if (BULLET_TYPES.has(type)) return 'bullet';
  if (ORDERED_TYPES.has(type)) return 'ordered';
  if (TODO_TYPES.has(type)) return 'todo';
  return null;
}

function buildList(listType, group, depth, ctx) {
  const containerType =
    listType === 'bullet' ? 'bulletList' : listType === 'ordered' ? 'orderedList' : 'taskList';

  const container = { type: containerType };
  if (listType === 'ordered') container.attrs = { start: 1 };
  container.content = group.map((entry) => buildListItem(listType, entry, depth, ctx));
  return container;
}

function buildListItem(listType, entry, depth, ctx) {
  if(depth>MAX_DEPTH)fail();
  const block = entry.block;
  // Register the item here so it is never re-emitted at top level.
  ctx.visited.add(block.id);

  const own = hasText(block) ? invokeLeaf(block, ctx) : [];
  const inner = convertChildren(childrenOf(block), depth + 1, ctx);

  const content = own.concat(inner);
  if (content.length === 0 || content[0].type!=='paragraph') content.unshift(paragraph());

  if (listType === 'todo') {
    return {
      type: 'taskItem',
      attrs: { checked: propertiesOf(block).checked === true },
      content,
    };
  }
  return { type: 'listItem', content };
}

function convertGrid(childIds, depth, ctx) {
  const columns = [];
  for (const childId of childIds) {
    if (ctx.consumed.has(childId)) continue;
    const child = ctx.map.get(childId);
    if (!child) fail();
    if (!COLUMN_TYPES.has(normalizeType(child.type))) fail();
    columns.push(child);
  }

  if (columns.length === 0) {
    ctx.issues.push('DOCUMENT_GRID_EMPTY');
    return [paragraph()];
  }

  return columnLayout(columns.map((column) => convertColumn(column, depth + 1, ctx, 1/columns.length)));
}

function convertColumn(column, depth, ctx, defaultRatio=1) {
  if(depth>MAX_DEPTH)fail();
  if (ctx.visited.has(column.id)) fail();
  ctx.visited.add(column.id);

  let ratio = propertiesOf(column).width_ratio;
  if (ratio !== undefined && ratio !== null) {
    if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0 || ratio > 1) fail();
  } else {
    ratio = defaultRatio;
  }

  const content = convertChildren(childrenOf(column), depth + 1, ctx);
  if (content.length === 0) content.push(paragraph());

  return { type: 'column', attrs: { widthRatio: ratio }, content };
}

/** Wrap a bare column batch in the columnLayout container. */
function columnLayout(columns) {
  return [{ type: 'columnLayout', content: columns }];
}

/**
 * Top-level id sequence: explicit rootIds first, then every block that is not
 * somebody's child, in original input order.
 */
function topLevelIds(ctx, rootIds) {
  const ids = [];
  const seen = new Set();

  if (rootIds !== undefined && rootIds !== null) {
    if (!Array.isArray(rootIds)) fail();
    for (const id of rootIds) {
      if (!isNonEmptyString(id)) fail();
      if (!ctx.map.has(id)) fail();
      if (seen.has(id)) fail();
      seen.add(id);
      ids.push(id);
    }
  }

  if(rootIds!==undefined && rootIds!==null)return ids;
  for (const id of ctx.order) {
    if (seen.has(id)) continue;
    if (ctx.parentOf.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  return ids;
}

/**
 * Assemble captured blocks into a document tree.
 *
 * Throws Error('DOCUMENT_TREE_INVALID') for an inconsistent tree, except that
 * unreferenced orphan records are appended (in original input order) with the
 * issue DOCUMENT_ORPHAN_INCLUDED.
 */
function assembleDocumentTree(blocks, rootIds, renderLeaf) {
  if (typeof renderLeaf !== 'function') fail();

  const { order, map } = indexBlocks(blocks);
  const parentOf = validateGraph(map, order);

  const ctx = {
    order,
    map,
    parentOf,
    visited: new Set(),
    consumed: new Set(),
    issues: [],
    renderLeaf,
  };

  // Roots are siblings: they must be grouped as one batch so adjacent list
  // blocks at the top level collapse into a single list container.
  const rootBatch = topLevelIds(ctx, rootIds).map((id) => map.get(id));
  const nodes = convertSiblings(rootBatch, 1, ctx);

  // Orphan sweep: records never reached from the roots and not consumed by a
  // compound callback are appended, as one sibling batch in original input
  // order, each flagged with DOCUMENT_ORPHAN_INCLUDED.
  const orphanRoots=[];
  for(const id of order) {
    if(ctx.visited.has(id)||ctx.consumed.has(id))continue;
    const parent=ctx.parentOf.get(id);
    if(parent && !ctx.visited.has(parent) && !ctx.consumed.has(parent))continue;
    orphanRoots.push(map.get(id));
    ctx.issues.push('DOCUMENT_ORPHAN_INCLUDED');
  }
  nodes.push(...convertSiblings(orphanRoots,1,ctx));

  return { nodes, issues: ctx.issues };
}

export { assembleDocumentTree, MAX_BLOCKS, MAX_DEPTH };
export default assembleDocumentTree;

const MAX_TABLE_CELLS = 20_000;
const MAX_CONTENT_DEPTH = 32;

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Convert a captured document table into editable Tiptap table JSON.
 * Returns null on any ambiguous or lossy structure so callers can retain the
 * legacy placeholder and flat block traversal. `convertBlock` converts one
 * non-container body block using the importer's established block rules.
 */
export function buildEditableTable(tableBlock, blocksById, convertBlock) {
  const geometry = tableBlock?.table;
  if (!object(geometry) || !Array.isArray(geometry.rowIds) || !Array.isArray(geometry.columnIds)
      || !Array.isArray(geometry.cells) || !Array.isArray(geometry.columnWidths)
      || typeof geometry.headerRow !== 'boolean') return null;

  const rowCount = geometry.rowIds.length, columnCount = geometry.columnIds.length;
  if (!rowCount || !columnCount || rowCount * columnCount > MAX_TABLE_CELLS
      || geometry.columnWidths.length !== columnCount
      || !geometry.columnWidths.every(width => width === null || typeof width === 'number' && Number.isFinite(width) && width >= 0 && width <= 10000)
      || !geometry.rowIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 256)
      || !geometry.columnIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 256)
      || new Set(geometry.rowIds).size !== rowCount || new Set(geometry.columnIds).size !== columnCount
      || geometry.cells.length !== rowCount * columnCount) return null;

  const coordinates = Array.from({ length: rowCount }, () => Array(columnCount));
  const referencedCells = new Set();
  for (const cell of geometry.cells) {
    if (!object(cell) || !Number.isInteger(cell.row) || !Number.isInteger(cell.column)
        || cell.row < 0 || cell.row >= rowCount || cell.column < 0 || cell.column >= columnCount
        || typeof cell.blockId !== 'string' || !cell.blockId
        || !Number.isInteger(cell.rowSpan) || !Number.isInteger(cell.columnSpan)) return null;
    if (coordinates[cell.row][cell.column] || referencedCells.has(cell.blockId)) return null;
    referencedCells.add(cell.blockId);
    const source = blocksById.get(cell.blockId);
    if (!source || source.type.toLowerCase() !== 'table_cell' || source.parentId !== tableBlock.id) return null;
    coordinates[cell.row][cell.column] = { ...cell, source };
  }
  if (coordinates.some(row => row.some(cell => !cell))) return null;

  const owners = Array.from({ length: rowCount }, () => Array(columnCount).fill(null));
  const consumed = new Set([tableBlock.id]);
  const seenBody = new Set();
  const issues = new Set();

  function bodyNodes(root) {
    const nodes = [];
    const stack = [{ block: root, depth: 0, ancestry: new Set() }];
    while (stack.length) {
      const { block, depth, ancestry } = stack.pop();
      if (depth > MAX_CONTENT_DEPTH || !block || ancestry.has(block.id) || seenBody.has(block.id)) return null;
      if (block.type.toLowerCase() === 'table' || block.type.toLowerCase() === 'table_cell') return null;
      seenBody.add(block.id); consumed.add(block.id);
      const children = block.children;
      if (!Array.isArray(children)) return null;
      const nextAncestry = new Set(ancestry); nextAncestry.add(block.id);
      const childBlocks = [];
      for (const id of children) {
        const child = blocksById.get(id);
        if (!child || child.parentId !== block.id) return null;
        childBlocks.push(child);
      }
      const own = convertBlock(block);
      if (!Array.isArray(own)) return null;
      nodes.push(...own);
      if (childBlocks.length) {
        for (let index = childBlocks.length - 1; index >= 0; index--) {
          stack.push({ block: childBlocks[index], depth: depth + 1, ancestry: nextAncestry });
        }
      }
    }
    return nodes;
  }

  function consumeEmptyCovered(source) {
    if (source.text || !Array.isArray(source.children)) return false;
    const stack = source.children.map(id => ({ id, parent: source.id, depth: 1 }));
    while (stack.length) {
      const { id, parent, depth } = stack.pop();
      const child = blocksById.get(id);
      if (!child || depth > MAX_CONTENT_DEPTH || seenBody.has(id) || child.parentId !== parent
          || !['text', 'paragraph'].includes(child.type.toLowerCase()) || child.text
          || !Array.isArray(child.children)) return false;
      seenBody.add(id); consumed.add(id);
      for (const next of child.children) stack.push({ id: next, parent: id, depth: depth + 1 });
    }
    consumed.add(source.id);
    return true;
  }

  for (let row = 0; row < rowCount; row++) {
    for (let column = 0; column < columnCount; column++) {
      const cell = coordinates[row][column];
      if (owners[row][column]) {
        if (cell.rowSpan !== 0 && cell.rowSpan !== 1 || cell.columnSpan !== 0 && cell.columnSpan !== 1) return null;
        // Covered records are frequently separate empty table_cell blocks.
        // Never discard text, children, or unknown content hidden in one.
        if (!consumeEmptyCovered(cell.source)) return null;
        continue;
      }
      if (cell.rowSpan < 1 || cell.columnSpan < 1
          || row + cell.rowSpan > rowCount || column + cell.columnSpan > columnCount) return null;
      for (let r = row; r < row + cell.rowSpan; r++) {
        for (let c = column; c < column + cell.columnSpan; c++) {
          if (owners[r][c]) return null;
          owners[r][c] = { row, column };
        }
      }
      consumed.add(cell.blockId);
      const childNodes = [];
      for (const childId of cell.source.children) {
        const child = blocksById.get(childId);
        if (!child || child.parentId !== cell.blockId) return null;
        const converted = bodyNodes(child);
        if (converted === null) return null;
        childNodes.push(...converted);
      }
      if (cell.source.text) {
        const own = convertBlock(cell.source);
        if (!Array.isArray(own)) return null;
        childNodes.unshift(...own);
      }
      const content = childNodes.length ? childNodes : [{ type: 'paragraph' }];
      const attrs = {};
      if (cell.rowSpan > 1) attrs.rowspan = cell.rowSpan;
      if (cell.columnSpan > 1) attrs.colspan = cell.columnSpan;
      const widths = geometry.columnWidths.slice(column, column + cell.columnSpan);
      if (widths.length === cell.columnSpan && widths.every(width => typeof width === 'number' && Number.isFinite(width) && width >= 0)) attrs.colwidth = widths;
      else issues.add('TABLE_COLUMN_WIDTH_PARTIAL');
      cell.node = {
        type: geometry.headerRow && row === 0 ? 'tableHeader' : 'tableCell',
        ...(Object.keys(attrs).length ? { attrs } : {}), content,
      };
    }
  }
  if (owners.some(row => row.some(owner => !owner))) return null;

  const content = [];
  for (let row = 0; row < rowCount; row++) {
    const cells = [];
    for (let column = 0; column < columnCount; column++) {
      if (owners[row][column].row === row && owners[row][column].column === column) cells.push(coordinates[row][column].node);
    }
    content.push({ type: 'tableRow', content: cells });
  }
  return { node: { type: 'table', content }, consumed, issues: [...issues] };
}

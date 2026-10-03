/**
 * Pure HTML spreadsheet layout projection.
 *
 * Zero imports, no IO, no HTML/CSS/URL generation, no dynamic code.
 * Input is a previously schema-validated spreadsheet document:
 *   { rowCount, columnCount, cellData, mergeData }
 *
 * Nothing in the input is mutated; layout arrays are freshly built, while cell references are retained.
 */

const TOO_LARGE = 'HTML_GRID_TOO_LARGE';
const MERGE_INVALID = 'HTML_MERGE_INVALID';

const DEFAULT_BUDGET = 150000;

/** True for a positive safe integer, nothing else (no coercion). */
function isPositiveSafeInteger(value) {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0
  );
}

/** True for a non-null, non-array object. */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A covered cell is retained when it carries a nonempty v, f or p.
 * Zero and false count as present content; undefined, null and '' do not.
 * Only those three fields are considered; other keys are irrelevant.
 */
function hasContent(cell) {
  if (!isObject(cell)) return false;
  for (const key of ['v', 'f', 'p']) {
    const value = cell[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.length === 0) continue;
    return true;
  }
  return false;
}

const MERGE_KEYS = ['startRow', 'endRow', 'startColumn', 'endColumn'];

/**
 * Build the row-major layout projection for a sheet.
 *
 * @param {object} sheet validated spreadsheet document
 * @param {number} budget maximum allowed rowCount*columnCount cells
 * @returns {{rows: Array<Array<object>>, positions: number, coveredCells: Array<object>}}
 */
export function buildSheetLayout(sheet, budget = DEFAULT_BUDGET) {
  if (!isObject(sheet)) {
    throw new Error(TOO_LARGE);
  }

  const rowCount = sheet.rowCount;
  const columnCount = sheet.columnCount;

  if (!isPositiveSafeInteger(rowCount) || !isPositiveSafeInteger(columnCount)) {
    throw new Error(TOO_LARGE);
  }

  if (
    typeof budget !== 'number' ||
    !Number.isSafeInteger(budget) ||
    budget <= 0
  ) {
    throw new Error(TOO_LARGE);
  }

  // Capacity gate: computed with safe arithmetic *before* any allocation or loop.
  const positions = rowCount * columnCount;
  if (!Number.isSafeInteger(positions) || positions > budget) {
    throw new Error(TOO_LARGE);
  }

  const cellData = sheet.cellData === undefined || sheet.cellData === null
    ? {}
    : sheet.cellData;
  const mergeData = sheet.mergeData === undefined || sheet.mergeData === null
    ? []
    : sheet.mergeData;

  if (!isObject(cellData) || !Array.isArray(mergeData)) {
    throw new Error(MERGE_INVALID);
  }

  // -- Validate merges (integral, in bounds) before occupancy bookkeeping.
  const merges = [];
  for (const raw of mergeData) {
    const merge = raw;
    if (!isObject(merge)) {
      throw new Error(MERGE_INVALID);
    }

    for (const key of MERGE_KEYS) {
      const value = merge[key];
      if (
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < 0
      ) {
        throw new Error(MERGE_INVALID);
      }
    }
    const startRow = merge.startRow;
    const endRow = merge.endRow;
    const startColumn = merge.startColumn;
    const endColumn = merge.endColumn;

    if (startRow > endRow || startColumn > endColumn) {
      throw new Error(MERGE_INVALID);
    }
    if (startRow >= rowCount || endRow >= rowCount) {
      throw new Error(MERGE_INVALID);
    }
    if (startColumn >= columnCount || endColumn >= columnCount) {
      throw new Error(MERGE_INVALID);
    }

    merges.push({ startRow, endRow, startColumn, endColumn });
  }

  // -- Occupancy grid: 0 = free, otherwise 1-based merge ordinal.
  const owner = new Array(positions);
  for (let i = 0; i < positions; i += 1) {
    owner[i] = 0;
  }

  const coveredCells = [];

  for (let index = 0; index < merges.length; index += 1) {
    const merge = merges[index];
    const tag = index + 1;

    for (let r = merge.startRow; r <= merge.endRow; r += 1) {
      const rowOffset = r * columnCount;
      for (let c = merge.startColumn; c <= merge.endColumn; c += 1) {
        const slot = rowOffset + c;
        if (owner[slot] !== 0) {
          // Any collision, including a duplicate anchor, is invalid.
          throw new Error(MERGE_INVALID);
        }
        owner[slot] = tag;

        const isAnchor =
          r === merge.startRow && c === merge.startColumn;
        if (isAnchor) {
          continue;
        }

        const cell = readCell(cellData, r, c);
        if (cell !== null && hasContent(cell)) {
          coveredCells.push({ row: r, column: c, cell });
        }
      }
    }
  }

  // -- Row-major descriptor projection of the entire declared rectangle.
  const rows = [];
  for (let r = 0; r < rowCount; r += 1) {
    const rowOffset = r * columnCount;
    const rowArray = [];
    for (let c = 0; c < columnCount; c += 1) {
      const tag = owner[rowOffset + c];
      if (tag !== 0) {
        const merge = merges[tag - 1];
        const isAnchor =
          r === merge.startRow && c === merge.startColumn;
        if (!isAnchor) {
          // Covered position: omitted from the projected row entirely.
          continue;
        }
        rowArray.push({
          row: r,
          column: c,
          rowspan: merge.endRow - merge.startRow + 1,
          colspan: merge.endColumn - merge.startColumn + 1,
          cell: readCell(cellData, r, c),
        });
        continue;
      }

      rowArray.push({
        row: r,
        column: c,
        rowspan: 1,
        colspan: 1,
        cell: readCell(cellData, r, c),
      });
    }
    rows.push(rowArray);
  }

  return { rows, positions, coveredCells };
}

/**
 * Read the original cell reference for (row, column), or null.
 * Never creates intermediate objects in the input.
 */
function readCell(cellData, row, column) {
  const rowRecord = cellData[row];
  if (rowRecord === undefined || rowRecord === null) return null;
  if (!isObject(rowRecord)) return null;
  const cell = rowRecord[column];
  if (cell === undefined || cell === null) return null;
  return cell;
}

export default buildSheetLayout;

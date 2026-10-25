/**
 * Pure sheet-snapshot diagnostics.
 *
 * buildSheetAudit(snapshot) projects a capture-shaped sheet snapshot into a
 * fixed-shape audit report. It performs no IO, never touches DOM/network, has
 * zero imports, never mutates its input, and never returns document contents
 * or URLs. Invalid input yields null rather than a partial report.
 */

const AUDIT_VERSION = 1;
const MAX_SHEETS = 100;
const MAX_SHEET_NAME_LENGTH = 256;
const MAX_ROWS = 100000;
const MAX_COLUMNS = 10000;
const MAX_TOTAL_POSITIONS = 150000;
const MAX_TOTAL_CAPTURED_CELLS = 150000;
const MAX_MERGES_PER_SHEET = 20000;

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonnegativeInteger = (value) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

const isPositiveInteger = (value) =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * value is acceptable when it is null, a string, a finite number, or a boolean.
 * The spec's "value not null/string/finite-number/boolean" rejection rule is
 * implemented as the exact complement of that set, so null itself is valid.
 */
const isValidValue = (value) =>
  value === null ||
  typeof value === 'string' ||
  isFiniteNumber(value) ||
  typeof value === 'boolean';

const isValidFormula = (formula) => formula === null || typeof formula === 'string';

const isValidStyle = (style) => style === null || isPlainObject(style);

const countPopulatedValues = (cells) =>
  cells.reduce(
    (count, entry) =>
      count + (entry.value !== null && entry.value !== '' ? 1 : 0),
    0,
  );

const countDisplays = (cells) =>
  cells.reduce(
    (count, entry) => (count + (entry.display.length > 0 ? 1 : 0)),
    0,
  );

const countFormulas = (cells) =>
  cells.reduce(
    (count, entry) =>
      count + (typeof entry.formula === 'string' && entry.formula.length > 0 ? 1 : 0),
    0,
  );

const countStyled = (cells) =>
  cells.reduce(
    (count, entry) => (count + (Object.keys(entry.style || {}).length > 0 ? 1 : 0)),
    0,
  );

/**
 * Validate the cells array: shape, coordinate bounds/integrality, duplicate
 * coordinates, and per-field types. Returns null on any violation.
 */
const auditCells = (cells, rows, columns) => {
  const seen = new Set();
  for (const entry of cells) {
    if (!isPlainObject(entry)) return null;
    if (!isNonnegativeInteger(entry.row) || entry.row >= rows) return null;
    if (!isNonnegativeInteger(entry.column) || entry.column >= columns) return null;
    const coordinate = `${entry.row}:${entry.column}`;
    if (seen.has(coordinate)) return null;
    seen.add(coordinate);
    if (!isValidValue(entry.value)) return null;
    if (typeof entry.display !== 'string') return null;
    if (!isValidFormula(entry.formula)) return null;
    if (!isValidStyle(entry.style)) return null;
  }
  return {
    capturedCells: cells.length,
    valueCells: countPopulatedValues(cells),
    displayCells: countDisplays(cells),
    formulaCells: countFormulas(cells),
    styledCells: countStyled(cells),
  };
};

/**
 * Validate merge metadata: integral nonnegative origin, positive integral
 * extent, and full containment inside the declared dimensions.
 */
const isValidMerges = (merges, rows, columns) => {
  if (merges.length > MAX_MERGES_PER_SHEET) return false;
  for (const merge of merges) {
    if (!isPlainObject(merge)) return false;
    if (!isNonnegativeInteger(merge.row)) return false;
    if (!isNonnegativeInteger(merge.column)) return false;
    if (!isPositiveInteger(merge.rows)) return false;
    if (!isPositiveInteger(merge.columns)) return false;
    if (merge.row + merge.rows > rows) return false;
    if (merge.column + merge.columns > columns) return false;
  }
  return true;
};

/**
 * Validate one sheet entry and project its counts. Returns null when the entry
 * is malformed or would exceed a declared bound.
 */
const auditSheet = (entry) => {
  if (!isPlainObject(entry)) return null;
  if (typeof entry.name !== 'string' || entry.name.length > MAX_SHEET_NAME_LENGTH) {
    return null;
  }
  if (!Number.isInteger(entry.rows) || entry.rows < 0 || entry.rows > MAX_ROWS) {
    return null;
  }
  if (
    !Number.isInteger(entry.columns) ||
    entry.columns < 0 ||
    entry.columns > MAX_COLUMNS
  ) {
    return null;
  }
  const positions = entry.rows * entry.columns;
  if (positions > MAX_TOTAL_POSITIONS) return null;
  if (!Array.isArray(entry.cells) || !Array.isArray(entry.merges)) return null;
  if (entry.cells.length > MAX_TOTAL_CAPTURED_CELLS) return null;
  if (positions === 0 && (entry.cells.length > 0 || entry.merges.length > 0)) {
    return null;
  }
  if (!isValidMerges(entry.merges, entry.rows, entry.columns)) return null;
  const counts = auditCells(entry.cells, entry.rows, entry.columns);
  if (counts === null) return null;

  const state =
    counts.valueCells === 0 &&
    counts.displayCells === 0 &&
    counts.formulaCells === 0
      ? 'EMPTY_OR_UNLOADED'
      : 'NEEDS_REVIEW';

  return {
    index: 0,
    name: entry.name,
    rows: entry.rows,
    columns: entry.columns,
    positions,
    capturedCells: counts.capturedCells,
    valueCells: counts.valueCells,
    displayCells: counts.displayCells,
    formulaCells: counts.formulaCells,
    styledCells: counts.styledCells,
    merges: entry.merges.length,
    state,
    coverage: 'UNKNOWN',
  };
};

/**
 * Build the audit report for a capture-shaped sheet snapshot.
 *
 * @param {unknown} snapshot capture-shaped object ({kind:'sheet', model:{sheets:[...]}})
 * @returns {object|null} audit report, or null when the snapshot is unusable
 */
export function buildSheetAudit(snapshot) {
  if (!isPlainObject(snapshot) || snapshot.kind !== 'sheet') return null;
  const model = snapshot.model;
  if (!isPlainObject(model) || !Array.isArray(model.sheets)) return null;

  const sourceSheets = model.sheets;
  if (sourceSheets.length === 0 || sourceSheets.length > MAX_SHEETS) return null;

  const sheets = [];
  let totalPositions = 0;
  let totalCapturedCells = 0;

  for (let position = 0; position < sourceSheets.length; position += 1) {
    const audited = auditSheet(sourceSheets[position]);
    if (audited === null) return null;
    audited.index = position;
    totalPositions += audited.positions;
    totalCapturedCells += audited.capturedCells;
    if (totalPositions > MAX_TOTAL_POSITIONS) return null;
    if (totalCapturedCells > MAX_TOTAL_CAPTURED_CELLS) return null;
    sheets.push(audited);
  }

  const totals = {
    sheets: sheets.length,
    positions: totalPositions,
    capturedCells: totalCapturedCells,
    valueCells: 0,
    displayCells: 0,
    formulaCells: 0,
    styledCells: 0,
    merges: 0,
    emptyOrUnloadedSheets: 0,
  };

  for (const sheet of sheets) {
    totals.valueCells += sheet.valueCells;
    totals.displayCells += sheet.displayCells;
    totals.formulaCells += sheet.formulaCells;
    totals.styledCells += sheet.styledCells;
    totals.merges += sheet.merges;
    if (sheet.state === 'EMPTY_OR_UNLOADED') totals.emptyOrUnloadedSheets += 1;
  }

  return {
    version: AUDIT_VERSION,
    status: 'PENDING',
    coverage: 'UNKNOWN',
    totals,
    sheets,
  };
}

export default buildSheetAudit;

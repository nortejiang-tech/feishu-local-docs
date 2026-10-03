/**
 * Trusted pure statistics module.
 *
 * Dependency-free ESM. No I/O, network, DOM, Chrome API, environment access,
 * subprocesses or credentials. Input is treated as normalized data only;
 * unknown/extra properties (e.g. `raw`) are never inspected.
 */

/** Coerce a possibly missing / non-array value to an array. */
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/** Model object for a snapshot, or an empty object when absent. */
function modelOf(snapshot) {
  const model = snapshot && typeof snapshot.model === 'object' && snapshot.model !== null
    ? snapshot.model
    : {};
  return model;
}

/**
 * Count a type name into a Map accumulator.
 * Type names are data and may be `__proto__` or `constructor`; using a
 * Map accumulator keeps them from resolving inherited properties
 * while the returned map still has Object.prototype as its prototype.
 */
function bump(counts, key) {
  counts.set(key, (counts.get(key) || 0) + 1);
}

function countsToPlainObject(counts) {
  const out = {};
  for (const [key, value] of counts) {
    Object.defineProperty(out, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return out;
}

function normalizeType(type) {
  return typeof type === 'string' && type.length > 0 ? type : 'unknown';
}

function summarizeDocument(model) {
  const blocks = asArray(model.blocks);
  let textCharacters = 0;
  const byType = new Map();
  for (const block of blocks) {
    const entry = block && typeof block === 'object' ? block : {};
    textCharacters += typeof entry.text === 'string' ? entry.text.length : 0;
    bump(byType, normalizeType(entry.type));
  }
  return {
    kind: 'document',
    items: blocks.length,
    textCharacters,
    byType: countsToPlainObject(byType),
  };
}

function summarizeSheet(model) {
  const sheets = asArray(model.sheets);
  let cells = 0;
  let nonemptyValues = 0;
  let formulas = 0;
  let merges = 0;
  for (const sheet of sheets) {
    const entry = sheet && typeof sheet === 'object' ? sheet : {};
    const sheetCells = asArray(entry.cells);
    cells += sheetCells.length;
    for (const rawCell of sheetCells) {
      const cell = rawCell && typeof rawCell === 'object' ? rawCell : {};
      const value = cell.value;
      if (value !== null && value !== undefined && value !== '') {
        nonemptyValues += 1;
      }
      if (typeof cell.formula === 'string' && cell.formula.length > 0) {
        formulas += 1;
      }
    }
    merges += asArray(entry.merges).length;
  }
  return {
    kind: 'sheet',
    items: sheets.length,
    cells,
    nonemptyValues,
    formulas,
    merges,
  };
}

/**
 * Summarize a normalized snapshot without mutating it.
 *
 * @param {unknown} snapshot
 * @returns {{kind:string, items:number, [key:string]: unknown}}
 */
export function summarize(snapshot) {
  if (snapshot === null || typeof snapshot !== 'object') {
    return { kind: 'unknown', items: 0 };
  }
  if (snapshot.kind === 'document') {
    return summarizeDocument(modelOf(snapshot));
  }
  if (snapshot.kind === 'sheet') {
    return summarizeSheet(modelOf(snapshot));
  }
  return { kind: 'unknown', items: 0 };
}

export default summarize;

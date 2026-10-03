/**
 * Native base cell edit helper (pure, no IO / DOM / network / dynamic evaluation).
 *
 * Validates the entire edit against the native business shape first, then returns
 * a JSON deep clone of the whole payload with exactly one cell value replaced.
 * The input payload is never mutated.
 */

const UNSUPPORTED = () => new Error('BASE_EDIT_UNSUPPORTED');

const MAX_TEXT_LENGTH = 100000;
const MIN_EPOCH = -8640000000000000;
const MAX_EPOCH = 8640000000000000;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSafeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/** Old text cell value: null/undefined, string, or ONLY plain {type:'text',text} fragments. */
function isValidOldText(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return true;
  if (!Array.isArray(value)) return false;
  return value.every((fragment) => {
    if (!isPlainObject(fragment)) return false;
    const keys = Object.keys(fragment).sort();
    if (keys.length !== 2 || keys[0] !== 'text' || keys[1] !== 'type') return false;
    return fragment.type === 'text' && typeof fragment.text === 'string';
  });
}

function isValidNewText(value) {
  if (value === null) return true;
  return typeof value === 'string' && value.length <= MAX_TEXT_LENGTH;
}

function toStoredText(value) {
  return value === null ? null : [{ type: 'text', text: value }];
}

function optionIds(field) {
  const property = field.property;
  if (!isPlainObject(property)) return null;
  const options = property.options;
  if (!Array.isArray(options)) return null;
  const ids = new Set();
  for (const option of options) {
    if (isPlainObject(option) && typeof option.id === 'string') ids.add(option.id);
  }
  return ids;
}

/** Old select value: null/undefined or an ID still present in the field options. */
function isValidOldSelect(value, ids) {
  if (value === null || value === undefined) return true;
  return typeof value === 'string' && ids.has(value);
}

function isValidNewSelect(value, ids) {
  if (value === null) return true;
  return typeof value === 'string' && ids.has(value);
}

/** Old/new date value: null/undefined or safe integer epoch in supported range. */
function isValidEpoch(value) {
  if (value === null || value === undefined) return true;
  return isSafeInteger(value) && value >= MIN_EPOCH && value <= MAX_EPOCH;
}

function isValidNewEpoch(value) {
  if (value === undefined) return false;
  return isValidEpoch(value);
}

function validateOldValue(type, oldCell, field) {
  if (type === 1) {
    return isValidOldText(oldCell === undefined ? undefined : oldCell.value);
  }
  if (type === 3) {
    const ids = optionIds(field);
    if (ids === null) return false;
    return isValidOldSelect(oldCell === undefined ? undefined : oldCell.value, ids);
  }
  if (type === 5) {
    return isValidEpoch(oldCell === undefined ? undefined : oldCell.value);
  }
  return false;
}

function computeStoredNewValue(type, newValue, field) {
  if (type === 1) {
    if (!isValidNewText(newValue)) throw UNSUPPORTED();
    return toStoredText(newValue);
  }
  if (type === 3) {
    const ids = optionIds(field);
    if (ids === null) throw UNSUPPORTED();
    if (!isValidNewSelect(newValue, ids)) throw UNSUPPORTED();
    return newValue;
  }
  if (type === 5) {
    if (!isValidNewEpoch(newValue)) throw UNSUPPORTED();
    return newValue === undefined ? null : newValue;
  }
  throw UNSUPPORTED();
}

/**
 * @param {object} payload native business payload
 * @param {string} recordId existing record ID
 * @param {string} fieldId existing field ID of a supported type
 * @param {*} newValue new value for the cell
 * @returns {object} JSON deep clone of payload with only that cell value replaced
 * @throws {Error} Error('BASE_EDIT_UNSUPPORTED') for anything not supported
 */
export function editBaseCell(payload, recordId, fieldId, newValue) {
  if (!isPlainObject(payload)) throw UNSUPPORTED();
  if (payload.format !== 'feishu-bitable-table') throw UNSUPPORTED();

  const table = payload.table;
  if (!isPlainObject(table)) throw UNSUPPORTED();

  const fieldMap = table.fieldMap;
  const recordMap = table.recordMap;
  if (!isPlainObject(fieldMap) || !isPlainObject(recordMap)) throw UNSUPPORTED();

  if (!isNonEmptyString(recordId) || !isNonEmptyString(fieldId)) throw UNSUPPORTED();
  if (!Object.prototype.hasOwnProperty.call(fieldMap, fieldId)) throw UNSUPPORTED();
  if (!Object.prototype.hasOwnProperty.call(recordMap, recordId)) throw UNSUPPORTED();

  const field = fieldMap[fieldId];
  if (!isPlainObject(field)) throw UNSUPPORTED();

  const record = recordMap[recordId];
  if (!isPlainObject(record)) throw UNSUPPORTED();

  const oldCell = Object.prototype.hasOwnProperty.call(record, fieldId) ? record[fieldId] : undefined;
  if (oldCell !== undefined && !isPlainObject(oldCell)) throw UNSUPPORTED();

  // Validation must fully finish before any cloning or editing happens.
  if (!validateOldValue(field.type, oldCell, field)) throw UNSUPPORTED();
  const stored = computeStoredNewValue(field.type, newValue, field);

  const clone = JSON.parse(JSON.stringify(payload));
  const targetRecord = clone.table.recordMap[recordId];
  if (oldCell === undefined) {
    targetRecord[fieldId] = { value: stored };
  } else {
    targetRecord[fieldId].value = stored;
  }
  return clone;
}

export default editBaseCell;

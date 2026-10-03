/**
 * Base grid projection.
 *
 * Pure display projection of previously validated Feishu bitable table data.
 * Not a security validator, not a full view engine. No IO, no network, no DOM,
 * no dynamic evaluation. Input is never mutated.
 */

const MAX_COLUMNS = 500;
const MAX_ROWS = 10000;
const MAX_RANK_LEN = 128;

const BLANK_CONTENT = '暂不支持的内容';const BLANK_FIELD = '暂不支持的字段';
const UNKNOWN_OPTION = '未知选项';

const DATE_MIN = -8640000000000000;
const DATE_MAX = 8640000000000000;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function asId(v) {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function isSafeDateEpoch(v) {
  return Number.isSafeInteger(v) && v >= DATE_MIN && v <= DATE_MAX;
}

/** Project only {id,name,color} for entries that satisfy the type3 contract. */
function projectOptions(property) {
  const choices = isPlainObject(property) && Array.isArray(property.options) ? property.options : [];
  const out = [];
  for (const raw of choices) {
    if (!isPlainObject(raw)) continue;
    const id = asId(raw.id);
    const name = asId(raw.name);
    if (id === null || name === null) continue;
    let color = 0;
    if (typeof raw.color === 'number' && Number.isFinite(raw.color)) {
      color = raw.color;
    }
    out.push({ id, name, color });
  }
  return out;
}

function projectColumn(fieldId, field) {
  const f = isPlainObject(field) ? field : {};
  const name = typeof f.name === 'string' && f.name.length > 0 ? f.name : fieldId;
  const type = typeof f.type === 'number' && Number.isFinite(f.type) ? f.type : null;
  const options = type === 3 ? projectOptions(f.property) : [];
  return { id: fieldId, name, type, options };
}

function cell(fieldId, display, editable, value) {
  return { fieldId, display, editable, value };
}

/**
 * Build the cell for one column of one row.
 * @returns {{cell:Object, unsupported:boolean}}
 */
function projectCell(fieldId, type, options, rawCell) {
  const present = rawCell !== undefined && rawCell !== null;
  const value = present ? rawCell.value : null;
  const empty = value === null || value === undefined;

  if (type === 1) {
    if (empty) return { cell: cell(fieldId, '', true, null), unsupported: false };
    if (typeof value === 'string') return { cell: cell(fieldId, value, true, value), unsupported: false };
    if (Array.isArray(value)) {
      let text = '';
      for (const frag of value) {
        if (!isPlainObject(frag) || frag.type !== 'text' || typeof frag.text !== 'string' || Object.keys(frag).some(k=>k!=='type'&&k!=='text')) {
          return { cell: cell(fieldId, BLANK_CONTENT, false, null), unsupported: true };
        }
        text += frag.text;
      }
      return { cell: cell(fieldId, text, true, text), unsupported: false };
    }
    return { cell: cell(fieldId, BLANK_CONTENT, false, null), unsupported: true };
  }

  if (type === 3) {
    if (empty) return { cell: cell(fieldId, '', true, null), unsupported: false };
    if (typeof value === 'string') {
      const hit = options.find((o) => o.id === value);
      if (hit) return { cell: cell(fieldId, hit.name, true, hit.id), unsupported: false };
      return { cell: { fieldId, display: UNKNOWN_OPTION, editable: false, value: null }, unsupported: true };
    }
    return { cell: cell(fieldId, BLANK_CONTENT, false, null), unsupported: true };
  }

  if (type === 5) {
    if (empty) return { cell: cell(fieldId, '', true, null), unsupported: false };
    if (isSafeDateEpoch(value)) {
      return { cell: cell(fieldId, new Date(value).toISOString(), true, value), unsupported: false };
    }
    return { cell: cell(fieldId, BLANK_CONTENT, false, null), unsupported: true };
  }

  // Unknown / unsupported field type: read-only placeholder, even when blank.
  return { cell: { fieldId, display: BLANK_FIELD, editable: false, value: null }, unsupported: true };
}

function emptyResult() {
  return { columns: [], rows: [], order: 'CAPTURE', unsupportedCells: 0, viewPending: true };
}

function uniqueIds(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const id = asId(raw);
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * @param {unknown} payload validated feishu-bitable-table payload
 * @param {unknown} viewId requested view id
 * @returns {{columns:Array,rows:Array,order:string,unsupportedCells:number,viewPending:boolean}}
 */
export function buildBaseGrid(payload, viewId) {
  if (!isPlainObject(payload) || payload.format !== 'feishu-bitable-table') return emptyResult();
  const table = payload.table;
  if (!isPlainObject(table)) return emptyResult();
  const fieldMap = isPlainObject(table.fieldMap) ? table.fieldMap : {};
  const recordMap = isPlainObject(table.recordMap) ? table.recordMap : {};

  // ---- columns: valid unique view.fields first, then remaining fieldMap ids ----
  const allFieldIds = Object.keys(fieldMap);
  const viewIds = Array.isArray(table.views) ? table.views.map(asId).filter((v) => v !== null) : [];
  const viewMap = isPlainObject(table.viewMap) ? table.viewMap : {};
  let view = null;
  const wanted = asId(viewId);
  if (wanted !== null && isPlainObject(viewMap[wanted]) && viewIds.includes(wanted)) {
    view = viewMap[wanted];
  } else if (viewIds.length > 0) {
    view = isPlainObject(viewMap[viewIds[0]]) ? viewMap[viewIds[0]] : null;
  }

  const columnIds = [];
  const seenCol = new Set();
  const viewFields = view && Array.isArray(view.property?.fields) ? view.property.fields : [];
  for (const id of uniqueIds(viewFields)) {
    if (Object.prototype.hasOwnProperty.call(fieldMap, id) && !seenCol.has(id)) {
      seenCol.add(id);
      columnIds.push(id);
    }
  }
  for (const id of allFieldIds) {
    if (!seenCol.has(id)) {
      seenCol.add(id);
      columnIds.push(id);
    }
  }
  const columns = columnIds.slice(0, MAX_COLUMNS).map((id) => projectColumn(id, fieldMap[id]));

  // ---- base row order: RANK when every record has a valid unique rank ----
  const recordIds = Object.keys(recordMap);
  const rankMapRaw = isPlainObject(table.rankInfo) && isPlainObject(table.rankInfo.rankMap)
    ? table.rankInfo.rankMap
    : {};
  let order = 'CAPTURE';
  let baseIds = recordIds;
  const ranks = new Map();
  let rankOk = recordIds.length > 0;
  const seenRank = new Set();
  if (rankOk) {
    for (const rid of recordIds) {
      const r = rankMapRaw[rid];
      if (typeof r !== 'string' || r.length === 0 || r.length > MAX_RANK_LEN || seenRank.has(r)) {
        rankOk = false;
        break;
      }
      seenRank.add(r);
      ranks.set(rid, r);
    }
  }
  if (rankOk) {
    baseIds = recordIds.slice().sort((a, b) => {
      const ra = ranks.get(a);
      const rb = ranks.get(b);
      return ra < rb ? -1 : ra > rb ? 1 : 0;
    });
    order = 'RANK';
  }

  // ---- explicit view record order overrides base order ----
  const viewRecords = uniqueIds(
    view && Array.isArray(view.property?.records) ? view.property.records : []
  ).filter((id) => Object.prototype.hasOwnProperty.call(recordMap, id));

  let rowIds;
  if (viewRecords.length > 0) {
    const rest = baseIds.filter((id) => !viewRecords.includes(id));
    rowIds = viewRecords.concat(rest);
    order = 'VIEW_RECORDS';
  } else {
    rowIds = baseIds;
  }
  rowIds = rowIds.slice(0, MAX_ROWS);

  // ---- rows ----
  let unsupportedCells = 0;
  const rows = [];
  for (const rid of rowIds) {
    const record = isPlainObject(recordMap[rid]) ? recordMap[rid] : {};
    const cells = [];
    for (const col of columns) {
      const rawCell = Object.prototype.hasOwnProperty.call(record, col.id) ? record[col.id] : undefined;
      const result = projectCell(col.id, col.type, col.options, rawCell);
      if (result.unsupported) unsupportedCells += 1;
      cells.push(result.cell);
    }
    rows.push({ id: rid, cells });
  }

  return { columns, rows, order, unsupportedCells, viewPending: true };
}

export default buildBaseGrid;

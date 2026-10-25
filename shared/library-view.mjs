// Pure library projection helpers.
// No imports, no IO, no globals, no mutation of inputs, no HTML output.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS = ['document', 'sheet'];
const MAX_TITLE_LENGTH = 1000;
const MAX_FOLDER_LENGTH = 64;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isUuid = (value) =>
  typeof value === 'string' && value.length === 36 && UUID_RE.test(value);

const isNonnegativeSafeInteger = (value) =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 0;

const isValidTimestamp = (value) => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return false;
  if (!ISO_RE.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
};

const isTitle = (value) =>
  typeof value === 'string' && value.length <= MAX_TITLE_LENGTH;

/**
 * Structural validity of a library record (full document or metadata summary).
 * Returns the normalized core fields or null when structurally invalid.
 */
function coreFields(record) {
  if (!isPlainObject(record)) return null;
  if (!isUuid(record.id)) return null;
  if (typeof record.kind !== 'string' || !KINDS.includes(record.kind)) return null;
  if (!isTitle(record.title)) return null;
  if (!isNonnegativeSafeInteger(record.revision)) return null;
  if (!isValidTimestamp(record.createdAt)) return null;
  if (!isValidTimestamp(record.updatedAt)) return null;
  return {
    id: record.id,
    title: record.title,
    kind: record.kind,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function readFolder(localMeta, record) {
  if (isPlainObject(localMeta) && typeof localMeta.folder === 'string') {
    const trimmed = localMeta.folder.trim();
    if (trimmed.length > 0 && trimmed.length <= MAX_FOLDER_LENGTH) return trimmed;
    return '';
  }
  if (isPlainObject(localMeta)) return '';
  // Summary records may carry a top-level folder as fallback.
  if (isPlainObject(record) && typeof record.folder === 'string') {
    const trimmed = record.folder.trim();
    if (trimmed.length > 0 && trimmed.length <= MAX_FOLDER_LENGTH) return trimmed;
  }
  return '';
}

function readTaskId(localMeta, record) {
  if (isPlainObject(localMeta) && isUuid(localMeta.taskId)) return localMeta.taskId;
  if (isPlainObject(localMeta)) return null;
  // Summary records may carry a top-level taskId as fallback.
  if (isPlainObject(record) && isUuid(record.taskId)) return record.taskId;
  return null;
}

/**
 * Project a document (or an existing summary) into the public summary shape.
 * Returns null for structurally invalid input. Never exposes content,
 * provenance, body, or URLs, and never keeps references to the input.
 */
export function documentSummary(doc) {
  const core = coreFields(doc);
  if (!core) return null;
  const localMeta = doc.localMeta;
  return {
    id: core.id,
    title: core.title,
    kind: core.kind,
    revision: core.revision,
    createdAt: core.createdAt,
    updatedAt: core.updatedAt,
    summary: true,
    folder: readFolder(localMeta, doc),
    taskId: readTaskId(localMeta, doc),
    trashed: doc.trashed === true,
  };
}

function normalizeOptions(options) {
  const opts = isPlainObject(options) ? options : {};

  const query = typeof opts.query === 'string' ? opts.query.trim().toLowerCase() : '';

  const rawFolder = typeof opts.folder === 'string' ? opts.folder.trim() : '';
  const folder = rawFolder.length > 0 ? rawFolder : '';

  const kind =
    typeof opts.kind === 'string' && KINDS.includes(opts.kind) ? opts.kind : '';

  const trashed = opts.trashed === true;

  return { query, folder, kind, trashed };
}

function matchesFilter(summary, filter) {
  if (filter.query && !summary.title.toLowerCase().includes(filter.query)) return false;
  if (filter.folder && summary.folder !== filter.folder) return false;
  if (filter.kind && summary.kind !== filter.kind) return false;
  if (summary.trashed !== filter.trashed) return false;
  return true;
}

/**
 * Build { ids, folders } from library entries.
 * Invalid entries are skipped. ids hold ids only (no metadata copies, no body),
 * unique by id keeping the first occurrence, sorted by updatedAt descending then
 * id ascending. folders lists nonempty folders of valid, non-trashed entries in
 * lexicographic ascending order. Input is never mutated.
 */
export function libraryView(entries, options = {}) {
  if (!Array.isArray(entries)) return { ids: [], folders: [] };

  const filter = normalizeOptions(options);
  const seen = new Set();
  const matched = [];
  const folderSet = new Set();

  for (const entry of entries) {
    if (!isPlainObject(entry)) continue;
    const summary = documentSummary(entry);
    if (!summary) continue;

    if (summary.folder && !summary.trashed) folderSet.add(summary.folder);

    if (!matchesFilter(summary, filter)) continue;
    if (seen.has(summary.id)) continue;
    seen.add(summary.id);
    matched.push({ id: summary.id, updatedAt: summary.updatedAt });
  }

  matched.sort((left, right) => {
    const leftTime = Date.parse(left.updatedAt);
    const rightTime = Date.parse(right.updatedAt);
    if (leftTime !== rightTime) return rightTime - leftTime;
    if (left.id < right.id) return -1;
    if (left.id > right.id) return 1;
    return 0;
  });

  return {
    ids: matched.map((item) => item.id),
    folders: [...folderSet].sort(),
  };
}

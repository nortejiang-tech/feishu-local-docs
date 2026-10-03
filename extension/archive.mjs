export const MAX_FILE_BYTES = 24000000;

export function validateSnapshot(s) {
  const isText = (v, max = 100000) => typeof v === 'string' && v.length <= max;
  const integer = (v, max) => Number.isInteger(v) && v >= 0 && v <= max;
  const invalid = () => { throw new Error('ARCHIVE_INVALID'); };
  if (!s || s.schemaVersion !== 1 || !['document', 'sheet'].includes(s.kind) || !s.model || !isText(s.source?.title, 1000) || !isText(s.source?.url, 2000)) invalid();
  if (s.fidelity?.status !== 'PENDING' || s.fidelity.complete !== false || s.fidelity.authoritativeTotal !== null || s.fidelity.assets !== 'PENDING' || s.fidelity.roundtrip !== 'PENDING') invalid();
  if (!Array.isArray(s.issues) || s.issues.length > 100 || !s.issues.every(x => x && isText(x.code, 128) && integer(x.count, 1000000))) invalid();
  for (const code of ['COMPLETENESS_UNKNOWN', 'ASSET_BYTES_NOT_CAPTURED', 'ROUNDTRIP_NOT_IMPLEMENTED']) if (!s.issues.some(x => x.code === code && x.count > 0)) invalid();
  if (s.kind === 'document') {
    if (!Array.isArray(s.model.blocks) || s.model.blocks.length > 10000) invalid();
    const ids = new Set();
    for (const b of s.model.blocks) {
      if (!b || !isText(b.id, 256) || !b.id || ids.has(b.id) || !isText(b.type, 64) || !isText(b.text, 8000000) || (b.parentId !== null && !isText(b.parentId, 256)) || !Array.isArray(b.children) || b.children.length > 10000 || !b.children.every(x => isText(x, 256))) invalid();
      ids.add(b.id);
    }
  } else {
    if (!Array.isArray(s.model.sheets) || s.model.sheets.length > 100) invalid();
    let positions = 0, cells = 0;
    for (const sheet of s.model.sheets) {
      if (!sheet || !isText(sheet.name, 256) || !integer(sheet.rows, 100000) || !integer(sheet.columns, 10000) || !Array.isArray(sheet.cells) || !Array.isArray(sheet.merges)) invalid();
      positions += sheet.rows * sheet.columns; cells += sheet.cells.length;
      if (positions > 150000 || cells > 150000 || sheet.merges.length > 20000) invalid();
      const coordinates = new Set();
      for (const c of sheet.cells) {
        if (!c || !integer(c.row, sheet.rows - 1) || !integer(c.column, sheet.columns - 1) || !isText(c.display) || !(c.value === null || typeof c.value === 'boolean' || typeof c.value === 'number' && Number.isFinite(c.value) || isText(c.value)) || !(c.formula === null || isText(c.formula))) invalid();
        const key = `${c.row}:${c.column}`;
        if (coordinates.has(key)) invalid(); coordinates.add(key);
      }
      for (const m of sheet.merges) {
        if (!m || !integer(m.row, sheet.rows - 1) || !integer(m.column, sheet.columns - 1) || !integer(m.rows, sheet.rows) || m.rows < 1 || !integer(m.columns, sheet.columns) || m.columns < 1 || m.row + m.rows > sheet.rows || m.column + m.columns > sheet.columns) invalid();
      }
    }
  }
  return s;
}

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, '0')).join('');
}

export async function serializeArchive(snapshot) {
  validateSnapshot(snapshot);
  const payload = JSON.stringify(snapshot);
  if (new TextEncoder().encode(payload).length > MAX_FILE_BYTES - 1000) throw new Error('ARCHIVE_TOO_LARGE');
  return JSON.stringify({ format: 'fdocpack', version: 1, status: 'PENDING', contentSha256: await sha256(payload), snapshot });
}

export async function parseArchive(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_FILE_BYTES) throw new Error('ARCHIVE_TOO_LARGE');
  let archive;
  try { archive = JSON.parse(text); } catch { throw new Error('ARCHIVE_INVALID'); }
  if (archive?.format !== 'fdocpack' || archive.version !== 1 || typeof archive.contentSha256 !== 'string') throw new Error('ARCHIVE_VERSION_UNSUPPORTED');
  validateSnapshot(archive.snapshot);
  if (await sha256(JSON.stringify(archive.snapshot)) !== archive.contentSha256) throw new Error('ARCHIVE_HASH_MISMATCH');
  return archive.snapshot;
}

export function fileName(title, suffix) {
  const clean = String(title || '未命名文档').normalize('NFC')
    .replace(/[\\/<>:"|?*\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '_')
    .replace(/^\.+/, '').replace(/[. ]+$/, '').slice(0, 72).trim();
  return `${clean || '未命名文档'}_部分归档.${suffix}`;
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, x => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[x]);
}

export function orderedBlocks(snapshot) {
  const blocks = snapshot.model.blocks, byId = new Map(blocks.map(b => [b.id, b]));
  const seen = new Set(), result = [];
  const roots = blocks.filter(b => !byId.has(b.parentId));
  // Iterative traversal also handles cycles and orphaned blocks without stack overflow.
  for (const root of [...roots, ...blocks]) {
    const stack = [{ block: root, depth: 0 }];
    while (stack.length) {
      const { block, depth } = stack.pop();
      if (!block || seen.has(block.id)) continue;
      seen.add(block.id); result.push({ block, depth: Math.min(depth, 8) });
      for (let i = block.children.length - 1; i >= 0; i--) stack.push({ block: byId.get(block.children[i]), depth: depth + 1 });
    }
  }
  return result;
}

export function renderPreview(snapshot) {
  validateSnapshot(snapshot);
  const h = escapeHtml;
  let body = '';
  if (snapshot.kind === 'document') {
    body = orderedBlocks(snapshot).map(({ block: b, depth }) => `<div class="block" style="margin-left:${depth * 12}px"><small>${h(b.type)}</small><div>${h(b.text || `［${b.type}：结构占位；资源或布局未重建］`)}</div></div>`).join('');
  } else {
    for (const s of snapshot.model.sheets) {
      const cells = s.cells.filter(c => c.value !== null && c.value !== '' || c.formula || c.display);
      body += `<h2>${h(s.name)}</h2><p>${s.rows} 行 × ${s.columns} 列；${cells.length} 个已捕获内容单元格。加载覆盖未知。</p><table><thead><tr><th>行</th><th>列</th><th>显示值</th><th>公式</th></tr></thead><tbody>`;
      body += cells.map(c => `<tr><td>${c.row + 1}</td><td>${c.column + 1}</td><td>${h(c.display)}</td><td>${h(c.formula || '')}</td></tr>`).join('');
      body += '</tbody></table>';
    }
  }
  const issues = snapshot.issues.map(x => `<li>${h(x.code)} · ${x.count}</li>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${h(snapshot.source.title)} · 部分归档预览</title><style>body{max-width:1040px;margin:48px auto;padding:0 24px;background:#f5f4ef;color:#222;font:16px/1.65 system-ui,sans-serif}header{border-bottom:1px solid #bbb;margin-bottom:24px}aside{padding:16px;background:#fff3cd;border-radius:12px}small{color:#696969}.block{border-bottom:1px solid #ddd;padding:10px 0}.block div,td{white-space:pre-wrap;overflow-wrap:anywhere}table{width:100%;border-collapse:collapse;margin:20px 0}th,td{border:1px solid #ccc;padding:8px;text-align:left;vertical-align:top}details{margin-top:32px}h1{line-height:1.3}</style></head><body><header><small>飞书本地归档 · 0.1.0</small><h1>${h(snapshot.source.title)}</h1><p>${h(snapshot.capturedAt)}</p></header><aside><strong>PENDING · 部分归档</strong><br>这是结构预览，尚未重建原排版。图片、附件和嵌入对象未归档；完整性与飞书恢复未验证。请保留源文件。</aside>${body}<details><summary>缺口与未验证项</summary><ul>${issues}</ul></details></body></html>`;
}

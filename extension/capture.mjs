// Self-contained: Chrome serializes this function into the page's MAIN world.
// The page is untrusted. Return data only; never execute page strings or fetch URLs.
export async function capturePage(options = {}) {
  const started = Date.now();
  const issues = new Map();
  const fail = (code) => { throw { captureCode: code }; };
  const note = (code, count = 1) => issues.set(code, (issues.get(code) || 0) + count);
  const bound = (condition, code = 'MODEL_SHAPE_CHANGED') => { if (!condition) fail(code); };
  let textBudget = 0;
  const str = (value, limit = 100000) => {
    bound(typeof value === 'string' && value.length <= limit, 'FIELD_LIMIT');
    textBudget += value.length;
    bound(textBudget <= 8000000, 'CONTENT_LIMIT');
    return value;
  };
  const scalar = (v) => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') return str(v);
    if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return v;
    note('NON_SCALAR_VALUE');
    return null;
  };
  const dimensions = (n, max) => Number.isInteger(n) && n >= 0 && n <= max;
  const tick = () => bound(Date.now() - started < 12000, 'CAPTURE_TIMEOUT');
  const id = (value) => typeof value === 'string' ? str(value, 256) : null;
  const captureTable = (record) => {
    const geometryKeys = ['rows_id', 'columns_id', 'column_set', 'cell_set'];
    const hasGeometry = geometryKeys.some(key => Object.prototype.hasOwnProperty.call(record, key));
    if (!hasGeometry) return null;
    bound(geometryKeys.every(key => Object.prototype.hasOwnProperty.call(record, key)));
    const rawRows = record.rows_id, rawColumns = record.columns_id;
    bound(Array.isArray(rawRows) && Array.isArray(rawColumns));
    bound(rawRows.length > 0 && rawColumns.length > 0 && rawRows.length <= 1000 && rawColumns.length <= 1000 && rawRows.length * rawColumns.length <= 20000);
    const rowIds = [], columnIds = [];
    const tableId = (value) => { bound(typeof value === 'string' && value.length > 0 && value.length <= 256); return str(value, 256); };
    for (let i = 0; i < rawRows.length; i++) rowIds.push(tableId(rawRows[i]));
    for (let i = 0; i < rawColumns.length; i++) columnIds.push(tableId(rawColumns[i]));
    const positions = new Map();
    for (let row = 0; row < rowIds.length; row++) for (let column = 0; column < columnIds.length; column++) {
      const key = rowIds[row] + columnIds[column];
      bound(!positions.has(key)); positions.set(key, { row, column });
    }
    const rawColumnSet = record.column_set, rawCellSet = record.cell_set;
    bound(rawColumnSet && typeof rawColumnSet === 'object' && !Array.isArray(rawColumnSet));
    bound(rawCellSet && typeof rawCellSet === 'object' && !Array.isArray(rawCellSet));
    const columnWidths = [];
    for (let column = 0; column < columnIds.length; column++) {
      const columnRecord = rawColumnSet[columnIds[column]];
      bound(columnRecord && typeof columnRecord === 'object' && !Array.isArray(columnRecord) && Object.prototype.hasOwnProperty.call(columnRecord, 'column_width'));
      const width = columnRecord.column_width;
      bound(width === null || (typeof width === 'number' && Number.isFinite(width) && width >= 0 && width <= 10000));
      columnWidths.push(width);
    }
    const cellKeys = Object.keys(rawCellSet);
    bound(cellKeys.length <= 20000);
    const cells = [];
    for (let i = 0; i < cellKeys.length; i++) {
      const key = cellKeys[i], position = positions.get(key);
      bound(position !== undefined);
      const cell = rawCellSet[key];
      bound(cell && typeof cell === 'object' && !Array.isArray(cell));
      const blockId = tableId(cell.block_id);
      const merge = cell.merge_info;
      bound(merge && typeof merge === 'object' && !Array.isArray(merge));
      const rowSpan = merge.row_span, columnSpan = merge.col_span;
      bound(Number.isInteger(rowSpan) && rowSpan >= 0 && rowSpan <= rowIds.length &&
        Number.isInteger(columnSpan) && columnSpan >= 0 && columnSpan <= columnIds.length);
      bound(rowSpan === 0 || position.row + rowSpan <= rowIds.length);
      bound(columnSpan === 0 || position.column + columnSpan <= columnIds.length);
      cells.push({ row: position.row, column: position.column, blockId, rowSpan, columnSpan });
    }
    return { rowIds, columnIds, columnWidths, headerRow: record.header_row === true, cells };
  };
  const pick = (source, names) => {
    const output = {};
    if (!source || typeof source !== 'object') return output;
    for (const key of names) {
      const v = source[key];
      if (v !== undefined && (v === null || ['string', 'number', 'boolean'].includes(typeof v))) output[key] = scalar(v);
    }
    return output;
  };
  try {
    const url = new URL(location.href);
    bound(url.protocol === 'https:' && /(^|\.)(feishu\.cn|larksuite\.com)$/.test(url.hostname), 'UNSUPPORTED_SOURCE');
    bound(/^\/(docx|docs|sheets|wiki|slides)\/[A-Za-z0-9_-]+\/?$/.test(url.pathname), 'UNSUPPORTED_SOURCE');
    const sourcePath = url.origin + url.pathname;
    bound(typeof options.expectedSource === 'string' && options.expectedSource === sourcePath, 'SOURCE_CHANGED');
    const title = str(document.title.replace(/\s*-\s*飞书云文档\s*$/, '').replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '').trim(), 1000);
    const snapshot = {
      schemaVersion: 1, adapterVersion: '0.1.0', kind: null,
      capturedAt: new Date().toISOString(), source: { url: sourcePath, title },
      fidelity: { status: 'PENDING', complete: false, authoritativeTotal: null, assets: 'PENDING', roundtrip: 'PENDING' },
      issues: [], model: null
    };
    note('COMPLETENESS_UNKNOWN'); note('SOURCE_REVISION_NOT_LOCKED');
    note('ASSET_BYTES_NOT_CAPTURED'); note('ROUNDTRIP_NOT_IMPLEMENTED');

    if (/^\/slides\//.test(url.pathname)) fail('SLIDES_ADAPTER_PENDING');
    if (Array.isArray(window.spread?.sheets)) {
      const rawSheets = window.spread.sheets;
      bound(rawSheets.length > 0 && rawSheets.length <= 100, 'SHEET_LIMIT');
      const all = [];
      let totalPositions = 0;
      for (let index = 0; index < rawSheets.length; index++) {
        tick();
        const s = rawSheets[index];
        for (const key of ['getRowCount', 'getColumnCount', 'getValue', 'getText', 'getFormula', 'getStyle', 'getSpans', 'getRowHeight', 'getColumnWidth']) {
          bound(typeof s[key] === 'function');
        }
        const rows = s.getRowCount(), columns = s.getColumnCount();
        bound(dimensions(rows, 100000) && dimensions(columns, 10000));
        totalPositions += rows * columns;
        bound(totalPositions <= 150000, 'CELL_RANGE_LIMIT');
        const sheet = { index, name: typeof s._name === 'string' ? str(s._name, 256) : `工作表 ${index + 1}`, rows, columns, cells: [], merges: [], rowHeights: [], columnWidths: [], loadCoverage: 'unknown' };
        if (typeof s._name !== 'string') note('SHEET_NAME_UNAVAILABLE');
        const styleKeys = ['_font', '_hAlign', '_vAlign', '_wordWrap', '_textDecoration', '_backColor', '_foreColor', '_formatter', '_textIndent'];
        for (let r = 0; r < rows; r++) {
          tick();
          sheet.rowHeights.push(scalar(s.getRowHeight(r)));
          for (let c = 0; c < columns; c++) {
            if (c % 100 === 0) tick();
            const value = s.getValue(r, c), formula = s.getFormula(r, c);
            const style = s.getStyle(r, c);
            const capturedStyle = pick(style, styleKeys);
            for (const edge of ['_borderTop', '_borderBottom', '_borderLeft', '_borderRight', '_diagonalUp', '_diagonalDown']) {
              if (style?.[edge]) capturedStyle[edge] = pick(style[edge], ['color', 'style', '_color', '_style']);
            }
            const hasValue = value !== undefined && value !== null && value !== '';
            const hasFormula = typeof formula === 'string' && formula.length > 0;
            if (hasValue || hasFormula || Object.keys(capturedStyle).length > 0) {
              const cell = { row: r, column: c, value: scalar(value), display: str(String(s.getText(r, c) ?? '')), formula: hasFormula ? str(formula) : null, style: capturedStyle };
              sheet.cells.push(cell);
            }
            if (formula !== null && formula !== undefined && typeof formula !== 'string') note('FORMULA_SHAPE_UNKNOWN');
          }
          if (r % 25 === 24) await new Promise(resolve => setTimeout(resolve, 0));
        }
        for (let c = 0; c < columns; c++) { if (c % 100 === 0) tick(); sheet.columnWidths.push(scalar(s.getColumnWidth(c))); }
        const spans = s.getSpans();
        bound(Array.isArray(spans) && spans.length <= 20000);
        const merges = [];
        for (let i = 0; i < spans.length; i++) {
          const x = spans[i];
          bound(x && typeof x === 'object');
          const hasNativeRange = x.startRow !== undefined || x.endRow !== undefined || x.startCol !== undefined || x.endCol !== undefined;
          let row, column, rowCount, columnCount;
          if (hasNativeRange) {
            bound(dimensions(x.startRow, rows) && dimensions(x.endRow, rows) && x.endRow > x.startRow &&
              dimensions(x.startCol, columns) && dimensions(x.endCol, columns) && x.endCol > x.startCol);
            row = x.startRow; column = x.startCol;
            rowCount = x.endRow - x.startRow; columnCount = x.endCol - x.startCol;
          } else {
            bound(dimensions(x.row, rows) && dimensions(x.col, columns) && Number.isInteger(x.rowCount) && x.rowCount > 0 && Number.isInteger(x.colCount) && x.colCount > 0 && x.row + x.rowCount <= rows && x.col + x.colCount <= columns);
            row = x.row; column = x.col; rowCount = x.rowCount; columnCount = x.colCount;
          }
          merges.push({ row, column, rows: rowCount, columns: columnCount });
        }
        sheet.merges = merges;
        if (!sheet.cells.some(c => c.value !== null && c.value !== '' || c.formula)) note('EMPTY_OR_UNLOADED_SHEET');
        all.push(sheet);
      }
      bound(window.spread.sheets.length === all.length, 'SOURCE_CHANGED');
      snapshot.kind = 'sheet'; snapshot.model = { sheets: all };
      note('SHEET_LOAD_COVERAGE_UNKNOWN'); note('ADVANCED_SHEET_FEATURES_NOT_CAPTURED');
      if (!all.some(s => s.cells.some(c => c.formula))) note('FORMULA_COVERAGE_UNVERIFIED');
    } else {
      const service = window.PageMain?.editor?.editor?.api?.modelService;
      const rawBlocks = service?.allBlockModels;
      bound(Array.isArray(rawBlocks) && rawBlocks.length > 0, 'MODEL_UNAVAILABLE');
      bound(rawBlocks.length <= 10000, 'BLOCK_LIMIT');
      const blocks = [], ids = new Set();
      const embedded = new Set(['image', 'file', 'whiteboard', 'bitable', 'view', 'fallback']);
      const common = new Set(['page', 'text', 'heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6', 'heading7', 'heading8', 'heading9', 'bullet', 'ordered', 'todo', 'code', 'quote', 'callout', 'divider', 'table', 'table_cell', 'grid', 'grid_column']);
      for (let i = 0; i < rawBlocks.length; i++) {
        tick();
        const b = rawBlocks[i], record = b?.struct?.record?.snapshot;
        bound(record && typeof record === 'object' && typeof b.type === 'string');
        bound(!b.isError && !b.isDestroyed, 'BLOCK_NOT_READY');
        const hasRecordId = 'id' in b.struct.record;
        const blockId = hasRecordId ? id(b.struct.record.id) : id(b.struct.id);
        bound(blockId && !ids.has(blockId), 'BLOCK_ID_INVALID'); ids.add(blockId);
        const hasChildren = Object.prototype.hasOwnProperty.call(record, 'children');
        const children = hasChildren ? record.children : [];
        if (!hasChildren) note('CHILD_REFERENCES_NOT_PROVIDED');
        bound(Array.isArray(children) && children.length <= 10000);
        const childIds = [];
        for (let childIndex = 0; childIndex < children.length; childIndex++) {
          const value = id(children[childIndex]); bound(value); childIds.push(value);
        }
        const block = { id: blockId, type: str(b.type, 64), parentId: id(record.parent_id), children: childIds, text: '', richText: null, properties: pick(record, ['align', 'folded', 'hidden', 'checked', 'language', 'background_color', 'width_ratio']) };
        if (block.type === 'table') {
          const table = captureTable(record);
          if (table) block.table = table;
          else note('BLOCK_LAYOUT_NOT_CAPTURED');
        }
        if (record.text !== undefined) {
          const initial = record.text?.initialAttributedTexts;
          if (initial && typeof initial.text === 'object' && initial.text !== null) {
            const segments = Object.keys(initial.text);
            bound(segments.length <= 10000 && segments.every(k => /^(0|[1-9]\d*)$/.test(k)), 'TEXT_SHAPE_CHANGED');
            const text = {}, attribs = {}, attributes = {};
            segments.sort((a, b) => Number(a) - Number(b));
            for (const key of segments) {
              text[key] = str(initial.text[key]);
              if (typeof initial.attribs?.[key] === 'string') attribs[key] = str(initial.attribs[key]);
            }
            const pool = record.text.apool?.numToAttrib;
            if (pool && typeof pool === 'object') {
              const keys = Object.keys(pool); bound(keys.length <= 10000, 'ATTRIBUTE_LIMIT');
              const formatAttributes = new Set(['bold', 'italic', 'underline', 'strikethrough', 'code', 'link', 'fontSize', 'font-size', 'fontFamily', 'font-family', 'textColor', 'text-color', 'textHighlight', 'textHighlightColor', 'textHighlightBackground', 'text-background-color', 'background-color', 'color', 'superscript', 'subscript']);
              for (const key of keys) {
                const pair = pool[key];
                if (/^(0|[1-9]\d*)$/.test(key) && Array.isArray(pair) && pair.length === 2 && formatAttributes.has(pair[0]) && typeof pair[1] === 'string') {
                  // Attribute names/values are inert data and never copied into HTML.
                  let value = pair[1];
                  if (pair[0] === 'link') {
                    try { const u = new URL(value); if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) { note('RICH_TEXT_ATTRIBUTE_UNMAPPED'); continue; } value = u.origin + u.pathname; if (u.search || u.hash) note('LINK_DETAILS_NOT_CAPTURED'); }
                    catch { note('RICH_TEXT_ATTRIBUTE_UNMAPPED'); continue; }
                  }
                  attributes[key] = [str(pair[0], 256), str(value)];
                } else if (Array.isArray(pair) && (pair[0] === 'author' || /^comment-id(?:-|$)/.test(String(pair[0])))) {
                  // Authorship/comments are intentionally excluded, not a rendering failure.
                } else note('RICH_TEXT_ATTRIBUTE_UNMAPPED');
              }
            }
            block.text = segments.map(k => text[k]).join('');
            block.richText = { text, attribs, attributes, encoding: 'feishu-attributed-text-uninterpreted' };
          } else if (typeof record.text === 'string') block.text = str(record.text);
          else note('TEXT_SHAPE_UNKNOWN');
        }
        if (['image','file'].includes(block.type)) {
          const resource = record[block.type];
          if (resource && typeof resource === 'object' && typeof resource.token === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(resource.token)) {
            block.resource = {kind:block.type, resourceId:str(resource.token,128), ...pick(resource,['mimeType','size','name','width','height','rotation','scale'])};
            if (Array.isArray(resource.crop) && resource.crop.length === 4) {
              block.resource.crop=[];
              for (let j=0;j<4;j++) { bound(typeof resource.crop[j] === 'number' && Number.isFinite(resource.crop[j])); block.resource.crop.push(resource.crop[j]); }
            }
          } else note('RESOURCE_DESCRIPTOR_UNAVAILABLE');
        } else if (['whiteboard','bitable'].includes(block.type)) {
          const resourceId = typeof record.token === 'string' ? record.token : record[block.type]?.token;
          if (typeof resourceId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(resourceId)) block.resource={kind:block.type,resourceId:str(resourceId,128),...pick(record,['width','height'])};
          else note('RESOURCE_DESCRIPTOR_UNAVAILABLE');
        }
        if (embedded.has(block.type) && block.type !== 'view') note('EMBEDDED_CONTENT_NOT_CAPTURED');
        else if (!common.has(block.type)) note('UNKNOWN_BLOCK_TYPE');
        if (['grid', 'grid_column'].includes(block.type)) note('BLOCK_LAYOUT_NOT_CAPTURED');
        blocks.push(block);
        if (i % 200 === 199) await new Promise(resolve => setTimeout(resolve, 0));
      }
      for (const b of blocks) for (const child of b.children) if (!ids.has(child)) note('UNRESOLVED_CHILD');
      for (const b of blocks) if (b.table) for (const cell of b.table.cells) bound(ids.has(cell.blockId));
      bound(service.allBlockModels.length === blocks.length, 'SOURCE_CHANGED');
      snapshot.kind = 'document'; snapshot.model = { blocks, rootIds: blocks.filter(b => !ids.has(b.parentId)).map(b => b.id) };
      note('RICH_TEXT_RENDERING_PENDING');
    }
    bound(location.origin + location.pathname === sourcePath, 'SOURCE_CHANGED');
    snapshot.issues = [...issues].map(([code, count]) => ({ code, count }));
    bound(JSON.stringify(snapshot).length <= 12000000, 'PAYLOAD_LIMIT');
    tick();
    return { ok: true, snapshot };
  } catch (error) {
    const known = new Set(['UNSUPPORTED_SOURCE', 'SLIDES_ADAPTER_PENDING', 'MODEL_UNAVAILABLE', 'MODEL_SHAPE_CHANGED', 'BLOCK_LIMIT', 'BLOCK_ID_INVALID', 'BLOCK_NOT_READY', 'CELL_RANGE_LIMIT', 'SHEET_LIMIT', 'FIELD_LIMIT', 'CONTENT_LIMIT', 'CAPTURE_TIMEOUT', 'SOURCE_CHANGED', 'TEXT_SHAPE_CHANGED', 'ATTRIBUTE_LIMIT', 'PAYLOAD_LIMIT']);
    return { ok: false, code: known.has(error?.captureCode) ? error.captureCode : 'PAGE_READ_FAILED' };
  }
}

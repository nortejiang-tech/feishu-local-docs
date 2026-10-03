export function makeDemo(kind = 'document') {
  const common = {
    schemaVersion: 1, adapterVersion: '0.1.0', kind, capturedAt: '2026-10-01T08:00:00.000Z',
    source: { title: kind === 'sheet' ? '季度计划 · 合成表格' : '把知识留在本地 · 合成文档', url: 'https://example.feishu.cn/docx/SyntheticDemo' },
    fidelity: { status: 'PENDING', complete: false, authoritativeTotal: null, assets: 'PENDING', roundtrip: 'PENDING' },
    issues: [{ code: 'SYNTHETIC_DEMO', count: 1 }, { code: 'COMPLETENESS_UNKNOWN', count: 1 }, { code: 'ASSET_BYTES_NOT_CAPTURED', count: 1 }, { code: 'ROUNDTRIP_NOT_IMPLEMENTED', count: 1 }]
  };
  if (kind === 'sheet') {
    const cell = (row, column, value, formula = null) => ({ row, column, value, display: String(value ?? ''), formula, style: {} });
    common.model = { sheets: [
      { name: '季度计划', index: 0, rows: 10, columns: 4, cells: [cell(0, 0, '项目'), cell(0, 1, '目标'), cell(1, 0, '文档'), cell(1, 1, 12), cell(2, 0, '表格'), cell(2, 1, 8), cell(3, 0, '总计'), cell(3, 1, 20, '=SUM(B2:B3)')], merges: [], rowHeights: [], columnWidths: [], loadCoverage: 'unknown' },
      { name: '下一阶段', index: 1, rows: 8, columns: 3, cells: [cell(0, 0, '幻灯片适配器待接入')], merges: [], rowHeights: [], columnWidths: [], loadCoverage: 'unknown' }
    ] };
  } else {
    const block = (id, type, text, children = [], parentId = 'root') => ({ id, type, text, children, parentId, properties: {}, richText: null });
    common.model = { rootIds: ['root'], blocks: [
      block('root', 'page', '', ['title', 'intro', 'list', 'board'], null),
      block('title', 'heading1', '每一份知识，都值得被好好保存。'),
      block('intro', 'text', '这是合成演示内容，用于检查本地归档界面与下载流程。真实页面必须由你主动点击采集。'),
      block('list', 'bullet', '保留内容、结构与尚待解决的问题'),
      block('board', 'whiteboard', '')
    ] };
    common.issues.push({ code: 'EMBEDDED_CONTENT_NOT_CAPTURED', count: 1 });
  }
  return common;
}

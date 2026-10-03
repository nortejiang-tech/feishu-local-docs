import { createDocument, updateContent } from '../../shared/model.mjs';

/** Create fresh, independent starter files for an empty local library. */
export function createStarterDocuments() {
  const guide = createDocument('document', '使用指南');
  guide.content = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '把文档留在自己手里。' }] },
      { type: 'paragraph', content: [{ type: 'text', text: '在本地打开、编辑和保存你的文档。无需联网，也能继续工作。' }] },
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '从这里开始' }] },
      { type: 'paragraph', content: [{ type: 'text', text: '点击左侧新建，开始一份文档或电子表格。修改会在短暂停顿后自动保存到本地。你也可以打开本地文件，或保存一份可移动的副本。' }] },
      {
        type: 'table',
        content: [
          { type: 'tableRow', content: [{ type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: '功能' }] }] }, { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: '使用方式' }] }] }] },
          { type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '打开' }] }] }, { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '选择本地 .localdoc 文件' }] }] }] },
          { type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '保存' }] }] }, { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '修改后自动保存，也可保存副本' }] }] }] },
          { type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '飞书恢复' }] }] }, { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '创建副本后仍需检查保真结果' }] }] }] },
        ],
      },
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '关于内容完整性' }] },
      { type: 'paragraph', content: [{ type: 'text', text: '文档和电子表格支持基础编辑。飞书中的复杂布局或暂不支持的结构可能以保留内容呈现；遇到转换提示时，请检查原始内容和本地副本。' }] },
    ],
  };
  // Re-validate the directly populated seed through the model's canonical validator.
  // updateContent also advances revision so normal save tracking treats this as an edit.
  const guideContent = guide.content;
  guide.content = { type: 'doc', content: [{ type: 'paragraph' }] };
  const guideWithContent = updateContent(guide, guideContent);

  const project = createDocument('sheet', '项目计划');
  const sheetId = project.content.sheetOrder[0];
  const sheet = project.content.sheets[sheetId];
  const values = [
    ['任务', '负责人', '状态', '预计天数'],
    ['需求梳理', '项目组', '进行中', 2],
    ['交互设计', '设计', '待开始', 3],
    ['开发与检查', '开发', '待开始', 5],
    ['预计合计', '', '', 10],
  ];
  const cellData = Object.fromEntries(values.map((row, r) => [r, Object.fromEntries(row.map((v, c) => [c, { v }]))]));
  cellData[4][3] = { v: 10, f: '=SUM(D2:D4)' };
  const projectWithContent = updateContent(project, {
    ...project.content,
    sheets: { ...project.content.sheets, [sheetId]: { ...sheet, cellData } },
  });
  return [guideWithContent, projectWithContent];
}

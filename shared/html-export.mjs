import {validateDocument, safeFileName, MAX_FILE_BYTES} from './model.mjs';
import {buildSheetLayout} from './html-sheet-layout.mjs';
import {buildWhiteboardScene} from './whiteboard-scene.mjs';
import {buildBaseGrid} from './base-grid.mjs';
import {baseDateInput} from './base-date.mjs';

// No captured markup, URLs, CSS declarations or scripts are passed through.
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const numeric = (value, fallback, max = 10000) => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= max ? value : fallback;
const imageData = value => typeof value === 'string' && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]*={0,2}$/.test(value) ? value : null;
const color = value => typeof value === 'string' && /^(?:#[\da-f]{3,8}|[a-z]{1,24}|rgba?\([\d.,% ]+\))$/i.test(value) ? value : null;
const family = value => typeof value === 'string' && /^[\p{L}\p{N} _,-]{1,128}$/u.test(value) ? value : null;
const align = value => ['left','right','center','justify'].includes(value) ? value : null;
const address = (r,c) => { let col=''; for(let n=c+1;n;n=Math.floor((n-1)/26))col=String.fromCharCode(65+(n-1)%26)+col; return col+(r+1); };
const attrStyle = css => css ? ` style="${esc(css)}"` : '';
const warn = (ctx, message) => ctx.warnings.add(message);
const missing = (ctx, label) => { ctx.missing++; warn(ctx,'存在未取得或未支持的内容，已在对应位置标注。'); return `<aside class="missing">未完整保存：${esc(label)}</aside>`; };

function fontCss(attrs = {}, ctx) {
  const css=[];
  for(const [key,prop] of [['color','color'],['backgroundColor','background-color']]) {
    if(attrs[key] != null) { const v=color(attrs[key]); if(v)css.push(`${prop}:${v}`); else warn(ctx,'部分颜色无法转换。'); }
  }
  if(attrs.fontFamily != null) { const v=family(attrs.fontFamily); if(v)css.push(`font-family:${v}`); else warn(ctx,'部分字体无法转换。'); }
  if(attrs.fontSize != null) {
    const match=/^(\d+(?:\.\d+)?)(px|pt)$/.exec(String(attrs.fontSize));
    if(match && Number(match[1])>0 && Number(match[1])<=200)css.push(`font-size:${match[1]}${match[2]}`);
    else if(numeric(attrs.fontSize,null,200))css.push(`font-size:${attrs.fontSize}px`);
    else warn(ctx,'部分字号无法转换。');
  }
  return css.join(';');
}
function marksHtml(node, ctx) {
  let out=esc(node.text);
  for(const mark of node.marks || []) {
    const tag={bold:'strong',italic:'em',underline:'u',strike:'s',code:'code'}[mark.type];
    if(tag)out=`<${tag}>${out}</${tag}>`;
    else if(['textStyle','color'].includes(mark.type))out=`<span${attrStyle(fontCss(mark.attrs,ctx))}>${out}</span>`;
    else warn(ctx,'部分文字样式无法转换。');
  }
  return out;
}
function whiteboardHtml(attrs, ctx) {
  const scene=buildWhiteboardScene(attrs.payload), b=scene.bounds;
  warn(ctx,'画板为基础静态预览；复杂形状、旋转、连线及文字样式未完整还原。');
  const images=new Map((attrs.images || []).map(x=>[x.resourceId,imageData(x.dataUrl)]));
  const items=scene.items.map(item=>{
    const source=images.get(item.resourceId);
    const graphic=source ? `<image href="${esc(source)}" x="${item.x}" y="${item.y}" width="${item.width}" height="${item.height}"/>`
      : `<rect x="${item.x}" y="${item.y}" width="${item.width}" height="${item.height}" fill="#f5f6f8" stroke="#9ba2ad"/>`;
    if(source)ctx.images++;
    if(item.kind==='image'&&!source) { ctx.missing++; warn(ctx,'画板内有图片未取得。'); }
    // Full text also appears below; the drawing preview must not be mistaken for exact layout.
    const label=item.text || (item.kind==='image'&&!source?'图片未保存':'');
    return graphic+(label?`<text x="${item.x+4}" y="${item.y+18}" font-size="14">${esc(label)}</text>`:'');
  }).join('');
  if(scene.omittedCount)warn(ctx,`画板中 ${scene.omittedCount} 个节点无法加入预览。`);
  return `<figure class="board"><figcaption>画板 · 基础预览（布局待核对）</figcaption><svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="画板基础预览" viewBox="${b.x-8} ${b.y-8} ${b.width+16} ${b.height+16}">${items}</svg><details><summary>画板中的完整文字</summary>${scene.items.filter(x=>x.text).map(x=>`<p>${esc(x.text)}</p>`).join('')}</details></figure>`;
}
function baseHtml(attrs, ctx) {
  const payload=attrs.payload, table=payload.table;
  const grid=buildBaseGrid(payload,table.currentView);
  warn(ctx,'多维表格导出为静态数据表；甘特图、筛选、分组等视图布局未完整还原。');
  if(grid.columns.length!==Object.keys(table.fieldMap).length || grid.rows.length!==Object.keys(table.recordMap).length)throw Error('HTML_GRID_TOO_LARGE');
  if(table.meta?.recordsNum!=null && table.meta.recordsNum!==grid.rows.length)warn(ctx,'多维表格读取记录数与原表声明数量不一致。');
  if(grid.unsupportedCells)warn(ctx,`多维表格中 ${grid.unsupportedCells} 个单元格暂不支持显示。`);
  ctx.positions+=grid.columns.length*grid.rows.length;
  if(ctx.positions>150000)throw Error('HTML_GRID_TOO_LARGE');
  return `<section class="base"><h3>多维表格 · 静态数据</h3><div class="table-scroll"><table><thead><tr>${grid.columns.map(c=>`<th>${esc(c.name)}</th>`).join('')}</tr></thead><tbody>${grid.rows.map(row=>`<tr>${row.cells.map((cell,index)=>{
    let value=cell.display;const col=grid.columns[index];
    if(col.type===5&&cell.value!==null)try{value=baseDateInput(cell.value,payload.sourceTimezone||Intl.DateTimeFormat().resolvedOptions().timeZone,!table.fieldMap[col.id].property?.timeFormat).replace('T',' ');}catch{warn(ctx,'部分日期按 UTC 原值显示。');}
    return `<td>${esc(value)}</td>`;
  }).join('')}</tr>`).join('')}</tbody></table></div></section>`;
}
function documentNode(node,ctx) {
  const a=node.attrs||{}, children=()=> (node.content||[]).map(n=>documentNode(n,ctx)).join('');
  if(node.type==='text')return marksHtml(node,ctx);
  if(node.type==='doc')return children();
  if(node.type==='preservedBlock')return missing(ctx,a.label || a.sourceType || '未知区块');
  if(node.type==='localWhiteboard')return whiteboardHtml(a,ctx);
  if(node.type==='localBase')return baseHtml(a,ctx);
  if(node.type==='image') {
    const src=imageData(a.src); if(!src)return missing(ctx,a.alt||'图片'); ctx.images++;
    const dims=[['width',a.width],['height',a.height]].filter(([,v])=>numeric(v,null)).map(([k,v])=>` ${k}="${v}"`).join('');
    return `<img src="${esc(src)}" alt="${esc(a.alt)}" title="${esc(a.title)}"${dims}>`;
  }
  if(node.type==='horizontalRule')return '<hr>';
  if(node.type==='hardBreak')return '<br>';
  if(node.type==='columnLayout')return `<div class="columns">${children()}</div>`;
  if(node.type==='column')return `<div class="column" style="flex:${numeric(a.widthRatio,1,1)} 1 0">${children()}</div>`;
  if(node.type==='codeBlock')return `<pre><code>${children()}</code></pre>`;
  if(node.type==='table') {ctx.tables++;return `<div class="table-scroll"><table class="document-table"${attrStyle(numeric(a.width,null)?`width:${a.width}px`:'')}>${children()}</table></div>`;}
  if(['tableCell','tableHeader'].includes(node.type)) {
    const tag=node.type==='tableHeader'?'th':'td',css=[];
    if(color(a.backgroundColor))css.push(`background-color:${a.backgroundColor}`);
    if(Array.isArray(a.colwidth)&&a.colwidth.every(v=>numeric(v,null)))css.push(`width:${a.colwidth.reduce((sum,n)=>sum+n,0)}px`);
    return `<${tag} colspan="${Math.floor(numeric(a.colspan,1,1000))}" rowspan="${Math.floor(numeric(a.rowspan,1,1000))}"${attrStyle(css.join(';'))}>${children()}</${tag}>`;
  }
  const tags={paragraph:'p',heading:`h${a.level}`,bulletList:'ul',orderedList:'ol',listItem:'li',taskList:'ul',taskItem:'li',blockquote:'blockquote',tableRow:'tr'};
  const tag=tags[node.type];
  if(!tag)return missing(ctx,node.type)+children();
  let attributes=attrStyle(align(a.textAlign||a.alignment)?`text-align:${a.textAlign||a.alignment}`:'');
  if(node.type==='heading') {const id=`heading-${ctx.headings.length+1}`;ctx.headings.push({id,text:plainText(node)});attributes+=` id="${id}"`;}
  if(node.type==='orderedList')attributes+=` start="${Math.floor(numeric(a.start,1,100000))}"`;
  if(node.type==='taskList')attributes+=' class="tasks"';
  return `<${tag}${attributes}>${node.type==='taskItem'?(a.checked?'☑ ':'☐ '):''}${children()}</${tag}>`;
}
function plainText(node) { return node.type==='text'?node.text:(node.content||[]).map(plainText).join(''); }

function sheetCss(style,ctx) {
  if(!style||typeof style!=='object')return '';
  const css=[fontCss({color:style.cl?.rgb,backgroundColor:style.bg?.rgb,fontFamily:style.ff,fontSize:style.fs},ctx)];
  if(style.bl)css.push('font-weight:bold');if(style.it)css.push('font-style:italic');
  const decorations=[];if(style.ul?.s)decorations.push('underline');if(style.st?.s)decorations.push('line-through');
  if(decorations.length)css.push(`text-decoration:${decorations.join(' ')}`);
  const h={1:'left',2:'center',3:'right',4:'justify',5:'justify',6:'justify'}[style.ht],v={1:'top',2:'middle',3:'bottom'}[style.vt];
  if(h)css.push(`text-align:${h}`);if(v)css.push(`vertical-align:${v}`);
  css.push(style.tb===3?'white-space:pre-wrap;overflow-wrap:anywhere':'white-space:pre');
  for(const [side,prop] of [['t','top'],['r','right'],['b','bottom'],['l','left']]) {
    const border=style.bd?.[side];if(!border)continue;
    const type={0:'none',1:'solid',2:'solid',3:'dotted',4:'dashed',5:'dashed',6:'dashed',7:'double',8:'solid',9:'dashed',10:'dashed',11:'dashed',12:'dashed',13:'solid'}[border.s];
    if(type)css.push(`border-${prop}:${border.s===7||border.s===13?3:border.s>=8?2:1}px ${type} ${color(border.cl?.rgb)||'#808080'}`);
    else warn(ctx,'部分表格边框样式未支持。');
    if([2,5,6,9,10,11,12].includes(border.s))warn(ctx,'部分特殊边框已用相近线型显示。');
  }
  if(Object.keys(style).some(k=>!['ff','fs','bl','it','ul','st','cl','bg','ht','vt','tb','n','bd'].includes(k)))warn(ctx,'部分电子表格高级样式未转换。');
  return css.filter(Boolean).join(';');
}
function cellText(cell, raw, style, ctx) {
  if(!cell)return '';
  if(cell.p) { warn(ctx,'电子表格富文本使用纯文字显示，样式待核对。'); const text=cell.p.body?.dataStream; if(typeof text==='string')return text.replace(/\r?\n$/,''); }
  if(cell.f)warn(ctx,'公式已保存为静态结果，不会在 HTML 中重新计算。');
  const importedValue=raw?.value===null ? raw.display||undefined : raw?.value;
  // Use original formatting only while both value/formula and number format agree.
  if(raw && typeof raw.display==='string' && raw.display!=='' && Object.is(cell.v,importedValue) && (cell.f||null)===(raw.formula||null) && (style?.n?.pattern||null)===(raw.style?._formatter||null))return raw.display;
  if(style?.n?.pattern && style.n.pattern!=='General')warn(ctx,'部分数字格式缺少原显示值，已保留当前数值。');
  if(cell.v!==null&&cell.v!==undefined)return typeof cell.v==='boolean'?(cell.v?'TRUE':'FALSE'):String(cell.v);
  if(cell.f) {warn(ctx,'部分公式缺少结果，已显示公式文本。');return cell.f;}
  return '';
}
function workbookHtml(doc,ctx) {
  const book=doc.content;
  if(book.resources?.length)warn(ctx,'工作簿中的高级对象或插件数据未加入 HTML。');
  if(book.defaultStyle)warn(ctx,'工作簿默认样式未完整转换，当前使用单元格样式。');
  return book.sheetOrder.map((id,index)=>{
    const sheet=book.sheets[id],layout=buildSheetLayout(sheet,150000-ctx.positions);ctx.positions+=layout.positions;
    if(sheet.defaultStyle || Object.values(sheet.rowData||{}).some(v=>v?.s) || Object.values(sheet.columnData||{}).some(v=>v?.s))warn(ctx,'工作表默认样式或整行整列样式未完整转换，当前使用单元格样式。');
    if(sheet.backgroundImage || sheet.resources?.length || sheet.custom)warn(ctx,'工作表的背景或高级对象未加入 HTML。');
    if(sheet.freeze?.xSplit || sheet.freeze?.ySplit)warn(ctx,'HTML 使用连续表格布局，不保留冻结行列交互。');
    const captureIndex=/^sheet-([1-9]\d*)$/.exec(id);
    const original=captureIndex?doc.provenance.capture?.model?.sheets?.[Number(captureIndex[1])-1]:null;
    const raw=new Map((original?.cells||[]).map(c=>[`${c.row}:${c.column}`,c]));
    const cellStyle=cell=>typeof cell?.s==='string'?book.styles[cell.s]:cell?.s;
    const display=(cell,r,c)=>cellText(cell,raw.get(`${r}:${c}`),cellStyle(cell),ctx);
    const className=cell=>{
      const css=sheetCss(cellStyle(cell),ctx);if(!css)return '';
      if(!ctx.styles.has(css))ctx.styles.set(css,`s${ctx.styles.size}`);
      return ` class="${ctx.styles.get(css)}"`;
    };
    const widths=Array.from({length:sheet.columnCount},(_,c)=>numeric(sheet.columnData?.[c]?.w,numeric(sheet.defaultColumnWidth,100)));
    if(sheet.hidden || Object.values(sheet.rowData||{}).some(v=>v?.hd||v?.h===0) || Object.values(sheet.columnData||{}).some(v=>v?.hd||v?.w===0))warn(ctx,'隐藏工作表或行列已展开，便于离线查看全部内容。');
    const rows=layout.rows.map((cells,r)=>`<tr style="height:${numeric(sheet.rowData?.[r]?.h,numeric(sheet.defaultRowHeight,24))}px">${cells.map(({column:c,rowspan,colspan,cell})=>`<td data-cell="${address(r,c)}" rowspan="${rowspan}" colspan="${colspan}"${className(cell)}${cell?.f?` title="公式：${esc(cell.f)}"`:''}>${esc(display(cell,r,c))}</td>`).join('')}</tr>`).join('');
    let hidden='';
    if(layout.coveredCells.length) {
      warn(ctx,'合并区域内的隐藏值已另列，未丢弃。');
      hidden=`<details><summary>合并区域内的隐藏值（${layout.coveredCells.length} 项）</summary><ul>${layout.coveredCells.map(({row,column,cell})=>`<li>${address(row,column)}：${esc(display(cell,row,column))}</li>`).join('')}</ul></details>`;
    }
    ctx.sheets++;ctx.merges+=sheet.mergeData.length;
    ctx.headings.push({id:`sheet-${index}`,text:sheet.name});
    return `<section class="sheet" id="sheet-${index}"><h2>${esc(sheet.name)}</h2><p class="meta">${sheet.rowCount} 行 × ${sheet.columnCount} 列</p><div class="table-scroll"><table class="sheet-grid" style="width:${widths.reduce((a,b)=>a+b,0)}px"><colgroup>${widths.map(w=>`<col style="width:${w}px">`).join('')}</colgroup><tbody>${rows}</tbody></table></div>${hidden}</section>`;
  }).join('');
}

const css=`*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;color:#1f2329;background:#f4f6f9;font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}header,main,nav{margin:24px auto;max-width:1120px;padding:24px 36px;background:white;border-radius:10px}header h1{font-size:26px;margin:0 0 12px}.meta{color:#697586;font-size:13px}nav a{display:inline-block;margin:4px 18px 4px 0;color:#2864df;text-decoration:none}h1,h2,h3,h4,h5,h6{line-height:1.35;scroll-margin-top:20px}p{white-space:pre-wrap;overflow-wrap:anywhere;margin:12px 0}blockquote{border-left:3px solid #b7c3d5;margin-left:0;padding:4px 20px;color:#576579}pre{background:#f6f7f9;padding:16px;white-space:pre-wrap;overflow-wrap:anywhere}code{font-family:monospace}img{max-width:100%;height:auto}table{border-collapse:collapse}th,td{border:1px solid #c6cbd3;padding:5px 8px;white-space:pre-wrap;vertical-align:top}th{background:#f0f3f7;text-align:left}td p,th p{margin:4px 0}.document-table{min-width:50%;width:100%}.table-scroll{overflow:auto;max-width:100%;margin:12px 0}.sheet-grid{table-layout:fixed;font:11pt Arial,sans-serif}.sheet-grid td{padding:2px 4px;vertical-align:middle;overflow:hidden}.sheet{margin:0 0 40px}.missing,.warning{border:1px solid #e9c37a;background:#fffbef;padding:12px 16px;border-radius:6px;margin:16px 0}.warning ul{margin:8px 0}details{margin:12px 0}summary{cursor:pointer}.columns{display:flex;gap:24px}.column{min-width:0}.tasks{list-style:none;padding-left:12px}.board{margin:16px 0}.board svg{width:100%;max-height:700px;border:1px solid #d5dae2}figcaption{font-size:13px;color:#667085}hr{border:0;border-top:1px solid #d5dae2;margin:24px 0}@media(max-width:700px){header,main,nav{padding:16px;margin:12px}.columns{overflow:auto}}@media print{body{background:white}header,main,nav{max-width:none;padding:0;border-radius:0}nav{display:none}.table-scroll{overflow:visible}.sheet{break-before:page}}`;

export function buildHtmlFile(doc) {
  validateDocument(doc);
  if(!['document','sheet'].includes(doc.kind))throw Error('HTML_KIND_UNSUPPORTED');
  const ctx={warnings:new Set(),styles:new Map(),headings:[],images:0,missing:0,tables:0,sheets:0,positions:0,merges:0};
  if(doc.issues.some(x=>x.count>0))warn(ctx,'源文件采集尚有未确认项；HTML 只能保留已取得的内容，不能补回未加载的资源。');
  const body=doc.kind==='sheet'?workbookHtml(doc,ctx):documentNode(doc.content,ctx);
  const warnings=[...ctx.warnings];
  const notice=warnings.length?`<aside class="warning" role="note"><strong>保存范围与待核对项</strong><ul>${warnings.map(w=>`<li>${esc(w)}</li>`).join('')}</ul></aside>`:'';
  const toc=ctx.headings.length?`<nav aria-label="目录">${ctx.headings.map(h=>`<a href="#${h.id}">${esc(h.text)}</a>`).join('')}</nav>`:'';
  const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"><meta name="generator" content="LocalDocs HTML"><title>${esc(doc.title)}</title><style>${css}\n${[...ctx.styles].map(([value,name])=>`.${name}{${value}}`).join('\n')}</style></head><body><header><h1>${esc(doc.title)}</h1><p class="meta">离线阅读副本 · 内容更新于 ${esc(doc.updatedAt)} · 使用本机字体</p>${notice}</header>${toc}<main>${body}</main></body></html>`;
  if(new TextEncoder().encode(html).byteLength>MAX_FILE_BYTES)throw Error('HTML_TOO_LARGE');
  return {html,name:safeFileName(doc.title).replace(/\.localdoc$/,'.html'),warnings,stats:{images:ctx.images,missing:ctx.missing,tables:ctx.tables,sheets:ctx.sheets,positions:ctx.positions,merges:ctx.merges}};
}

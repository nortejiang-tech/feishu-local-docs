import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocument} from '../shared/model.mjs';
import {buildHtmlFile} from '../shared/html-export.mjs';

const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const text=s=>({type:'text',text:s});
const p=s=>({type:'paragraph',content:[text(s)]});
function book() {
  const doc=createDocument('sheet','Workbook');
  doc.content.sheetOrder=['sheet-1','sheet-2'];
  doc.content.sheets=Object.fromEntries(doc.content.sheetOrder.map(id=>[id,{id,name:id,rowCount:3,columnCount:3,cellData:{},mergeData:[],rowData:{},columnData:{}}]));
  return doc;
}
test('document exports full text, marks, lists, nested tables, image bytes and columns without mutation',()=>{
  const doc=createDocument('document','Offline');
  doc.content.content=[{type:'heading',attrs:{level:2},content:[text('Heading')]},{type:'paragraph',attrs:{textAlign:'center'},content:[{...text('Bold'),marks:[{type:'bold'},{type:'textStyle',attrs:{color:'#ff0000',fontSize:'18px',backgroundColor:'#ffff00'}}]},{type:'hardBreak'},text('Second line')]},
    {type:'taskList',content:[{type:'taskItem',attrs:{checked:true},content:[p('Task')]}]},
    {type:'orderedList',attrs:{start:3},content:[{type:'listItem',content:[p('Third')]}]},
    {type:'table',content:[{type:'tableRow',content:[{type:'tableCell',attrs:{colspan:2,rowspan:1,colwidth:[80,90],backgroundColor:'#eaf1ff'},content:[p('Merged')]}]}]},
    {type:'image',attrs:{src:png,alt:'Offline image',width:120,height:80}},
    {type:'columnLayout',content:[{type:'column',attrs:{widthRatio:.4},content:[p('Left')]},{type:'column',attrs:{widthRatio:.6},content:[p('Right')]}]}];
  const before=JSON.stringify(doc),out=buildHtmlFile(doc);
  for(const fragment of ['<strong>Bold</strong>','text-align:center','background-color:#ffff00','☑','start="3"','width:170px',png,'flex:0.4 1 0','href="#heading-1"'])assert.ok(out.html.includes(fragment),fragment);
  assert.deepEqual(out.stats,{images:1,missing:0,tables:1,sheets:0,positions:0,merges:0});
  assert.equal(JSON.stringify(doc),before);assert.equal(out.name,'Offline.html');
});
test('all sheets and merges render with dimensions, zero/false, multiline values and static formula result',()=>{
  const doc=book(),sheet=doc.content.sheets['sheet-1'];
  doc.content.styles.s={bg:{rgb:'#00ccff'},cl:{rgb:'#123456'},bl:1,fs:14,ht:2,vt:1,tb:3,bd:{b:{s:7,cl:{rgb:'#000000'}}}};
  sheet.cellData={0:{0:{v:'Merge',s:'s'},1:{v:0}},1:{0:{v:false}},2:{2:{v:'Line1\nLine2'}}};
  sheet.mergeData=[{startRow:0,endRow:1,startColumn:0,endColumn:1}];sheet.rowData={0:{h:64}};sheet.columnData={0:{w:155}};
  doc.content.sheets['sheet-2'].cellData={2:{2:{v:3,f:'=1+2'}}};
  const out=buildHtmlFile(doc);
  assert.equal(out.stats.sheets,2);assert.equal(out.stats.positions,18);assert.equal(out.stats.merges,1);
  assert.match(out.html,/rowspan="2" colspan="2"/);assert.match(out.html,/height:64px/);assert.match(out.html,/width:155px/);
  assert.match(out.html,/background-color:#00ccff/);assert.match(out.html,/3px double/);
  assert.match(out.html,/B1：0/);assert.match(out.html,/A2：FALSE/);assert.match(out.html,/Line1\nLine2/);
  assert.match(out.html,/title="公式：=1\+2">3<\/td>/);assert.ok(out.warnings.some(w=>w.includes('不会')));
});
test('preserves original formatted display only for matching values, formulas and number format',()=>{
  const doc=book();doc.content.styles.percent={n:{pattern:'0.0%'}};
  doc.content.sheets['sheet-1'].cellData={0:{0:{v:.5,s:'percent'}}};
  doc.provenance.capture={model:{sheets:[{cells:[{row:0,column:0,value:.5,display:'50.0%',formula:null,style:{_formatter:'0.0%'}}]}]}};
  assert.match(buildHtmlFile(doc).html,/>50.0%<\/td>/);
  doc.content.sheets['sheet-1'].cellData[0][0].v=.6;
  const out=buildHtmlFile(doc);assert.doesNotMatch(out.html,/50.0%/);assert.match(out.html,/>0.6<\/td>/);assert.ok(out.warnings.some(w=>w.includes('数字格式')));
});
test('missing source content is visible and never described as complete',()=>{
  const doc=createDocument('document','Partial');doc.issues=[{code:'MISSING',count:2}];
  doc.content.content=[{type:'preservedBlock',attrs:{sourceId:'x',sourceType:'file',label:'Attachment'}}];
  const out=buildHtmlFile(doc);assert.equal(out.stats.missing,1);assert.match(out.html,/未完整保存：Attachment/);assert.match(out.html,/不能补回/);
});
test('untrusted text, title, CSS and source metadata cannot inject markup, fetches or executable URLs',()=>{
  const doc=book();doc.title='</title><script>alert(1)</script>';
  doc.content.sheets['sheet-1'].cellData={0:{0:{v:'<img src="https://example.com/x" onerror="alert(1)">',s:'evil'}}};
  doc.content.styles.evil={ff:'</style><script>alert(1)</script>',bg:{rgb:'url(https://example.com/x)'},fs:'1px; background:url(x)',bd:{b:{s:1,cl:{rgb:'red;position:fixed'}}}};
  doc.provenance.capture={source:{url:'https://example.com/?access_token=secret'}};
  const out=buildHtmlFile(doc);
  assert.doesNotMatch(out.html,/<script|<iframe|onerror="|url\(|access_token=secret/);
  assert.match(out.html,/&lt;img/);assert.match(out.html,/script-src 'none'/);assert.match(out.html,/img-src data:/);
  assert.ok(out.warnings.length>0);
});
test('oversized workbooks and overlapping merges fail as a whole instead of silently truncating',()=>{
  const doc=book();doc.content.sheets['sheet-1'].rowCount=10000;
  doc.content.sheets['sheet-1'].columnCount=100;
  assert.throws(()=>buildHtmlFile(doc),/HTML_GRID_TOO_LARGE/);
  const small=book();small.content.sheets['sheet-1'].mergeData=Array(2).fill({startRow:0,endRow:1,startColumn:0,endColumn:1});
  assert.throws(()=>buildHtmlFile(small),/HTML_MERGE_INVALID/);
});
test('whiteboard full text and all Base records are included without editor pagination',()=>{
  const doc=createDocument('document','Embeds');
  const long='长文字'.repeat(110),records=Object.fromEntries(Array.from({length:201},(_,i)=>[`R${i}`,{A:{value:`record-${i}`}}]));
  doc.content.content=[{type:'localWhiteboard',attrs:{sourceId:'board',images:[],payload:{format:'feishu-whiteboard-page-detail',meta:{},nodes:[{id:'n',info:{baseV2:{x:0,y:0,width:100,height:100},textV2:{text:long}},children:[]}]}}},
  {type:'localBase',attrs:{sourceId:'base',payload:{format:'feishu-bitable-table',table:{meta:{id:'T',recordsNum:201},views:[],viewMap:{},fieldMap:{A:{name:'Text',type:1}},recordMap:records}}}}];
  const out=buildHtmlFile(doc);assert.ok(out.html.includes(long));assert.match(out.html,/record-200/);assert.match(out.html,/复杂形状/);assert.match(out.html,/甘特图/);
});
test('formula with no cache is retained as formula text',()=>{
  const doc=book();doc.content.sheets['sheet-1'].cellData={0:{0:{f:'=A2+2'}}};
  const out=buildHtmlFile(doc);assert.match(out.html,/>=A2\+2<\/td>/);assert.ok(out.warnings.some(w=>w.includes('缺少结果')));
});

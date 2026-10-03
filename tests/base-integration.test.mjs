import test from 'node:test';import assert from 'node:assert/strict';
import {makeDemo} from '../extension/demo.mjs';import {importSnapshot} from '../shared/import-snapshot.mjs';
import {encodeDocument,decodeDocument,updateContent} from '../shared/model.mjs';
import {validateBasePayload} from '../shared/base-data.mjs';import {buildBaseGrid} from '../shared/base-grid.mjs';import {editBaseCell} from '../shared/base-edit.mjs';
import {preflightDocumentContent} from '../app/src/editors/editor-schema.mjs';
const block=(id,type,children=[],resource=null)=>({id,type,text:'',richText:null,children,parentId:id==='root'?null:'root',properties:{},...(resource?{resource}:{})});
const payload=()=>({format:'feishu-bitable-table',sourceTimezone:'Asia/Shanghai',table:{meta:{id:'tbl1',recordsNum:2},views:['V'],viewMap:{V:{id:'V',name:'甘特图',type:5,property:{fields:['A','S','D'],records:[],sortInfo:[],filterInfo:null,group:[],ganttConfig:{titleField:'A'}}}},fieldMap:{D:{name:'开始日期',type:5,property:{dateFormat:'yyyy/MM/dd',timeFormat:''}},S:{name:'任务状态',type:3,property:{options:[{id:'o1',name:'已完成',color:2}]}},A:{name:'任务名',type:1,property:{}}},recordMap:{R2:{A:{value:[{type:'text',text:'second'}]},S:{value:'o1'},D:{value:1761926400000}},R1:{A:{value:null},D:{value:null}}},rankInfo:{rankMap:{R1:'i0000',R2:'i0001'},viewRankMap:{V:{}}}}});
const embed=p=>({sourceId:'base',kind:'bitable',status:'VIEW_SNAPSHOT',code:'BASE_EDITOR_AND_COVERAGE_PENDING',payload:p,counts:{fields:3,records:2,views:1,declaredRecords:2,metaRecords:2},byteLength:new TextEncoder().encode(JSON.stringify(p)).byteLength,sha256:'a'.repeat(64)});
const snapshot=()=>{const s=makeDemo();s.model={rootIds:['root'],blocks:[block('root','page',['base']),block('base','bitable',[],{kind:'bitable',resourceId:'app_tbl1'})]};return s;};
test('native-shaped Base becomes an actual editor node, preserves original and reopens editable data',async()=>{
  const p=payload(),doc=importSnapshot(snapshot(),{embeds:[embed(p)]});assert.equal(doc.content.content[0].type,'localBase');assert.equal(doc.provenance.audit.counts.structuredBases,1);assert.equal(doc.provenance.audit.counts.missingResources,0);assert.equal(doc.provenance.audit.objects[0].status,'VIEW_SNAPSHOT');
  assert.deepEqual(preflightDocumentContent(doc.content),doc.content);const grid=buildBaseGrid(p,'V');assert.deepEqual(grid.columns.map(c=>c.id),['A','S','D']);assert.deepEqual(grid.rows.map(r=>r.id),['R1','R2']);
  const content=structuredClone(doc.content);content.content[0].attrs.payload=editBaseCell(p,'R2','A','edited');const modified=updateContent(doc,content),reopened=await decodeDocument(await encodeDocument(modified));
  assert.equal(reopened.content.content[0].attrs.payload.table.recordMap.R2.A.value[0].text,'edited');assert.deepEqual(reopened.provenance.embedded[0].payload,p);assert.ok(reopened.issues.some(i=>i.code==='BASE_EDITOR_AND_COVERAGE_PENDING'));assert.equal(reopened.provenance.roundtrip,'PENDING');
});
test('unknown field/cell structures are retained as data and never flattened into editable text',()=>{
  const p=payload();p.table.fieldMap.U={name:'关联字段',type:17,property:{extra:{relation:'business-id'}}};p.table.recordMap.R1.U={value:{links:[{recordId:'other'}]}};validateBasePayload(p);const grid=buildBaseGrid(p);assert.equal(grid.unsupportedCells,2);assert.equal(grid.rows[0].cells.find(c=>c.fieldId==='U').editable,false);assert.deepEqual(p.table.recordMap.R1.U.value,{links:[{recordId:'other'}]});
});
test('Base import rejects mismatched source identity, counts and sensitive metadata',()=>{
  const p=payload();for(const e of [{...embed(p),byteLength:1},{...embed(p),counts:{...embed(p).counts,records:7}},{...embed(p),payload:{...p,table:{...p.table,meta:{id:'other'}}}}])assert.throws(()=>importSnapshot(snapshot(),{embeds:[e]}),/IMPORT_INVALID/);
  for(const mutate of [p=>{p.table.userMap={private:'value'};},p=>{p.table.fieldMap.A.property.cipherKey='excluded';},p=>{p.table.recordMap.R1.A.value=[{type:'text',text:'https://x.invalid/?access_token=excluded'}];},p=>{delete p.table.meta.id;}]){const value=payload();mutate(value);assert.throws(()=>validateBasePayload(value),/IMPORT_INVALID/);}
});
test('missing native embeds remain serializable with explicit gaps rather than undefined provenance',async()=>{
  const doc=importSnapshot(snapshot(),{embeds:[{sourceId:'base',kind:'bitable',status:'MISSING',code:'BASE_READ_FAILED'}]});assert.equal(doc.content.content[0].type,'preservedBlock');assert.equal(doc.provenance.audit.counts.missingResources,1);assert.deepEqual((await decodeDocument(await encodeDocument(doc))).provenance.embedded,doc.provenance.embedded);
});

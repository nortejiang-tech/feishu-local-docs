import test from 'node:test';import assert from 'node:assert/strict';import {buildEditableTable} from '../shared/document-table.mjs';
import {makeDemo} from '../extension/demo.mjs';
import {importSnapshot} from '../shared/import-snapshot.mjs';
import {preflightDocumentContent} from '../app/src/editors/editor-schema.mjs';
const block=(id,type,parentId,children=[],text=id)=>({id,type,parentId,children,text,properties:{}});
function fixture(){const table={id:'table',type:'table',parentId:null,text:'',children:['cell'],properties:{},table:{rowIds:['r'],columnIds:['c'],columnWidths:[100],headerRow:false,cells:[{row:0,column:0,blockId:'cell',rowSpan:1,columnSpan:1}]}};const cell=block('cell','table_cell','table',['a','b','break','c'],'');const rows=[table,cell,block('a','ordered','cell',[],'first'),block('b','ordered','cell',['nested'],'second'),block('nested','bullet','b',[],'nested bullet'),block('break','paragraph','cell',[],'separator'),block('c','ordered','cell',[],'restarted')];return {table,rows,map:new Map(rows.map(b=>[b.id,b]))};}
function convert(b){const p={type:'paragraph',content:[{type:'text',text:b.text}]};if(['ordered','bullet','todo'].includes(b.type))return [{type:{ordered:'orderedList',bullet:'bulletList',todo:'taskList'}[b.type],content:[{type:b.type==='todo'?'taskItem':'listItem',content:[p]}]}];return [p];}
test('one cell groups sibling ordered items and preserves a nested bullet under its parent',()=>{const {table,rows,map}=fixture(),before=JSON.stringify(rows),result=buildEditableTable(table,map,convert);assert.ok(result);const content=result.node.content[0].content[0].content;assert.deepEqual(content.map(n=>n.type),['orderedList','paragraph','orderedList']);assert.equal(content[0].content.length,2);assert.equal(content[0].content[1].content[1].type,'bulletList');assert.equal(content[2].content.length,1);assert.equal(JSON.stringify(rows),before);assert.equal(result.consumed.size,rows.length);for(const word of ['first','second','nested bullet','separator','restarted'])assert.equal(JSON.stringify(content).split(word).length-1,1);});
test('cycles, nested tables, parent mismatch and shared descendants fail visibly',()=>{for(const corrupt of [f=>f.map.get('nested').children.push('b'),f=>f.map.get('nested').type='table',f=>f.map.get('nested').parentId='cell',f=>f.map.get('a').children.push('nested')]){const f=fixture();corrupt(f);assert.equal(buildEditableTable(f.table,f.map,convert),null);}});
test('empty cell remains a valid paragraph',()=>{const f=fixture();f.map.get('cell').children=[];const r=buildEditableTable(f.table,f.map,convert);assert.deepEqual(r.node.content[0].content[0].content,[{type:'paragraph'}]);});
test('capture import retains grouped table lists in the actual editor schema',()=>{
 const f=fixture(),snapshot=makeDemo('document');snapshot.model={rootIds:['table'],blocks:f.rows.map(b=>({...b,richText:null}))};
 const doc=importSnapshot(snapshot);preflightDocumentContent(doc.content);
 const content=doc.content.content[0].content[0].content[0].content;
 assert.deepEqual(content.map(n=>n.type),['orderedList','paragraph','orderedList']);
 assert.equal(content[0].content.length,2);assert.equal(content[0].content[1].content[1].type,'bulletList');
 assert.ok(!doc.issues.some(i=>i.code==='TABLE_CONVERSION_INCOMPLETE'||i.code==='DOCUMENT_TREE_FALLBACK'));
});

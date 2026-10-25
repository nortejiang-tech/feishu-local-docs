import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSheetAudit} from '../shared/sheet-audit.mjs';
const cell=(row,column,value=null,display='',formula=null,style={})=>({row,column,value,display,formula,style});
const sheet=(name='alpha')=>({index:0,name,rows:2,columns:3,cells:[],merges:[],loadCoverage:'unknown'});
const capture=(...sheets)=>({kind:'sheet',model:{sheets}});
test('native-shaped snapshot counts values/formulas/styles independently and never claims completeness',()=>{
 const a=sheet();a.cells=[cell(0,0,0,'0',null,{_font:'11px Arial'}),cell(0,1,false,'FALSE'),cell(0,2,null,'3','=1+2'),cell(1,0,null,'',null,{_backColor:'#fff'})];a.merges=[{row:1,column:1,rows:1,columns:2}];const b=sheet('blank');
 const input=capture(a,b);input.fidelity={complete:true};a.loadCoverage='complete';const before=JSON.stringify(input);const out=buildSheetAudit(input);
 assert.deepEqual(out,{version:1,status:'PENDING',coverage:'UNKNOWN',totals:{sheets:2,positions:12,capturedCells:4,valueCells:2,displayCells:3,formulaCells:1,styledCells:2,merges:1,emptyOrUnloadedSheets:1},sheets:[{index:0,name:'alpha',rows:2,columns:3,positions:6,capturedCells:4,valueCells:2,displayCells:3,formulaCells:1,styledCells:2,merges:1,state:'NEEDS_REVIEW',coverage:'UNKNOWN'},{index:1,name:'blank',rows:2,columns:3,positions:6,capturedCells:0,valueCells:0,displayCells:0,formulaCells:0,styledCells:0,merges:0,state:'EMPTY_OR_UNLOADED',coverage:'UNKNOWN'}]});assert.equal(JSON.stringify(input),before);
});
test('style-only cells cannot be treated as loaded data, display-only and formula-only cells are review candidates',()=>{
 for(const [c,state] of [[cell(0,0,null,'',null,{_font:'11px Arial'}),'EMPTY_OR_UNLOADED'],[cell(0,0,null,'Shown'),'NEEDS_REVIEW'],[cell(0,0,null,'','=A2+1'),'NEEDS_REVIEW']]){const s=sheet();s.cells=[c];assert.equal(buildSheetAudit(capture(s)).sheets[0].state,state);}
});
test('malformed fields, duplicate coordinates and invalid merge metadata return null instead of a partial report',()=>{
 const invalid=[{cells:{}},{cells:[cell(2,0)]},{cells:[cell(0,-1)]},{cells:[cell(0,0,NaN)]},{cells:[cell(0,0,undefined)]},{cells:[{...cell(0,0),value:undefined}]},{cells:[cell(0,0,null,null)]},{cells:[cell(0,0,null,'',12)]},{cells:[cell(0,0,null,'',null,[])]},{cells:[cell(0,0),cell(0,0)]},{merges:[{row:0,column:0,rows:3,columns:1}]},{merges:[{row:0,column:0,rows:0,columns:1}]},{rows:-1},{columns:1.5},{name:7}];
 // An explicit undefined argument invokes the cell helper default and is not invalid.
 invalid.splice(4,1);
 for(const changed of invalid)assert.equal(buildSheetAudit(capture({...sheet(),...changed})),null,JSON.stringify(changed));
});
test('bounded input, missing captures and wrong kinds cannot trigger unbounded work',()=>{
 for(const input of [null,{}, {kind:'document'},capture(),capture(...Array(101).fill(sheet())),capture({...sheet(),rows:100000,columnCount:10000,columns:10000}),capture({...sheet(),cells:Array(150001).fill(cell(0,0))})])assert.equal(buildSheetAudit(input),null);
});
test('zero-sized sheets are unknown empty snapshots and preserve benign names verbatim',()=>{
 const s={...sheet('<script>benign text</script>'),rows:0,columns:0};const out=buildSheetAudit(capture(s));assert.equal(out.sheets[0].name,s.name);assert.equal(out.sheets[0].state,'EMPTY_OR_UNLOADED');assert.equal(out.totals.positions,0);assert.equal(out.coverage,'UNKNOWN');
});
test('six worksheet snapshot keeps 28600 positions separate from populated values without reading source URL',()=>{
 const sheets=[20,20,20,20,37,26].map((cols,i)=>({...sheet('sheet-'+i),rows:200,columns:cols,cells:[cell(0,0,'seed-'+i)]}));const input=capture(...sheets);Object.defineProperty(input,'source',{get(){throw Error('must not read source');}});const out=buildSheetAudit(input);assert.equal(out.totals.positions,28600);assert.equal(out.totals.valueCells,6);assert.equal(out.totals.sheets,6);assert.equal(out.status,'PENDING');assert.ok(out.sheets.every(s=>s.coverage==='UNKNOWN'));
});

test('nullable styles are valid without exceptions and count as zero styled cells',()=>{
 const s=sheet();s.cells=[cell(0,0,0,'0',null,null)];const out=buildSheetAudit(capture(s));assert.equal(out.totals.styledCells,0);assert.equal(out.totals.valueCells,1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSheetLayout} from '../shared/html-sheet-layout.mjs';
const merge=(sr,er,sc,ec)=>({startRow:sr,endRow:er,startColumn:sc,endColumn:ec});
const sheet=(rowCount=3,columnCount=3)=>({rowCount,columnCount,cellData:{},mergeData:[]});
test('native sparse objects render every declared position without modifying data',()=>{
 const s=sheet(),cell={v:'end'};s.cellData={2:{2:cell}};const before=JSON.stringify(s),out=buildSheetLayout(s);
 assert.equal(out.positions,9);assert.equal(out.rows.length,3);assert.ok(out.rows.every(r=>r.length===3));assert.equal(out.rows[2][2].cell,cell);assert.equal(out.rows[0][0].cell,null);assert.equal(JSON.stringify(s),before);
});
test('merge anchor spans and neighbours survive with original covered zero and false values',()=>{
 const s=sheet();s.cellData={0:{0:{v:'a'},1:{v:0}},1:{0:{v:false}}};s.mergeData=[merge(0,1,0,1)];
 const out=buildSheetLayout(s);assert.deepEqual(out.rows.map(r=>r.map(c=>c.column)),[[0,2],[2],[0,1,2]]);
 assert.equal(out.rows[0][0].rowspan,2);assert.equal(out.rows[0][0].colspan,2);
 assert.deepEqual(out.coveredCells.map(c=>c.cell.v),[0,false]);assert.equal(out.coveredCells[0].cell,s.cellData[0][1]);
});
test('empty anchor and fully covered rows retain correct row geometry',()=>{
 const s=sheet(2,2);s.mergeData=[merge(0,1,0,1)];const out=buildSheetLayout(s);
 assert.equal(out.rows.length,2);assert.equal(out.rows[0][0].cell,null);assert.deepEqual(out.rows[1],[]);
});
test('out-of-bounds, inverted, overlapping and duplicate merges fail',()=>{
 for(const merges of [[merge(0,3,0,0)],[merge(1,0,0,0)],[merge(0,.5,0,0)],[merge(0,1,0,1),merge(1,2,1,2)],[merge(0,0,0,0),merge(0,0,0,0)]])assert.throws(()=>buildSheetLayout({...sheet(),mergeData:merges}),/HTML_MERGE_INVALID/);
});
test('allocation is gated before reading merges and dimensions cannot overflow',()=>{
 const s={rowCount:100000,columnCount:10000,get mergeData(){throw Error('unexpected allocation');}};
 assert.throws(()=>buildSheetLayout(s),/HTML_GRID_TOO_LARGE/);
 assert.throws(()=>buildSheetLayout(sheet(Number.MAX_SAFE_INTEGER,2)),/HTML_GRID_TOO_LARGE/);
 for(const v of [0,-1,NaN,Infinity,1.5,'3'])assert.throws(()=>buildSheetLayout(sheet(v,2)),/HTML_GRID_TOO_LARGE/);
});
test('caller can enforce one shared budget for every worksheet',()=>{
 const first=buildSheetLayout(sheet(2,3),10);assert.equal(first.positions,6);
 assert.equal(buildSheetLayout(sheet(2,2),10-first.positions).positions,4);
 assert.throws(()=>buildSheetLayout(sheet(2,3),4),/HTML_GRID_TOO_LARGE/);
});
test('disjoint merges preserve uncovered empty positions',()=>{
 const s=sheet(4,4);s.mergeData=[merge(0,1,0,1),merge(2,3,2,3)];
 assert.deepEqual(buildSheetLayout(s).rows.map(r=>r.map(c=>c.column)),[[0,2,3],[2,3],[0,1,2],[0,1]]);
});

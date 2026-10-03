import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {capturePage} from '../extension/capture.mjs';

class RangeCollection extends Array {
  toJSON() { return this.map(item=>item.toJSON()); }
}
async function capture(spans) {
  const source={_name:'Regression',getRowCount:()=>213,getColumnCount:()=>19,
    getValue:(r,c)=>r===0&&c===0?'Test':null,getText:()=>'',getFormula:()=>'',
    getStyle:()=>({}),getRowHeight:()=>24,getColumnWidth:()=>88,getSpans:()=>spans};
  const context=vm.createContext({window:{spread:{sheets:[source]}},location:{href:'https://sample.feishu.cn/sheets/test',origin:'https://sample.feishu.cn',pathname:'/sheets/test'},document:{title:'Synthetic'},URL,setTimeout});
  const result=await vm.runInContext(`(${capturePage.toString()})({expectedSource:'https://sample.feishu.cn/sheets/test'})`,context);
  return JSON.parse(JSON.stringify(result));
}
test('capture accepts observed Feishu exclusive-end ranges without carrying page prototypes',async()=>{
  const range={startRow:0,endRow:1,startCol:0,endCol:6,toJSON(){throw new Error('page serializer must not run')},_sheet:{private:'not-for-export'}};
  const result=await capture(new RangeCollection(range));
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.deepEqual(result.snapshot.model.sheets[0].merges,[{row:0,column:0,rows:1,columns:6}]);
  assert.ok(!JSON.stringify(result).includes('not-for-export'));
});
test('legacy merge coordinates in a custom array are copied to a plain array',async()=>{
 const result=await capture(new RangeCollection({row:2,col:1,rowCount:1,colCount:5}));
 assert.equal(result.ok,true,JSON.stringify(result));
 assert.deepEqual(result.snapshot.model.sheets[0].merges,[{row:2,column:1,rows:1,columns:5}]);
});
test('invalid native ranges remain rejected',async()=>{
 for(const range of [{startRow:0,endRow:214,startCol:0,endCol:6},{startRow:0,endRow:0,startCol:0,endCol:6},{startRow:-1,endRow:1,startCol:0,endCol:6},{startRow:0,endRow:1,startCol:0,endCol:20}]) {
  assert.equal((await capture(new RangeCollection(range))).code,'MODEL_SHAPE_CHANGED');
 }
});

import test from 'node:test';import assert from 'node:assert/strict';import {taskView} from '../shared/task-view.mjs';
const cases=[
['capturing',{},'正在读取当前文件','working',[true,false,false,false]],
['converting',{},'正在转换本地文件','working',[true,false,false,false]],
['saving',{},'正在保存到本机','working',[false,false,false,true]],
['saved',{},'已保存到本机','success',[false,false,true,false]],
['saved',{partial:true},'已保存，有内容需要核对','partial',[false,false,true,false]],
['failed',{},'保存未完成','error',[false,true,false,false]],
['interrupted',{stage:'NATIVE'},'保存结果尚未确认','neutral',[false,false,false,true]],
['interrupted',{stage:'CAPTURE'},'本次读取已中断','neutral',[false,true,false,false]],
['cancelled',{},'本次读取已停止','neutral',[false,true,false,false]]];
for(const [state,extra,headline,tone,flags] of cases)test(state+JSON.stringify(extra),()=>{const input=Object.freeze({state,...extra,message:'private-body',title:'private-title'}),r=taskView(input);assert.equal(r.headline,headline);assert.equal(r.tone,tone);assert.deepEqual([r.canCancel,r.canRetry,r.canNewCopy,r.canCheck],flags);assert.deepEqual(Object.keys(r).sort(),['headline','detail','tone','canCancel','canRetry','canNewCopy','canCheck'].sort());assert.equal(typeof r.detail,'string');assert.ok(!JSON.stringify(r).includes('private-'));});
test('invalid states and non-records return null',()=>{for(const input of [null,undefined,1,'saved',[],{state:'unknown'},{state:'__proto__'},{}])assert.equal(taskView(input),null)});

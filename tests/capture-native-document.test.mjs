import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { capturePage } from '../extension/capture.mjs';
import { importSnapshot } from '../shared/import-snapshot.mjs';
import { encodeDocument,decodeDocument } from '../shared/model.mjs';
async function run(blocks) {
 const context=vm.createContext({window:{PageMain:{editor:{editor:{api:{modelService:{allBlockModels:blocks}}}}}},location:{href:'https://sample.feishu.cn/wiki/sample',origin:'https://sample.feishu.cn',pathname:'/wiki/sample'},document:{title:'Document regression'},URL,setTimeout});
 return JSON.parse(JSON.stringify(await vm.runInContext(`(${capturePage.toString()})({expectedSource:'https://sample.feishu.cn/wiki/sample'})`,context)));
}
const block=(internalId,recordId,type,snapshot)=>({type,struct:{id:internalId,record:{id:recordId,snapshot:{parent_id:'root',...snapshot}}}});
test('uses record IDs matching child references instead of numeric model IDs',async()=>{
 const result=await run([block(1,'root','page',{parent_id:'external',children:['heading','text']}),block(2,'heading','heading1',{children:[],text:'Heading'}),block(3,'text','text',{children:[],text:'Body'})]);
 assert.equal(result.ok,true,JSON.stringify(result));
 assert.deepEqual(result.snapshot.model.blocks.map(b=>b.id),['root','heading','text']);
 assert.deepEqual(result.snapshot.model.rootIds,['root']);
 assert.equal(result.snapshot.issues.some(x=>x.code==='UNRESOLVED_CHILD'),false);
 const doc=await decodeDocument(await encodeDocument(importSnapshot(result.snapshot)));
 assert.equal(doc.kind,'document');
 assert.ok(JSON.stringify(doc.content).includes('Body'));
});
test('copies page child collections into plain arrays before serializing',async()=>{
 const children=['leaf'];
 children.map=()=>{throw new Error('page map should not run');};
 children.toJSON=()=>['forged'];
 const result=await run([block(1,'root','page',{parent_id:'external',children}),block(2,'leaf','text',{children:[]})]);
 assert.equal(result.ok,true,JSON.stringify(result));
 assert.deepEqual(result.snapshot.model.blocks[0].children,['leaf']);
});
test('handles absent children on observed image/table/file/whiteboard/fallback/bitable records explicitly',async()=>{
 let omitted=0;
 for(const type of ['image','table','file','whiteboard','fallback','bitable']) {
  const result=await run([block(1,'root','page',{parent_id:'external',children:['leaf']}),block(2,'leaf',type,{})]);
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.deepEqual(result.snapshot.model.blocks[1].children,[]);
  assert.equal(result.snapshot.fidelity.complete,false);
  assert.equal(result.snapshot.issues.find(x=>x.code==='CHILD_REFERENCES_NOT_PROVIDED').count,1);
  omitted++;
 }
 assert.equal(omitted,6);
});
test('rejects duplicate record IDs, invalid authoritative IDs and malformed child collections',async()=>{
 assert.equal((await run([block(1,'same','text',{children:[]}),block(2,'same','text',{children:[]})])).code,'BLOCK_ID_INVALID');
 assert.equal((await run([block('legacy',17,'text',{children:[]})])).code,'BLOCK_ID_INVALID');
 assert.equal((await run([block(1,'','text',{children:[]})])).code,'BLOCK_ID_INVALID');
 assert.equal((await run([block(1,'x'.repeat(257),'text',{children:[]})])).code,'FIELD_LIMIT');
 assert.equal((await run([block(1,'root','text',{children:{length:0}})])).code,'MODEL_SHAPE_CHANGED');
 assert.equal((await run([block(1,'root','text',{children:null})])).code,'MODEL_SHAPE_CHANGED');
 assert.equal((await run([block(1,'root','text',{children:'child'})])).code,'MODEL_SHAPE_CHANGED');
 const legacy=block('legacy',undefined,'text',{children:[]});
 delete legacy.struct.record.id;
 const legacyResult=await run([legacy]);
 assert.equal(legacyResult.ok,true,JSON.stringify(legacyResult));
 assert.equal(legacyResult.snapshot.model.blocks[0].id,'legacy');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {captureEmbeds} from '../extension/embedded.mjs';
const source='https://sample.feishu.cn/docx/abc';
const descriptor={sourceId:'wb',resourceId:'board123',kind:'whiteboard'};
function setup(t,exporter) {
 const saved=new Map();for(const key of ['location','window','document','getComputedStyle'])saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
 Object.defineProperty(globalThis,'location',{configurable:true,value:{origin:'https://sample.feishu.cn',pathname:'/docx/abc'}});
 Object.defineProperty(globalThis,'document',{configurable:true,value:{querySelector:()=>null}});
 globalThis.window={PageMain:{editor:{editor:{api:{modelService:{allBlockModels:[{type:'whiteboard',struct:{record:{id:'wb',snapshot:{token:'board123'}}},whiteboardBlock:{appProxy:{serializeData:exporter,isDestroy:false},abilityKit:{getCurrentSeq:()=>3}}}]}}}}}};
 t.after(()=>{for(const[key,d]of saved)if(d)Object.defineProperty(globalThis,key,d);else delete globalThis[key];});
}
test('preserves native nodes as data, excludes comments, operations and resource response fields',async t=>{
 const nodes=[{id:'n',info:{baseV2:{x:1,y:2,width:100,height:80,angle:0},textV2:{text:'可编辑文字'},svgIcon:{svgCode:'<svg><path d="M0 0"/></svg>'}},children:[]}];
 setup(t,()=>JSON.stringify({nodes,meta:{version:2,appliedVersion:3,theme:'light',unrelated:'do-not-copy'},comments:{author:'do-not-copy'},resources:[{url:'https://cdn.invalid/private'}],ops:['do-not-copy']}));
 const r=await captureEmbeds({expectedSource:source,resources:[descriptor]});
 assert.equal(r.ok,true);assert.equal(r.embeds[0].status,'STRUCTURE_CANDIDATE');assert.deepEqual(JSON.parse(JSON.stringify(r.embeds[0].payload.nodes)),nodes);
 assert.equal(r.embeds[0].resourceCount,1);assert.ok(!JSON.stringify(r).includes('do-not-copy'));assert.ok(!JSON.stringify(r).includes('cdn.invalid'));
 assert.match(r.embeds[0].sha256,/^[a-f0-9]{64}$/);
});
test('warming loads an offscreen board and restores the original scroll position',async t=>{
 let loaded=false;
 setup(t,()=>loaded?'{"nodes":[{"id":"offscreen","info":{},"children":[]}],"meta":{}}':null);
 let top=420;const visited=[];
 const scroll={clientHeight:600,scrollHeight:1800,parentElement:null,get scrollTop(){return top;},set scrollTop(value){top=value;visited.push(value);if(value>=800)loaded=true;}};
 globalThis.document.querySelector=()=>scroll;
 globalThis.getComputedStyle=()=>({overflowY:'auto'});
 const r=await captureEmbeds({expectedSource:source,resources:[descriptor],warm:true});
 assert.equal(r.embeds[0].status,'STRUCTURE_CANDIDATE');assert.equal(top,420);assert.ok(visited.some(value=>value>=800));
});
test('duplicate and unsafe descriptors fail before invoking the native exporter',async t=>{
 let called=0;setup(t,()=>{called++;return '{"nodes":[],"meta":{}}';});
 assert.equal((await captureEmbeds({expectedSource:source,resources:[descriptor,descriptor]})).code,'RESOURCE_DESCRIPTOR_INVALID');
 assert.equal((await captureEmbeds({expectedSource:source,resources:[{...descriptor,resourceId:'../private'}]})).code,'RESOURCE_DESCRIPTOR_INVALID');
 assert.equal(called,0);
});
test('image fills report required offline resources using only the observed native preview URL',async t=>{
 const item={imageUrl:'https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/preview/image123?preview_type=16',resource:{key:'image123'}};
 setup(t,()=>JSON.stringify({nodes:[{id:'n',info:{fillV2:{fillStyleList:{data:[{active:true,imageFillItem:item}]}}},children:[]}],meta:{},resources:[]}));
 const r=await captureEmbeds({expectedSource:source,resources:[descriptor]});
 assert.equal(r.embeds[0].resourceCount,1);
 assert.equal(r.embeds[0].imageReferences[0].resourceId,'image123');
 assert.equal(r.embeds[0].imageReferences[0].sourceId,'wb-image123');
});
test('unloaded and unimplemented objects remain explicit, no guessed API calls',async t=>{
 setup(t,()=>null);
 const r=await captureEmbeds({expectedSource:source,resources:[descriptor,{sourceId:'base',resourceId:'base123_table',kind:'bitable'}]});
 assert.deepEqual(r.embeds.map(x=>x.code),['WHITEBOARD_NOT_LOADED','EMBEDDED_ADAPTER_PENDING']);
});
test('serialized security state or authenticated URLs cannot enter the local file',async t=>{
 setup(t,()=>'{"nodes":[{"id":"n","info":{"authorization":"do-not-copy"}}],"meta":{}}');
 let r=await captureEmbeds({expectedSource:source,resources:[descriptor]});assert.equal(r.embeds[0].code,'EMBEDDED_SENSITIVE_FIELD');assert.ok(!JSON.stringify(r).includes('do-not-copy'));
 globalThis.window.PageMain.editor.editor.api.modelService.allBlockModels[0].whiteboardBlock.appProxy.serializeData=()=>JSON.stringify({nodes:[{id:'n',info:{url:'https://cdn.invalid/?signature=do-not-copy'}}],meta:{}});
 r=await captureEmbeds({expectedSource:source,resources:[descriptor]});assert.equal(r.embeds[0].code,'EMBEDDED_SENSITIVE_FIELD');
 globalThis.window.PageMain.editor.editor.api.modelService.allBlockModels[0].whiteboardBlock.appProxy.serializeData=()=>JSON.stringify({nodes:[{id:'n',info:{accessToken:'do-not-copy'}}],meta:{}});
 r=await captureEmbeds({expectedSource:source,resources:[descriptor]});assert.equal(r.embeds[0].code,'EMBEDDED_SENSITIVE_FIELD');
});
test('source navigation and per-board revision changes fail rather than mixing versions',async t=>{
 setup(t,()=>{globalThis.location.pathname='/docx/other';return '{"nodes":[],"meta":{}}';});
 assert.equal((await captureEmbeds({expectedSource:source,resources:[descriptor]})).code,'SOURCE_CHANGED');
 globalThis.location.pathname='/docx/abc';const board=globalThis.window.PageMain.editor.editor.api.modelService.allBlockModels[0].whiteboardBlock;
 board.appProxy.serializeData=()=>'{"nodes":[],"meta":{}}';let seq=0;board.abilityKit.getCurrentSeq=()=>++seq;
 assert.equal((await captureEmbeds({expectedSource:source,resources:[descriptor]})).embeds[0].code,'EMBEDDED_SOURCE_CHANGED');
});

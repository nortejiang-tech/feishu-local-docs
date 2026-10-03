import test from 'node:test';
import assert from 'node:assert/strict';
import {makeDemo} from '../extension/demo.mjs';
import {importSnapshot} from '../shared/import-snapshot.mjs';
import {encodeDocument,decodeDocument} from '../shared/model.mjs';
import {preflightDocumentContent} from '../app/src/editors/editor-schema.mjs';
const block=(id,type,text='',children=[],parentId=null,properties={})=>({id,type,text,children,parentId,properties,richText:null});
function sample(blocks){const s=makeDemo();s.model={blocks,rootIds:['root']};return s;}
test('nested lists, checked tasks and native columns import into editable schema and reopen',async()=>{
 const blocks=[block('root','page','',['a','b','task','grid']),block('a','ordered','one',['nested'],'root'),block('nested','bullet','child',[],'a'),block('b','ordered','two',[],'root'),block('task','todo','done',[],'root',{checked:true}),block('grid','grid','',['c1','c2'],'root'),block('c1','grid_column','',['p1'],'grid',{width_ratio:0.5}),block('p1','text','left',[],'c1'),block('c2','grid_column','',['p2'],'grid',{width_ratio:0.5}),block('p2','text','right',[],'c2')];
 const d=importSnapshot(sample(blocks));
 assert.deepEqual(d.content.content.map(n=>n.type),['orderedList','taskList','columnLayout']);
 assert.equal(d.content.content[0].content.length,2);
 assert.equal(d.content.content[0].content[0].content[1].type,'bulletList');
 assert.equal(d.content.content[1].content[0].attrs.checked,true);
 assert.deepEqual(preflightDocumentContent(d.content),d.content);
 assert.deepEqual((await decodeDocument(await encodeDocument(d))).content,d.content);
});
test('image bytes embed once while resource provenance carries metadata only',async()=>{
 const png='data:image/png;base64,iVBORw0KGgo=';
 const image=block('img','image','',[],'root');image.resource={kind:'image',resourceId:'resource',name:'image.png',width:100,height:80,size:8};
 const d=importSnapshot(sample([block('root','page','',['img']),image]),{assets:[{sourceId:'img',kind:'image',status:'PREVIEW',code:'RESOURCE_PREVIEW_ONLY',dataUrl:png,byteLength:8,sha256:'a'.repeat(64)}]});
 assert.equal(d.content.content[0].type,'image');
 assert.equal(d.content.content[0].attrs.width,100);
 assert.equal(JSON.stringify(d).split(png).length-1,1);
 assert.equal(d.provenance.resources[0].dataUrl,undefined);
 assert.equal(d.provenance.audit.counts.renderedImages,1);
 assert.equal(d.provenance.audit.counts.previewResources,1);
 assert.equal(d.provenance.audit.objects[0].status,'PREVIEW');
 assert.ok(!JSON.stringify(d.provenance.audit).includes('data:'));
 assert.ok(d.issues.some(i=>i.code==='RESOURCE_PREVIEW_ONLY'));
 preflightDocumentContent(d.content);
 assert.deepEqual((await decodeDocument(await encodeDocument(d))).content,d.content);
});
test('asset provenance excludes arbitrary response fields and remains explicit about missing bytes',()=>{
 const image=block('img','image','',[],'root');image.resource={kind:'image',resourceId:'resource'};
 const d=importSnapshot(sample([block('root','page','',['img']),image]),{assets:[{sourceId:'img',kind:'image',status:'MISSING',code:'RESOURCE_URL_UNAVAILABLE',remoteUrl:'https://example.invalid/private',arbitrary:{value:'do-not-export'}}]});
 assert.equal(d.provenance.audit.counts.missingResources,1);
 assert.equal(d.provenance.audit.counts.renderedImages,0);
 assert.equal(d.provenance.resources[0].remoteUrl,undefined);
 assert.ok(!JSON.stringify(d).includes('do-not-export'));
});
test('malformed asset data and duplicate resource identities fail explicitly',()=>{
 const s=sample([block('root','page')]);
 const asset={sourceId:'x',status:'PREVIEW',code:'RESOURCE_PREVIEW_ONLY',dataUrl:'https://example.invalid/private',byteLength:8,sha256:'a'.repeat(64)};
 assert.throws(()=>importSnapshot(s,{assets:[asset]}),/IMPORT_INVALID/);
 assert.throws(()=>importSnapshot(s,{assets:[{sourceId:'x',status:'MISSING',code:'RESOURCE_READ_FAILED'},{sourceId:'x',status:'MISSING',code:'RESOURCE_READ_FAILED'}]}),/IMPORT_INVALID/);
});
test('native drawing payload survives the actual editor schema and local envelope without claiming fidelity',async()=>{
 const board=block('wb','whiteboard','',[],'root');board.resource={kind:'whiteboard',resourceId:'board'};
 const payload={format:'feishu-whiteboard-page-detail',nodes:[{id:'node',info:{textV2:{text:'diagram'}},children:[]}],meta:{version:1}};
 const embed={sourceId:'wb',kind:'whiteboard',status:'STRUCTURE_CANDIDATE',code:'WHITEBOARD_EDITOR_PENDING',payload,byteLength:new TextEncoder().encode(JSON.stringify(payload)).byteLength,sha256:'a'.repeat(64),resourceCount:0};
 const d=importSnapshot(sample([block('root','page','',['wb']),board]),{embeds:[embed]});
 assert.deepEqual(d.provenance.embedded[0].payload,payload);
 assert.equal(d.provenance.audit.counts.structuredWhiteboards,1);
 assert.equal(d.content.content[0].type,'localWhiteboard');
 assert.deepEqual(d.content.content[0].attrs.payload,payload);
 assert.deepEqual(preflightDocumentContent(d.content),d.content);
 assert.ok(d.issues.some(i=>i.code==='WHITEBOARD_EDITOR_PENDING'));
 assert.deepEqual((await decodeDocument(await encodeDocument(d))).provenance.embedded,d.provenance.embedded);
 for(const bad of [{...embed,sourceId:'other'},{...embed,byteLength:1},{...embed,payload:{...payload,nodes:[{info:{authorization:'private'}}]}}])assert.throws(()=>importSnapshot(sample([block('root','page','',['wb']),board]),{embeds:[bad]}),/IMPORT_INVALID/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {editWhiteboardNode} from '../shared/whiteboard-edit.mjs';
import {createDocument,encodeDocument,decodeDocument} from '../shared/model.mjs';
import {preflightDocumentContent} from '../app/src/editors/editor-schema.mjs';
const payload={format:'feishu-whiteboard-page-detail',nodes:[{id:'a',info:{baseV2:{x:1,y:2,width:100,height:80,angle:0},textV2:{text:'text',fontFamily:'native-font'},compositeShape:{shapeType:17}},children:[]}],meta:{version:1}};
test('geometry and text edits preserve opaque native fields and reopen through the actual schema',async()=>{
 const edited=editWhiteboardNode(payload,'a',{x:30,y:40,text:''});
 assert.equal(payload.nodes[0].info.baseV2.x,1);
 assert.equal(edited.nodes[0].info.textV2.text,'');
 assert.equal(edited.nodes[0].info.textV2.fontFamily,'native-font');
 assert.deepEqual(edited.nodes[0].info.compositeShape,payload.nodes[0].info.compositeShape);
 const doc=createDocument();doc.content={type:'doc',content:[{type:'localWhiteboard',attrs:{sourceId:'wb',payload:edited,images:[]}}]};
 preflightDocumentContent(doc.content);assert.deepEqual((await decodeDocument(await encodeDocument(doc))).content,doc.content);
});
test('invalid edits, duplicate target identity and remote drawing images fail without changing the file',async()=>{
 for(const changes of [{width:0},{x:Infinity},{text:123},{angle:90}])assert.throws(()=>editWhiteboardNode(payload,'a',changes),/WHITEBOARD_EDIT_INVALID/);
 assert.throws(()=>editWhiteboardNode({...payload,nodes:[...payload.nodes,...payload.nodes]},'a',{x:1}),/WHITEBOARD_EDIT_INVALID/);
 const doc=createDocument();doc.content={type:'doc',content:[{type:'localWhiteboard',attrs:{sourceId:'wb',payload,images:[{resourceId:'img',status:'PREVIEW',code:'RESOURCE_PREVIEW_ONLY',dataUrl:'https://remote.invalid/image.png',byteLength:8,sha256:'a'.repeat(64)}]}}]};
 await assert.rejects(encodeDocument(doc),/DOCUMENT_INVALID/);
});

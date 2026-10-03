import test from 'node:test';
import assert from 'node:assert/strict';
import { DOCUMENT_SCHEMA, preflightDocumentContent } from '../app/src/editors/editor-schema.mjs';

test('legacy color marks normalize into schema-preserved textStyle with font attributes', () => {
  const input = {
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: [{
        type: 'text',
        text: '保留格式',
        marks: [
          { type: 'color', attrs: { color: '#c62828' } },
          { type: 'textStyle', attrs: { fontFamily: 'Arial', fontSize: '18px' } },
        ],
      }],
    }],
  };

  const normalized = preflightDocumentContent(input);
  const documentNode = DOCUMENT_SCHEMA.nodeFromJSON(normalized);
  documentNode.check();
  const serialized = documentNode.toJSON();
  assert.deepEqual(JSON.parse(JSON.stringify(serialized.content[0].content[0].marks)), [{
    type: 'textStyle',
    attrs: { color: '#c62828', fontFamily: 'Arial', fontSize: '18px', backgroundColor:null },
  }]);
});

test('schema-valid document round trips without losing standalone color marks', () => {
  const content = preflightDocumentContent({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: '红色', marks: [{ type: 'color', attrs: { color: '#f00' } }] }] }],
  });
  assert.equal(content.content[0].content[0].marks[0].type, 'textStyle');
  assert.equal(content.content[0].content[0].marks[0].attrs.color, '#f00');
});

test('rejects malformed nested blocks before editor creation', () => {
  assert.throws(() => preflightDocumentContent({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'tableRow', content: [] }] }],
  }), { message: 'DOCUMENT_EDITOR_CONTENT_INVALID' });
});

test('rejects unknown node and mark attributes instead of silently dropping them', () => {
  assert.throws(() => preflightDocumentContent({
    type: 'doc',
    content: [{ type: 'paragraph', attrs: { importedFlag: true } }],
  }), { message: 'DOCUMENT_EDITOR_CONTENT_INVALID' });

  assert.throws(() => preflightDocumentContent({
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: [{ type: 'text', text: '格式', marks: [{ type: 'textStyle', attrs: { fontFamily: 'Arial', customWeight: 650 } }] }],
    }],
  }), { message: 'DOCUMENT_EDITOR_CONTENT_INVALID' });
});

test('rejects remote image sources before constructing the editor', () => {
  assert.throws(() => preflightDocumentContent({
    type: 'doc',
    content: [{ type: 'image', attrs: { src: 'https://example.invalid/image.png' } }],
  }), { message: 'DOCUMENT_EDITOR_CONTENT_INVALID' });
});

test('native foreground, highlight and fractional font survive the actual editor schema',()=>{
 const content={type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'格式',marks:[{type:'bold'},{type:'textStyle',attrs:{color:'#245bdb',backgroundColor:'rgba(255,246,122,0.8)',fontSize:'12.5px'}}]}]}]};
 assert.deepEqual(preflightDocumentContent(content),content);
 const node=DOCUMENT_SCHEMA.nodeFromJSON(content);node.check();
 assert.equal(node.toJSON().content[0].content[0].marks.find(m=>m.type==='textStyle').attrs.backgroundColor,'rgba(255,246,122,0.8)');
});

test('imported highlight values cannot inject additional CSS declarations',()=>{
 assert.throws(()=>preflightDocumentContent({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'unsafe',marks:[{type:'textStyle',attrs:{backgroundColor:'red;position:fixed'}}]}]}]}),/DOCUMENT_EDITOR_CONTENT_INVALID/);
});

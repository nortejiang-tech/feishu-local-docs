import { getSchema, Node, Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import { Color, FontFamily, FontSize, TextStyle } from '@tiptap/extension-text-style';
import TextAlign from '@tiptap/extension-text-align';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import {validateWhiteboardPayload,validateWhiteboardImages} from '../../../shared/embedded-data.mjs';
import {validateBasePayload} from '../../../shared/base-data.mjs';

const SAFE_BACKGROUND = /^(?:#[0-9a-f]{3}(?:[0-9a-f]{3})?|rgba?\([0-9., ]+\)|[a-z]{1,24})$/i;
const DATA_IMAGE = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]*={0,2}$/;

const PreservedBlock = Node.create({
  name: 'preservedBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return {
      sourceId: { default: null },
      sourceType: { default: 'unknown' },
      label: { default: '未支持的内容' },
    };
  },
  parseHTML() { return [{ tag: 'div[data-preserved-block]' }]; },
  renderHTML({ node }) {
    return ['div', {
      'data-preserved-block': '',
      'data-source-id': String(node.attrs.sourceId ?? ''),
      'data-source-type': String(node.attrs.sourceType ?? 'unknown'),
      class: 'doc-preserved-block',
      contenteditable: 'false',
      role: 'note',
      'aria-label': `保留的导入内容：${String(node.attrs.label ?? '未支持的内容')}`,
    }, `保留内容 · ${String(node.attrs.label ?? '未支持的内容')}`];
  },
});

const ColumnLayout = Node.create({
  name:'columnLayout', group:'block', content:'column+', defining:true,
  parseHTML(){return [{tag:'div[data-local-columns]'}];},
  renderHTML(){return ['div',{'data-local-columns':'',class:'doc-column-layout'},0];},
});
const Column = Node.create({
  name:'column', content:'block+', isolating:true,
  addAttributes(){return {widthRatio:{default:1,parseHTML:element=>Number(element.getAttribute('data-width-ratio'))||1,renderHTML:attrs=>({'data-width-ratio':attrs.widthRatio,style:`flex: ${Number(attrs.widthRatio)>0&&Number(attrs.widthRatio)<=1?Number(attrs.widthRatio):1} 1 0`})}};},
  parseHTML(){return [{tag:'div[data-local-column]'}];},
  renderHTML({HTMLAttributes}){return ['div',{...HTMLAttributes,'data-local-column':'',class:'doc-column'},0];},
});
const LocalWhiteboard=Node.create({
  name:'localWhiteboard',group:'block',atom:true,selectable:true,
  addAttributes(){return {sourceId:{default:null},payload:{default:null},images:{default:[]}};},
  parseHTML(){return [];},
  renderHTML(){return ['div',{'data-local-whiteboard':'',class:'local-whiteboard'},'本地画板'];},
});
const LocalBase=Node.create({
  name:'localBase',group:'block',atom:true,selectable:true,
  addAttributes(){return {sourceId:{default:null},payload:{default:null}};},
  parseHTML(){return [];},
  renderHTML(){return ['div',{'data-local-base':'',class:'local-base'},'本地多维表格'];},
});

const BackgroundColor = Extension.create({
  name: 'localBackgroundColor',
  addGlobalAttributes() {
    return [{ types:['textStyle'], attributes:{ backgroundColor:{default:null,parseHTML:element=>element.style.backgroundColor || null,renderHTML:attrs=>attrs.backgroundColor ? {style:`background-color: ${attrs.backgroundColor}`} : {}} } }];
  },
});

export const DOCUMENT_EXTENSIONS = [
  StarterKit.configure({ link: false }),
  TextStyle,
  Color,
  BackgroundColor,
  FontFamily,
  FontSize,
  TextAlign.configure({ types: ['paragraph', 'heading'] }),
  TaskList,
  TaskItem.configure({ nested: true }),
  Table.configure({ resizable: true }),
  TableRow,
  TableHeader,
  TableCell,
  Image.configure({ inline: false, allowBase64: true }),
  PreservedBlock,
  ColumnLayout,
  Column,
  LocalWhiteboard,
  LocalBase,
];

export const DOCUMENT_SCHEMA = getSchema(DOCUMENT_EXTENSIONS);

function fail() {
  throw new Error('DOCUMENT_EDITOR_CONTENT_INVALID');
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stableEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => stableEqual(value, right[index]));
  }
  if (!isObject(left) || !isObject(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && stableEqual(left[key], right[key]));
}

function mergeColorMark(marks) {
  const result = [];
  for (const mark of marks ?? []) {
    if (!isObject(mark) || typeof mark.type !== 'string') fail();
    if (mark.attrs !== undefined && !isObject(mark.attrs)) fail();
    let next = { ...mark, ...(mark.attrs === undefined ? {} : { attrs: { ...mark.attrs } }) };
    if (mark.type === 'color') {
      if (!isObject(mark.attrs) || typeof mark.attrs.color !== 'string' || Object.keys(mark.attrs).some((key) => key !== 'color')) fail();
      next = { type: 'textStyle', attrs: { color: mark.attrs.color } };
    }
    const current = result.find((item) => item.type === next.type);
    if (!current) { result.push(next); continue; }
    if (current.attrs !== undefined || next.attrs !== undefined) {
      current.attrs ??= {};
      for (const [key, value] of Object.entries(next.attrs ?? {})) {
        if (current.attrs[key] !== undefined && !stableEqual(current.attrs[key], value)) fail();
        current.attrs[key] = value;
      }
    }
  }
  return result;
}

function normalizeNode(input) {
  if (!isObject(input) || typeof input.type !== 'string') fail();
  const output = { ...input };
  if (input.marks !== undefined) {
    if (!Array.isArray(input.marks)) fail();
    output.marks = mergeColorMark(input.marks);
  }
  if (input.content !== undefined) {
    if (!Array.isArray(input.content)) fail();
    output.content = input.content.map(normalizeNode);
  }
  return output;
}

function checkKnownFields(json, allowed) {
  if (Object.keys(json).some((key) => !allowed.has(key))) fail();
}

function checkAttrs(inputAttrs, outputAttrs, declaredAttrs) {
  if (inputAttrs === undefined) return;
  if (!isObject(inputAttrs) || !isObject(outputAttrs)) fail();
  const allowed = new Set(Object.keys(declaredAttrs ?? {}));
  for (const [key, value] of Object.entries(inputAttrs)) {
    if (!allowed.has(key) || !Object.hasOwn(outputAttrs, key) || !stableEqual(value, outputAttrs[key])) fail();
  }
}

function assertNoLoss(input, output) {
  if (!isObject(input) || !isObject(output) || input.type !== output.type) fail();
  const type = DOCUMENT_SCHEMA.nodes[input.type];
  if (!type) fail();
  checkKnownFields(input, new Set(['type', 'attrs', 'content', 'marks', 'text']));
  checkAttrs(input.attrs, output.attrs, type.spec.attrs);
  if (input.type === 'text' && input.text !== output.text) fail();

  const inputMarks = input.marks ?? [];
  const outputMarks = output.marks ?? [];
  if (inputMarks.length !== outputMarks.length) fail();
  for (const mark of inputMarks) {
    if (!isObject(mark) || typeof mark.type !== 'string') fail();
    checkKnownFields(mark, new Set(['type', 'attrs']));
    const markType = DOCUMENT_SCHEMA.marks[mark.type];
    const actual = outputMarks.find((item) => item.type === mark.type);
    if (!markType || !actual) fail();
    checkAttrs(mark.attrs, actual.attrs, markType.spec.attrs);
  }

  const inputContent = input.content ?? [];
  const outputContent = output.content ?? [];
  if (inputContent.length !== outputContent.length) fail();
  for (let index = 0; index < inputContent.length; index += 1) assertNoLoss(inputContent[index], outputContent[index]);
}

/**
 * Normalize the contract's legacy standalone color mark and prove that the
 * actual configured ProseMirror schema can represent the complete document.
 * Throws before an editor is constructed if content would be dropped.
 */
export function preflightDocumentContent(content) {
  try {
    if (!isObject(content) || content.type !== 'doc' || !Array.isArray(content.content)) fail();
    const normalized = normalizeNode(content);
    const node = DOCUMENT_SCHEMA.nodeFromJSON(normalized);
    node.check();
    const roundTripped = node.toJSON();
    assertNoLoss(normalized, roundTripped);

    node.descendants((child) => {
      for(const mark of child.marks) {
        const background=mark.type.name==='textStyle' ? mark.attrs.backgroundColor : null;
        if(background!==null && background!==undefined && (typeof background!=='string' || !SAFE_BACKGROUND.test(background)))fail();
      }
      if (child.type.name === 'image' && !DATA_IMAGE.test(String(child.attrs.src ?? ''))) fail();
      if(child.type.name==='localWhiteboard') {
        validateWhiteboardPayload(child.attrs.payload);validateWhiteboardImages(child.attrs.images);
      }
      if(child.type.name==='localBase')try{validateBasePayload(child.attrs.payload);}catch{fail();}
    });
    return normalized;
  } catch (error) {
    if (error instanceof Error && error.message === 'DOCUMENT_EDITOR_CONTENT_INVALID') throw error;
    throw new Error('DOCUMENT_EDITOR_CONTENT_INVALID', { cause: error });
  }
}

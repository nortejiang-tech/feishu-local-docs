import React, { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { EditorContent, useEditor, ReactNodeViewRenderer } from '@tiptap/react';
import {
  AlignCenter, AlignLeft, AlignRight, Bold, CheckSquare, Code2, ImagePlus,
  Italic, List, ListOrdered, Merge, Minus, Plus, Quote, Redo2, Split,
  Strikethrough, Table2, Trash2, Underline as UnderlineIcon, Undo2,
} from 'lucide-react';
import './editor.css';
import { DOCUMENT_EXTENSIONS, preflightDocumentContent } from './editor-schema.mjs';
import WhiteboardView from './WhiteboardView.jsx';
import BaseView from './BaseView.jsx';
const VIEW_EXTENSIONS=DOCUMENT_EXTENSIONS.map(extension=>{
  const View={localWhiteboard:WhiteboardView,localBase:BaseView}[extension.name];
  return View?extension.extend({addNodeView(){return ReactNodeViewRenderer(View);}}):extension;
});

const IMAGE_MIME = /^image\/(?:png|jpeg|webp)$/;
const DATA_IMAGE = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]*={0,2}$/;

function ToolbarButton({ label, icon: Icon, onClick, active = false, disabled = false }) {
  return (
    <button
      type="button"
      className={`editor-tool-button${active ? ' is-active' : ''}`}
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      <Icon size={17} strokeWidth={1.8} aria-hidden="true" />
    </button>
  );
}

function dataUrlForImage(file) {
  return new Promise((resolve, reject) => {
    if (!IMAGE_MIME.test(file.type) || file.size <= 0 || file.size > 5 * 1024 * 1024) {
      reject(new Error('仅支持 5 MB 以内的 PNG、JPEG 或 WebP 图片。'));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取图片失败。'));
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      if (!DATA_IMAGE.test(dataUrl) || dataUrl.length > 12 * 1024 * 1024) {
        reject(new Error('图片编码格式不受支持。'));
        return;
      }
      resolve(dataUrl);
    };
    reader.readAsDataURL(file);
  });
}

const DocumentEditor = forwardRef(function DocumentEditor({ value, onChange }, ref) {
  const fileInputRef = useRef(null);
  const onChangeRef = useRef(onChange);
  const [imageError, setImageError] = useState('');
  onChangeRef.current = onChange;
  const editorRef = useRef(null);
  // App remounts this editor for each document ID. Full imported-media schema
  // validation is required at mount; repeating it on every caret transaction
  // serializes all drawing/image bytes and stalls large documents.
  const [initialContent] = useState(() => preflightDocumentContent(value));

  const rejectRemoteImages = (view, event, slice, textTransfer) => {
    let unsafeImage = false;
    slice?.content.descendants((node) => {
      if (node.type.name === 'image' && !DATA_IMAGE.test(String(node.attrs.src ?? ''))) unsafeImage = true;
    });
    if (!unsafeImage) return false;
    event.preventDefault();
    const plain = textTransfer?.getData('text/plain') ?? '';
    if (plain) {
      const { from, to } = view.state.selection;
      view.dispatch(view.state.tr.insertText(plain, from, to));
    }
    setImageError('外部图片不会联网加载；如需插入，请使用本地图片按钮。');
    return true;
  };

  const editor = useEditor({
    extensions: VIEW_EXTENSIONS,
    content: initialContent,
    immediatelyRender: false,
    shouldRerenderOnTransaction: true,
    editorProps: {
      attributes: {
        class: 'document-page',
        role: 'textbox',
        'aria-label': '文档正文',
        'aria-multiline': 'true',
        spellcheck: 'true',
      },
      handlePaste(view, event, slice) {
        return rejectRemoteImages(view, event, slice, event.clipboardData);
      },
      handleDrop(view, event, slice) {
        return rejectRemoteImages(view, event, slice, event.dataTransfer);
      },
    },
    onUpdate({ editor: changedEditor }) {
      onChangeRef.current?.(changedEditor.getJSON());
    },
  });
  editorRef.current = editor;

  useImperativeHandle(ref, () => ({
    async flush() { return editorRef.current?.getJSON() ?? value; },
    focus() { editorRef.current?.commands.focus(); },
  }), [value]);

  const insertImage = async (event) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file || !editorRef.current) return;
    setImageError('');
    try {
      const src = await dataUrlForImage(file);
      editorRef.current.chain().focus().setImage({ src, alt: file.name.slice(0, 200) }).run();
    } catch (error) {
      setImageError(error instanceof Error ? error.message : '读取图片失败。');
    }
  };

  if (!editor) return <div className="doc-editor is-loading" aria-label="文档编辑器加载中" />;
  const run = (action) => action(editor.chain().focus()).run();
  const can = (command) => command(editor.can().chain().focus()).run();

  return (
    <section className="doc-editor" aria-label="文档编辑器">
      <div className="editor-toolbar" role="toolbar" aria-label="文档格式工具">
        <label className="editor-select-label">
          <span className="visually-hidden">段落样式</span>
          <select
            aria-label="段落样式"
            value={editor.isActive('heading', { level: 1 }) ? 'h1' : editor.isActive('heading', { level: 2 }) ? 'h2' : 'p'}
            onChange={(event) => {
              const value = event.target.value;
              if (value === 'p') editor.chain().focus().setParagraph().run();
              else editor.chain().focus().toggleHeading({ level: Number(value.slice(1)) }).run();
            }}
          >
            <option value="p">正文</option><option value="h1">标题 1</option><option value="h2">标题 2</option>
          </select>
        </label>
        <span className="editor-tool-divider" aria-hidden="true" />
        <ToolbarButton label="加粗" icon={Bold} active={editor.isActive('bold')} disabled={!can((chain) => chain.toggleBold())} onClick={() => run((chain) => chain.toggleBold())} />
        <ToolbarButton label="斜体" icon={Italic} active={editor.isActive('italic')} disabled={!can((chain) => chain.toggleItalic())} onClick={() => run((chain) => chain.toggleItalic())} />
        <ToolbarButton label="下划线" icon={UnderlineIcon} active={editor.isActive('underline')} disabled={!can((chain) => chain.toggleUnderline())} onClick={() => run((chain) => chain.toggleUnderline())} />
        <ToolbarButton label="删除线" icon={Strikethrough} active={editor.isActive('strike')} disabled={!can((chain) => chain.toggleStrike())} onClick={() => run((chain) => chain.toggleStrike())} />
        <label className="editor-color-control" title="文字颜色">
          <span className="visually-hidden">文字颜色</span><span aria-hidden="true">A</span>
          <input type="color" aria-label="文字颜色" defaultValue="#1f2329" onChange={(event) => editor.chain().focus().setColor(event.target.value).run()} />
        </label>
        <span className="editor-tool-divider" aria-hidden="true" />
        <ToolbarButton label="左对齐" icon={AlignLeft} active={editor.isActive({ textAlign: 'left' })} onClick={() => editor.chain().focus().setTextAlign('left').run()} />
        <ToolbarButton label="居中对齐" icon={AlignCenter} active={editor.isActive({ textAlign: 'center' })} onClick={() => editor.chain().focus().setTextAlign('center').run()} />
        <ToolbarButton label="右对齐" icon={AlignRight} active={editor.isActive({ textAlign: 'right' })} onClick={() => editor.chain().focus().setTextAlign('right').run()} />
        <span className="editor-tool-divider" aria-hidden="true" />
        <ToolbarButton label="项目符号列表" icon={List} active={editor.isActive('bulletList')} onClick={() => run((chain) => chain.toggleBulletList())} />
        <ToolbarButton label="编号列表" icon={ListOrdered} active={editor.isActive('orderedList')} onClick={() => run((chain) => chain.toggleOrderedList())} />
        <ToolbarButton label="待办列表" icon={CheckSquare} active={editor.isActive('taskList')} onClick={() => run((chain) => chain.toggleTaskList())} />
        <ToolbarButton label="引用" icon={Quote} active={editor.isActive('blockquote')} onClick={() => run((chain) => chain.toggleBlockquote())} />
        <ToolbarButton label="代码块" icon={Code2} active={editor.isActive('codeBlock')} onClick={() => run((chain) => chain.toggleCodeBlock())} />
        <span className="editor-tool-divider" aria-hidden="true" />
        <ToolbarButton label="插入表格" icon={Table2} onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()} />
        <ToolbarButton label="插入图片" icon={ImagePlus} onClick={() => fileInputRef.current?.click()} />
        <input ref={fileInputRef} className="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp" aria-label="选择要嵌入的本地图片" onChange={insertImage} />
        {editor.isActive('table') && <>
          <span className="editor-tool-divider" aria-hidden="true" />
          <ToolbarButton label="在下方添加行" icon={Plus} onClick={() => editor.chain().focus().addRowAfter().run()} />
          <ToolbarButton label="在右侧添加列" icon={Plus} onClick={() => editor.chain().focus().addColumnAfter().run()} />
          <ToolbarButton label="合并单元格" icon={Merge} disabled={!editor.can().mergeCells()} onClick={() => editor.chain().focus().mergeCells().run()} />
          <ToolbarButton label="拆分单元格" icon={Split} disabled={!editor.can().splitCell()} onClick={() => editor.chain().focus().splitCell().run()} />
          <ToolbarButton label="删除表格" icon={Trash2} onClick={() => editor.chain().focus().deleteTable().run()} />
        </>}
        <span className="editor-tool-divider" aria-hidden="true" />
        <ToolbarButton label="插入分隔线" icon={Minus} onClick={() => editor.chain().focus().setHorizontalRule().run()} />
        <ToolbarButton label="撤销" icon={Undo2} disabled={!editor.can().undo()} onClick={() => editor.chain().focus().undo().run()} />
        <ToolbarButton label="重做" icon={Redo2} disabled={!editor.can().redo()} onClick={() => editor.chain().focus().redo().run()} />
      </div>
      {imageError && <div className="editor-inline-message" role="status">
        <span>{imageError}</span><button type="button" aria-label="关闭提示" onClick={() => setImageError('')}>关闭</button>
      </div>}
      <div className="document-canvas"><EditorContent editor={editor} /></div>
    </section>
  );
});

export default DocumentEditor;

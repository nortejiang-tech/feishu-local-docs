import React,{useMemo,useRef,useState} from 'react';
import {NodeViewWrapper} from '@tiptap/react';
import {buildWhiteboardScene} from '../../../shared/whiteboard-scene.mjs';
import {editWhiteboardNode} from '../../../shared/whiteboard-edit.mjs';
const safeImage=/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]*={0,2}$/;
export default function WhiteboardView({node,updateAttributes,editor}) {
  const scene=useMemo(()=>buildWhiteboardScene(node.attrs.payload),[node.attrs.payload]);
  const images=useMemo(()=>new Map(node.attrs.images.filter(image=>safeImage.test(image.dataUrl||'')).map(image=>[image.resourceId,image.dataUrl])),[node.attrs.images]);
  const [selected,setSelected]=useState(null),[draft,setDraft]=useState(null),[message,setMessage]=useState('');
  const svgRef=useRef(null),dragRef=useRef(null);
  const b=scene.bounds,pad=Math.max(8,Math.min(b.width,b.height)*0.02),box=[b.x-pad,b.y-pad,b.width+2*pad,b.height+2*pad];
  const choose=item=>{
    const stack=[...node.attrs.payload.nodes];let canText=false;
    while(stack.length){const value=stack.pop();if(value?.id===item.id)canText=!!value.info?.textV2;if(Array.isArray(value?.children))for(const child of value.children)if(child&&typeof child==='object')stack.push(child);}
    setSelected(item.id);setDraft({x:item.x,y:item.y,width:item.width,height:item.height,text:item.text,canText});setMessage('');
  };
  const apply=(id,changes)=>{
    try{updateAttributes({payload:editWhiteboardNode(node.attrs.payload,id,changes)});setMessage('画板修改已加入本地文档。');}catch{setMessage('这次修改未完成，画板数据仍保留。');}
  };
  const point=event=>{const matrix=svgRef.current.getScreenCTM();if(!matrix)return null;return new DOMPoint(event.clientX,event.clientY).matrixTransform(matrix.inverse());};
  const begin=(event,item)=>{
    choose(item);if(!editor.isEditable||event.button!==0||item.angle!==0)return;
    const p=point(event);if(!p)return;dragRef.current={id:item.id,p,x:item.x,y:item.y};event.currentTarget.setPointerCapture(event.pointerId);event.preventDefault();
  };
  const finish=event=>{
    const drag=dragRef.current;dragRef.current=null;if(!drag)return;
    const p=point(event);if(!p)return;const x=drag.x+p.x-drag.p.x,y=drag.y+p.y-drag.p.y;
    if(Math.abs(p.x-drag.p.x)+Math.abs(p.y-drag.p.y)>1){apply(drag.id,{x,y});setDraft(value=>({...value,x,y}));}
  };
  return <NodeViewWrapper className="local-whiteboard" contentEditable={false}>
    <div className="whiteboard-caption">画板 · {scene.items.length} 个图形节点</div>
    <svg ref={svgRef} className="whiteboard-preview" viewBox={box.join(' ')} preserveAspectRatio="xMidYMid meet" role="group" aria-label="本地画板预览" style={{aspectRatio:`${box[2]} / ${box[3]}`}}>
      {scene.items.map(item=><g key={item.id} role="button" aria-label={`画板图形 ${item.text||item.kind}`} tabIndex={0} onPointerDown={event=>begin(event,item)} onPointerUp={finish} onPointerCancel={()=>{dragRef.current=null;}} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();choose(item);}}}>
        {item.kind==='image'&&images.has(item.resourceId)?<image href={images.get(item.resourceId)} x={item.x} y={item.y} width={item.width} height={item.height}/>:<rect x={item.x} y={item.y} width={item.width} height={item.height} fill={item.kind==='text'?'#fff':'#f5f6f8'} stroke="#c3c7d0" strokeWidth={Math.max(1,b.width/800)}/>}
        {item.text&&<text x={item.x+item.width*0.03} y={item.y+Math.min(item.height*0.7,Math.max(18,item.height*0.2))} fontSize={Math.max(12,Math.min(32,item.height*0.16))} fill="#1f2329">{item.text.slice(0,180)}</text>}
        {item.kind==='image'&&!images.has(item.resourceId)&&<text x={item.x+item.width*0.05} y={item.y+item.height/2} fontSize={Math.max(12,Math.min(32,item.height*0.15))}>图片数据未读取</text>}
        {selected===item.id&&<rect x={item.x} y={item.y} width={item.width} height={item.height} fill="none" stroke="#386bff" strokeWidth={Math.max(2,b.width/500)}/>}
      </g>)}
    </svg>
    <details className="whiteboard-properties"><summary>画板基础编辑</summary>
      <p>可移动图形和修改文字。复杂形状、旋转、连线和文字样式尚未完整显示；原始节点仍保存在文件中。</p>
      {(scene.unsupportedCount>0||scene.omittedCount>0)&&<p>{scene.unsupportedCount} 个节点需要完善显示，{scene.omittedCount} 个节点未加入预览。</p>}
      {draft&&<form onSubmit={event=>{event.preventDefault();apply(selected,{x:Number(draft.x),y:Number(draft.y),width:Number(draft.width),height:Number(draft.height),...(draft.canText?{text:draft.text}:{})});}}>
        {['x','y','width','height'].map((key,index)=><label key={key}>{['横坐标','纵坐标','宽度','高度'][index]}<input type="number" aria-label={`画板${['横坐标','纵坐标','宽度','高度'][index]}`} value={draft[key]} onChange={event=>setDraft({...draft,[key]:event.target.value})}/></label>)}
        {draft.canText&&<label>文字<textarea aria-label="画板节点文字" value={draft.text} onChange={event=>setDraft({...draft,text:event.target.value})}/></label>}
        <button type="submit" disabled={!editor.isEditable}>应用修改</button>
      </form>}
      {message&&<p role="status">{message}</p>}
    </details>
  </NodeViewWrapper>;
}

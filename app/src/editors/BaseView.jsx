import React,{useMemo,useState} from 'react';
import {NodeViewWrapper} from '@tiptap/react';
import {buildBaseGrid} from '../../../shared/base-grid.mjs';
import {editBaseCell} from '../../../shared/base-edit.mjs';
import {baseDateInput,epochFromBaseDate} from '../../../shared/base-date.mjs';

export default function BaseView({node,updateAttributes,editor}){
  const payload=node.attrs.payload,table=payload.table;
  const [viewId,setViewId]=useState(table.currentView||table.views[0]||''),[page,setPage]=useState(0),[columnPage,setColumnPage]=useState(0),[selected,setSelected]=useState(null),[message,setMessage]=useState('');
  const grid=useMemo(()=>buildBaseGrid(payload,viewId),[payload,viewId]);
  const view=table.viewMap[viewId]||table.viewMap[table.views[0]],timeZone=payload.sourceTimezone||Intl.DateTimeFormat().resolvedOptions().timeZone;
  const rows=grid.rows.slice(page*200,(page+1)*200),columns=grid.columns.slice(columnPage*50,(columnPage+1)*50);
  const cellText=(cell,col)=>{
    if(col.type!==5||cell.value===null)return cell.display;
    try{return baseDateInput(cell.value,timeZone,!table.fieldMap[col.id].property?.timeFormat).replace('T',' ');}catch{return '日期超出当前编辑范围';}
  };
  const select=(row,cell,col)=>{
    setMessage('');if(!cell.editable){setMessage('这类单元格已保留原始数据，编辑功能仍待完善。');return;}
    let draft=cell.value??'';
    if(col.type===5)try{draft=baseDateInput(cell.value,timeZone,!table.fieldMap[col.id].property?.timeFormat);}catch{setMessage('该日期已保留，但暂时不能在这里编辑。');return;}
    setSelected({recordId:row.id,fieldId:col.id,type:col.type,name:col.name,draft,originalDraft:draft});
  };
  const apply=(clear=false)=>{
    if(!selected||!editor.isEditable)return;
    if(!clear&&selected.draft===selected.originalDraft){setSelected(null);return;}
    try{
      const value=clear?null:selected.type===5?epochFromBaseDate(selected.draft,timeZone):selected.type===3?(selected.draft||null):selected.draft;
      updateAttributes({payload:editBaseCell(payload,selected.recordId,selected.fieldId,value)});
      setSelected(null);setMessage('单元格修改已加入本地文档。');
    }catch{setMessage(selected.type===5?'这个日期无法确定，请检查日期和时区。':'这次修改未完成，原始单元格仍保留。');}
  };
  return <NodeViewWrapper className="local-base" contentEditable={false}>
    <div className="base-caption"><strong>多维表格</strong><span>{grid.columns.length} 个字段 · {grid.rows.length} 条记录</span>
      {table.views.length>0&&<label>原视图<select aria-label="多维表格原视图" value={viewId} onChange={event=>{setViewId(event.target.value);setPage(0);setSelected(null);}}>{table.views.map(id=><option key={id} value={id}>{table.viewMap[id].name}</option>)}</select></label>}
    </div>
    <p className="base-notice">已读取字段与记录。{view?.type===5?'原文件的甘特图配置已保留，时间线布局仍待恢复。':'筛选、排序、分组与视图布局仍待核对。'}回导效果尚未验收。</p>
    {Number.isSafeInteger(table.meta.recordsNum)&&table.meta.recordsNum!==grid.rows.length&&<p className="base-notice">原文件声明 {table.meta.recordsNum} 条记录，本次读取 {grid.rows.length} 条，记录覆盖仍待核对。</p>}
    <div className="base-grid-scroll"><table className="base-data-grid" aria-label="本地多维表格数据"><thead><tr><th scope="col">序号</th>{columns.map(col=><th scope="col" key={col.id}>{col.name}</th>)}</tr></thead>
      <tbody>{rows.map((row,index)=><tr key={row.id}><th scope="row">{page*200+index+1}</th>{columns.map(col=>{
        const cell=row.cells.find(c=>c.fieldId===col.id),text=cellText(cell,col);
        return <td key={col.id}><button type="button" className={cell.editable?'base-cell':'base-cell base-cell-readonly'} aria-label={`${col.name} 第${page*200+index+1}行`} onClick={()=>select(row,cell,col)}>{text.length>300?text.slice(0,300)+'…':text||'　'}</button></td>;
      })}</tr>)}</tbody></table></div>
    {(grid.rows.length>200||grid.columns.length>50)&&<div className="base-pagination">
      <button type="button" disabled={page===0} onClick={()=>{setPage(page-1);setSelected(null);}}>上一页记录</button><span>第 {page+1}/{Math.max(1,Math.ceil(grid.rows.length/200))} 页</span><button type="button" disabled={(page+1)*200>=grid.rows.length} onClick={()=>{setPage(page+1);setSelected(null);}}>下一页记录</button>
      {grid.columns.length>50&&<><button type="button" disabled={columnPage===0} onClick={()=>{setColumnPage(columnPage-1);setSelected(null);}}>前一组字段</button><button type="button" disabled={(columnPage+1)*50>=grid.columns.length} onClick={()=>{setColumnPage(columnPage+1);setSelected(null);}}>后一组字段</button></>}
    </div>}
    {selected&&<form className="base-cell-editor" onSubmit={event=>{event.preventDefault();apply();}}>
      <label>{selected.name}
        {selected.type===1?<textarea aria-label="多维表格文字内容" maxLength={100000} value={selected.draft} onChange={event=>setSelected({...selected,draft:event.target.value})}/>:
         selected.type===3?<select aria-label="多维表格单选内容" value={selected.draft} onChange={event=>setSelected({...selected,draft:event.target.value})}><option value="">空</option>{grid.columns.find(c=>c.id===selected.fieldId).options.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}</select>:
         <input aria-label="多维表格日期内容" type={table.fieldMap[selected.fieldId].property?.timeFormat?'datetime-local':'date'} step="0.001" value={selected.draft} onChange={event=>setSelected({...selected,draft:event.target.value})}/>}
      </label>
      {selected.type===5&&<small>日期按原页面时区 {timeZone} 显示。</small>}
      <div><button type="submit" disabled={!editor.isEditable}>应用修改</button><button type="button" disabled={!editor.isEditable} onClick={()=>apply(true)}>清空内容</button><button type="button" onClick={()=>setSelected(null)}>取消</button></div>
    </form>}
    {grid.unsupportedCells>0&&<p className="base-notice">{grid.unsupportedCells} 个单元格含有暂不支持的字段或结构；原始值仍保存在本地文件中。</p>}
    {message&&<p role="status">{message}</p>}
  </NodeViewWrapper>;
}

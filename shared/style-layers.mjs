// Univer composes top-level style keys by priority; nested values are atomic.
// Resolve only requested IDs, so a cell render does not scan the whole style table.
const fail=()=>{throw Error('STYLE_LAYERS_INVALID');};
const forbidden=new Set(['__proto__','prototype','constructor']);
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[null,Object.prototype].includes(Object.getPrototypeOf(value));
function data(object,key){const d=Object.getOwnPropertyDescriptor(object,key);if(!d||!('value' in d))fail();return d.value;}
function copy(value,depth,seen,budget){
  if(--budget.nodes<0||depth>16)fail();
  if(value===null||typeof value==='boolean')return value;
  if(typeof value==='string'){if(value.length>100000)fail();return value;}
  if(typeof value==='number'){if(!Number.isFinite(value))fail();return value;}
  if(!Array.isArray(value)&&!plain(value))fail();
  if(seen.has(value))fail();seen.add(value);
  let out;
  if(Array.isArray(value)){
    if(value.length>1000)fail();out=[];
    for(let i=0;i<value.length;i++){if(!Object.hasOwn(value,i))fail();out.push(copy(data(value,String(i)),depth+1,seen,budget));}
  }else{
    const keys=Reflect.ownKeys(value);if(keys.length>128)fail();out={};
    for(const key of keys){if(typeof key!=='string'||forbidden.has(key))fail();out[key]=copy(data(value,key),depth+1,seen,budget);}
  }
  seen.delete(value);return out;
}
export function composeStyleLayers(table,layers){
  if(!table||typeof table!=='object'||Array.isArray(table)||!Array.isArray(layers)||layers.length>8)fail();
  const style={},missing=[],reported=new Set(),budget={nodes:20000};
  for(let source of layers){
    if(source==null)continue;
    if(typeof source==='string'){
      if(source.length>100000||forbidden.has(source))fail();
      const id=source;source=Object.hasOwn(table,id)?data(table,id):null;
      if(source==null){if(!reported.has(id)){missing.push(id);reported.add(id);}continue;}
    }
    if(!plain(source))fail();
    const keys=Reflect.ownKeys(source);if(keys.length>128)fail();
    for(const key of keys){
      if(typeof key!=='string'||forbidden.has(key))fail();
      const value=data(source,key);if(value===undefined)continue;
      style[key]=copy(value,2,new Set([source]),budget);
    }
  }
  return {style,missing};
}

import {validateWhiteboardPayload} from './embedded-data.mjs';
export function editWhiteboardNode(payload,id,changes) {
  validateWhiteboardPayload(payload);
  if(typeof id!=='string'||!changes||typeof changes!=='object'||Array.isArray(changes)||Object.keys(changes).some(key=>!['x','y','width','height','text'].includes(key)))throw Error('WHITEBOARD_EDIT_INVALID');
  for(const key of ['x','y','width','height'])if(changes[key]!==undefined&&(!Number.isFinite(changes[key])||Math.abs(changes[key])>1000000||['width','height'].includes(key)&&changes[key]<=0))throw Error('WHITEBOARD_EDIT_INVALID');
  if(changes.text!==undefined&&(typeof changes.text!=='string'||changes.text.length>100000))throw Error('WHITEBOARD_EDIT_INVALID');
  const copy=JSON.parse(JSON.stringify(payload)),stack=[...copy.nodes];let target=null;
  while(stack.length){const node=stack.pop();if(!node||typeof node!=='object')continue;if(node.id===id){if(target)throw Error('WHITEBOARD_EDIT_INVALID');target=node;}if(Array.isArray(node.children))for(const child of node.children)if(child&&typeof child==='object')stack.push(child);}
  if(!target?.info?.baseV2)throw Error('WHITEBOARD_EDIT_INVALID');
  for(const key of ['x','y','width','height'])if(changes[key]!==undefined)target.info.baseV2[key]=changes[key];
  if(changes.text!==undefined){if(!target.info.textV2)throw Error('WHITEBOARD_EDIT_INVALID');target.info.textV2.text=changes.text;}
  validateWhiteboardPayload(copy);
  return copy;
}

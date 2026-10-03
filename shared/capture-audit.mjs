// Coverage diagnostics for already validated capture and editor data. This is
// not a security validator or a full-fidelity acceptance decision.
const labels={image:'图片',file:'附件',whiteboard:'画板',bitable:'多维表格',fallback:'嵌入内容',iframe:'嵌入内容'};
export function buildCaptureAudit(snapshot, assets=[], content=null, embeds=[]) {
  const blocks=Array.isArray(snapshot?.model?.blocks)?snapshot.model.blocks:[];
  const issues=Array.isArray(snapshot?.issues)?snapshot.issues:[];
  const types=new Map(),gaps=new Map(),objects=[],seen=new Set(),byId=new Map(),reported=new Set();
  const counts={tables:0,tableCells:0,images:0,files:0,whiteboards:0,bases:0,otherEmbeds:0,editableTables:0,renderedImages:0,resourcesWithBytes:0,previewResources:0,missingResources:0};
  const add=(map,key,n=1)=>{if(key&&n>0)map.set(key,(map.get(key)||0)+n);};
  const drawings=new Map((Array.isArray(embeds)?embeds:[]).map(entry=>[entry.sourceId,entry]));
  counts.structuredWhiteboards=0;
  counts.structuredBases=0;
  for(const asset of Array.isArray(assets)?assets:[])if(typeof asset?.sourceId==='string'&&!byId.has(asset.sourceId))byId.set(asset.sourceId,asset);
  for(const issue of issues) {
    if(typeof issue?.code!=='string'||!issue.code)continue;
    const n=issue.count===undefined?1:issue.count;
    if(!Number.isInteger(n)||n<=0)continue;
    add(gaps,issue.code,n);
    if(typeof issue.sourceId==='string')reported.add(issue.sourceId+'\u0000'+issue.code);
  }
  for(const block of blocks) {
    const type=typeof block?.type==='string'?block.type.toLowerCase():'';
    add(types,type);
    if(type==='table')counts.tables++;
    if(type==='table_cell')counts.tableCells++;
    const id=typeof block?.id==='string'?block.id:'';
    if(id&&seen.has(id)){add(gaps,'DUPLICATE_BLOCK_ID');continue;}
    if(id)seen.add(id);
    if(!Object.hasOwn(labels,type))continue;
    const kind=type==='iframe'?'fallback':type,asset=byId.get(id);
    const bytes=Number.isInteger(asset?.byteLength)&&asset.byteLength>0&&typeof asset.dataUrl==='string'&&asset.dataUrl.length>0;
    const drawing=drawings.get(id),structured=kind==='whiteboard'&&drawing?.status==='STRUCTURE_CANDIDATE'&&Array.isArray(drawing.payload?.nodes);
    const base=kind==='bitable'&&drawing?.status==='VIEW_SNAPSHOT'&&drawing.payload?.format==='feishu-bitable-table';
    const status=base?'VIEW_SNAPSHOT':structured?'STRUCTURE_CANDIDATE':bytes?(['PREVIEW','ORIGINAL_CANDIDATE','ORIGINAL'].includes(asset.status)?asset.status:'UNVERIFIED'):'MISSING';
    const explicit=structured||base?drawing.code:typeof asset?.code==='string'&&asset.code?asset.code:null;
    const code=explicit||(bytes?'RESOURCE_VERIFICATION_PENDING':'RESOURCE_BYTES_MISSING');
    const objectCodes=new Set();
    if(!bytes||explicit||status!=='ORIGINAL')objectCodes.add(code);
    if(structured&&drawing.resourceCount>0)objectCodes.add('WHITEBOARD_RESOURCE_BYTES_PENDING');
    if(status==='PREVIEW')objectCodes.add('RESOURCE_PREVIEW_ONLY');
    if(status==='ORIGINAL_CANDIDATE'||status==='UNVERIFIED')objectCodes.add('RESOURCE_VERIFICATION_PENDING');
    for(const c of objectCodes)if(!reported.has(id+'\u0000'+c))add(gaps,c);
    if(kind==='image')counts.images++;else if(kind==='file')counts.files++;else if(kind==='whiteboard')counts.whiteboards++;else if(kind==='bitable')counts.bases++;else counts.otherEmbeds++;
    if(bytes)counts.resourcesWithBytes++;else if(!structured&&!base)counts.missingResources++;
    if(structured)counts.structuredWhiteboards++;
    if(base)counts.structuredBases++;
    if(status==='PREVIEW')counts.previewResources++;
    objects.push({sourceId:id,kind,label:typeof block.resource?.name==='string'&&block.resource.name.trim()?block.resource.name.trim():labels[type],status,code,byteLength:structured||base?drawing.byteLength:bytes?asset.byteLength:0});
  }
  const stack=content?[content]:[];
  while(stack.length) {
    const node=stack.pop();
    if(node?.type==='table')counts.editableTables++;
    if(node?.type==='image')counts.renderedImages++;
    if(Array.isArray(node?.content))for(const child of node.content)stack.push(child);
  }
  if(!gaps.has('ROUNDTRIP_VERIFICATION_PENDING'))gaps.set('ROUNDTRIP_VERIFICATION_PENDING',1);
  const sorted=map=>[...map].sort(([a],[b])=>a<b?-1:a>b?1:0);
  return {status:'PENDING',capturedBlocks:blocks.length,types:sorted(types).map(([type,count])=>({type,count})),objects,counts,gaps:sorted(gaps).map(([code,count])=>({code,count}))};
}

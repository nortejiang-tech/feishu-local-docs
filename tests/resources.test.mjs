import test from 'node:test';
import assert from 'node:assert/strict';
import {captureResources} from '../extension/resources.mjs';
const source='https://sample.feishu.cn/docx/abc';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXxoAAAAASUVORK5CYII=','base64');
function setup(t,{urls=[],fetcher}={}) {
 const saved=new Map();for(const key of ['location','document','performance','fetch','window'])saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
 Object.defineProperty(globalThis,'location',{configurable:true,value:{origin:'https://sample.feishu.cn',pathname:'/docx/abc'}});
 Object.defineProperty(globalThis,'document',{configurable:true,value:{querySelectorAll:()=>[]}});
 Object.defineProperty(globalThis,'performance',{configurable:true,value:{getEntriesByType:()=>urls.map(name=>({name}))}});
 Object.defineProperty(globalThis,'fetch',{configurable:true,value:fetcher||(()=>{throw Error('fetch must not run')})});
 t.after(()=>{for(const [key,d] of saved)if(d)Object.defineProperty(globalThis,key,d);else delete globalThis[key];});
}
const resource={sourceId:'img',resourceId:'asset123',kind:'image',size:png.length,width:100,height:80};
test('reads an observed cover as preview, validates signature and computes asset hash',async t=>{
 let fetched;
 setup(t,{urls:['https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/v2/cover/other/?width=600&height=400&policy=1'],fetcher:async(url,options)=>{fetched={url,options};return new Response(png,{headers:{'content-type':'image/png','content-length':String(png.length)}});}});
 const result=await captureResources({expectedSource:source,resources:[resource]});
 assert.equal(result.ok,true);assert.equal(result.assets[0].status,'PREVIEW');assert.equal(result.assets[0].code,'RESOURCE_PREVIEW_ONLY');
 assert.ok(result.assets[0].dataUrl.startsWith('data:image/png;base64,'));assert.equal(result.assets[0].byteLength,png.length);
 assert.match(result.assets[0].sha256,/^[a-f0-9]{64}$/);
 assert.ok(fetched.url.includes('/cover/asset123/'));assert.equal(fetched.options.redirect,'error');
 assert.ok(!JSON.stringify(result).includes('https:'));
});
test('unsafe hosts, paths and credential-like query parameters never cause a request',async t=>{
 setup(t,{urls:['https://evil.example/space/api/box/stream/download/v2/cover/asset123/','https://internal-api-drive-stream.feishu.cn/other/asset123/','https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/v2/cover/asset123/?token=private']});
 const r=await captureResources({expectedSource:source,resources:[resource]});assert.equal(r.assets[0].code,'RESOURCE_URL_UNAVAILABLE');
});
test('permission denial and nonimage bytes remain explicit missing resources',async t=>{
 const url='https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/v2/cover/asset123/';
 setup(t,{urls:[url],fetcher:async()=>new Response('denied',{status:403})});
 assert.equal((await captureResources({expectedSource:source,resources:[resource]})).assets[0].code,'RESOURCE_PERMISSION_DENIED');
 globalThis.fetch=async()=>new Response('html',{headers:{'content-type':'image/png'}});
 assert.equal((await captureResources({expectedSource:source,resources:[resource]})).assets[0].code,'RESOURCE_SIGNATURE_INVALID');
});
test('size limits stop streams and unsupported embedded adapters are never called',async t=>{
 setup(t,{urls:['https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/v2/cover/asset123/'],fetcher:async()=>new Response(png,{headers:{'content-type':'image/png','content-length':'7000000'}})});
 const r=await captureResources({expectedSource:source,resources:[resource,{sourceId:'f',resourceId:'file',kind:'file'}]});
 assert.equal(r.assets[0].code,'RESOURCE_BYTE_LIMIT');assert.equal(r.assets[1].code,'EMBEDDED_ADAPTER_PENDING');
});
test('source navigation aborts the result instead of mixing two documents',async t=>{
 setup(t,{urls:['https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/v2/cover/asset123/'],fetcher:async()=>{globalThis.location.pathname='/docx/different';return new Response(png,{headers:{'content-type':'image/png'}});}});
 assert.equal((await captureResources({expectedSource:source,resources:[resource]})).code,'SOURCE_CHANGED');
});
test('only the observed whiteboard preview path and query may supply image bytes',async t=>{
 let calls=0;
 setup(t,{fetcher:async()=>{calls++;return new Response(png,{headers:{'content-type':'image/png'}});}});
 const url='https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/preview/asset123?preview_type=16';
 const r=await captureResources({expectedSource:source,resources:[{...resource,observedPreview:url}]});
 assert.equal(r.assets[0].status,'PREVIEW');assert.equal(calls,1);assert.ok(!JSON.stringify(r).includes('https:'));
 for(const invalid of [url.replace('asset123','other'),url+'&signature=private',url.replace('16','1'),url.replace('internal-api-drive-stream.feishu.cn','evil.example')]){
  assert.equal((await captureResources({expectedSource:source,resources:[{...resource,observedPreview:invalid}]})).assets[0].code,'RESOURCE_URL_UNAVAILABLE');
 }
 assert.equal(calls,1);
});
test('observed document mount reference is accepted but not exported',async t=>{
 let url;
 setup(t,{urls:['https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/v2/cover/other/?mount_node_token=sourceDocument123&mount_point=docx_image&policy=equal'],fetcher:async u=>{url=u;return new Response(png,{headers:{'content-type':'image/png'}});}});
 const r=await captureResources({expectedSource:source,resources:[resource]});
 assert.equal(r.assets[0].status,'PREVIEW');assert.ok(url.includes('mount_node_token=sourceDocument123'));
 assert.ok(!JSON.stringify(r).includes('sourceDocument123'));
});
function nativePage(fetcher,token='asset123') {
 globalThis.window={PageMain:{editor:{editor:{api:{modelService:{allBlockModels:[{type:'image',struct:{record:{id:'img',snapshot:{image:{token}}}},imageManager:{fetch:fetcher}}]}}}}}};
}
test('native image reader consumes only the local blob, never CDN fields or keys',async t=>{
 let options,url,request;
 setup(t,{fetcher:async(u,o)=>{url=u;options=o;return new Response(png,{headers:{'content-type':'image/png'}});}});
 nativePage((args,unused,done)=>{request=args;done({src:'blob:https://sample.feishu.cn/local-image',originSrc:'https://cdn.example/?private=do-not-copy',key:'do-not-copy'});return Promise.resolve();});
 const r=await captureResources({expectedSource:source,resources:[resource]});
 assert.equal(url,'blob:https://sample.feishu.cn/local-image');assert.equal(options.credentials,'omit');
 assert.equal(request.isHD,true);assert.equal(request.token,resource.resourceId);
 assert.equal(r.assets[0].status,'ORIGINAL_CANDIDATE');assert.equal(r.assets[0].code,'RESOURCE_ORIGINAL_UNVERIFIED');
 assert.ok(!JSON.stringify(r).includes('do-not-copy'));
});
test('native size mismatch stays preview, invalid object origins and resource mismatches never fetch',async t=>{
 setup(t,{fetcher:async()=>new Response(png,{headers:{'content-type':'image/png'}})});
 nativePage((args,unused,done)=>{done({src:'blob:https://sample.feishu.cn/local-image'});return Promise.resolve();});
 assert.equal((await captureResources({expectedSource:source,resources:[{...resource,size:png.length+1}]})).assets[0].status,'PREVIEW');
 globalThis.fetch=()=>{throw Error('must not fetch');};
 nativePage((args,unused,done)=>{done({src:'blob:https://evil.example/remote'});return Promise.resolve();});
 assert.equal((await captureResources({expectedSource:source,resources:[resource]})).assets[0].code,'RESOURCE_URL_UNAVAILABLE');
 nativePage(()=>{throw Error('must not invoke');},'different-resource');
 assert.equal((await captureResources({expectedSource:source,resources:[resource]})).assets[0].code,'RESOURCE_URL_UNAVAILABLE');
});

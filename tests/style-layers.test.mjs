import test from 'node:test';import assert from 'node:assert/strict';import {composeStyleLayers} from '../shared/style-layers.mjs';
test('ordered layers preserve explicit resets and replace nested styles atomically',()=>{const table={base:{ff:'Arial',bl:1,bd:{t:{s:1},b:{s:2}}},row:{bl:0,bg:null,bd:{l:{s:3}}}};const before=JSON.stringify(table);const out=composeStyleLayers(table,['base',undefined,'row',{ff:undefined,it:false}]);assert.deepEqual(out,{style:{ff:'Arial',bl:0,bg:null,bd:{l:{s:3}},it:false},missing:[]});out.style.bd.l.s=9;assert.equal(JSON.stringify(table),before);});
test('missing references are explicit and inherited references never resolve',()=>{const table=Object.create({inherited:{bl:1}});table.y=null;assert.deepEqual(composeStyleLayers(table,['missing','inherited','missing','y']),{style:{},missing:['missing','inherited','y']});});
test('invalid data rejects instead of omitting or executing it',()=>{const cycle={};cycle.n=cycle;for(const x of [42,[],{x:Infinity},{x:()=>1},{x:{nested:undefined}},{x:cycle},JSON.parse('{"__proto__":1}')])assert.throws(()=>composeStyleLayers({},[x]),/STYLE_LAYERS_INVALID/);assert.throws(()=>composeStyleLayers({},Array(9).fill(null)),/STYLE_LAYERS_INVALID/);});
test('top-level absent keys fall through and empty layers stay deterministic',()=>{assert.deepEqual(composeStyleLayers({},[null,{}, {bl:1},{bl:undefined}]),{style:{bl:1},missing:[]});assert.deepEqual(composeStyleLayers({},[]),{style:{},missing:[]});});
test('top-level precedence matches the exact installed editor implementation',async()=>{
 const {composeStyles}=await import('../app/node_modules/@univerjs/core/lib/es/index.js');
 const layers=[{ff:'Arial',bd:{t:{s:1}}},{bl:1,bg:{rgb:'#aabbcc'}},{bl:0,bd:{b:{s:2}}},{ff:undefined,fs:18}];
 assert.deepEqual(composeStyleLayers({},layers).style,composeStyles(...layers));
});
test('arrays copy independently and accessors do not execute',()=>{
 const layer={extra:[{v:1}]},out=composeStyleLayers({},[layer]);out.style.extra[0].v=2;assert.equal(layer.extra[0].v,1);
 const evil={};Object.defineProperty(evil,'bl',{get(){throw Error('executed');},enumerable:true});assert.throws(()=>composeStyleLayers({},[evil]),/^Error: STYLE_LAYERS_INVALID$/);
});

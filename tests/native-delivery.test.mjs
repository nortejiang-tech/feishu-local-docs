import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,readFile} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {spawn,spawnSync} from 'node:child_process';
import {createDocument,encodeDocument} from '../shared/model.mjs';
function run(bin,args,input){return new Promise((resolve,reject)=>{const p=spawn(bin,args,{stdio:['pipe','pipe','pipe']});let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('error',reject);p.on('exit',code=>resolve({code,out,err}));p.stdin.end(input);});}
test('native store writes, verifies, deduplicates, recovers and isolates real temporary files',{skip:process.platform!=='darwin'},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'localdocs-native-test-'));
 const main=path.join(root,'main.swift');await writeFile(main,await readFile(new URL('./native-delivery.swift',import.meta.url)));
 const bin=path.join(root,'delivery-tests');const build=spawnSync('swiftc',['-swift-version','5','desktop/NativeDelivery.swift',main,'-o',bin],{encoding:'utf8'});assert.equal(build.status,0,build.stderr);
 const doc=createDocument();doc.issues=[{code:'SYNTHETIC_MISSING',count:1}];const text=await encodeDocument(doc);
 const checks=await run(bin,[path.join(root,'single')],text);assert.equal(checks.code,0,checks.err);assert.equal(checks.out.trim(),'PASS 18');
 const concurrent=path.join(root,'concurrent');await mkdir(concurrent);
 const results=await Promise.all(Array.from({length:6},()=>run(bin,[concurrent,'save'],text)));
 for(const result of results)assert.equal(result.code,0,result.err);
 assert.equal(results.filter(r=>r.out.trim()==='CREATED').length,1);assert.equal(results.filter(r=>r.out.trim()==='REUSED').length,5);
});

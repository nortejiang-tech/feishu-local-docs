import {readFile,readdir,access} from 'node:fs/promises';
import path from 'node:path';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
const version=JSON.parse(await readFile('package.json','utf8')).version;
const folder=`dist/chrome-extension-${version}`;
const manifest=JSON.parse(await readFile(path.join(folder,'manifest.json'),'utf8'));
assert.equal(manifest.version,version);assert.equal(manifest.manifest_version,3);
assert.deepEqual(manifest.permissions,['activeTab','scripting','nativeMessaging','storage']);
for(const key of ['host_permissions','optional_host_permissions','content_scripts','externally_connectable','web_accessible_resources'])assert.equal(manifest[key],undefined);
assert.ok(manifest.content_security_policy.extension_pages.includes("connect-src 'none'"));
assert.ok(manifest.content_security_policy.extension_pages.includes("script-src 'self'"));
for(const file of [manifest.action.default_popup,manifest.background.service_worker,'popup.js','popup.css'])await access(path.join(folder,file));
const html=await readFile(path.join(folder,'popup.html'),'utf8'),js=await readFile(path.join(folder,'popup.js'),'utf8');
const ids=new Set([...html.matchAll(/id="([^" ]+)"/g)].map(m=>m[1]));
for(const [,id] of js.matchAll(/\$\(["']([^"']+)["']\)/g))assert.ok(ids.has(id),`Missing popup ID ${id}`);
assert.ok(!/<script(?![^>]*src=)[^>]*>/i.test(html));
for(const file of ['background.js','popup.js']){const source=await readFile(path.join(folder,file),'utf8');assert.ok(!/\beval\s*\(|new Function\s*\(|document\.cookie/.test(source));const result=spawnSync(process.execPath,['--check',path.join(folder,file)],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);}
for(const directory of ['shared','extension-next/src'])for(const file of await readdir(directory)){if(!file.endsWith('.mjs'))continue;const result=spawnSync(process.execPath,['--check',path.join(directory,file)],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);}
console.log(JSON.stringify({status:'PASS',version,extensionManifest:'PASS',packagedSyntax:'PASS',popupReferences:'PASS',automaticHostAccess:false,cloudFidelity:'PENDING'}));

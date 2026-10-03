import {readFile,writeFile,mkdir,mkdtemp,cp,rm,chmod} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {build} from '../app/node_modules/vite/dist/node/index.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const run=(bin,args,cwd=root)=>{const p=spawnSync(bin,args,{cwd,stdio:'inherit'});if(p.status!==0)throw new Error(`${bin} failed (${p.status})`)};
const extensionOnly=process.argv.includes('--extension-only');
const appVersion='0.2.8';
const outputArgument=process.argv.find(value=>value.startsWith('--application-output='));
const applicationOutput=outputArgument?.slice('--application-output='.length);
if(applicationOutput && !path.isAbsolute(applicationOutput))throw new Error('Application output must be an absolute path');
if(!extensionOnly)run('npm',['run','build'],path.join(root,'app'));
const identity=JSON.parse(await readFile(path.join(root,'extension-next/identity.json'),'utf8'));
const extension=path.join(root,`dist/chrome-extension-${appVersion}`);
await build({configFile:false,build:{target:'es2022',outDir:extension,emptyOutDir:true,lib:{entry:path.join(root,'extension-next/src/background.mjs'),formats:['es'],fileName:()=>'background.js'},minify:false}});
await cp(path.join(root,'extension-next/src/popup.mjs'),path.join(extension,'popup.js'));
for(const f of ['popup.html','popup.css'])await cp(path.join(root,'extension-next',f),path.join(extension,f));
await writeFile(path.join(extension,'manifest.json'),JSON.stringify({manifest_version:3,name:'本地文档 · 飞书助手',version:appVersion,key:identity.publicKey,description:'将当前飞书文档送到本地编辑器。当前采集完整性仍在验证。',minimum_chrome_version:'106',permissions:['activeTab','scripting','nativeMessaging'],action:{default_popup:'popup.html',default_title:'保存到本地'},background:{service_worker:'background.js',type:'module'},content_security_policy:{extension_pages:"script-src 'self'; object-src 'none'; connect-src 'none'; img-src 'self' data:; base-uri 'none'"}},null,2)+'\n');
if(extensionOnly) { console.log(JSON.stringify({status:'BUILT',extension,version:appVersion,extensionId:identity.extensionId})); process.exit(0); }
const bundle=applicationOutput || path.join(root,`dist/本地文档-${appVersion}.app`);
const staging=await mkdtemp(path.join(os.tmpdir(),'localdocs-build-'));
const stagedBundle=path.join(staging,'本地文档.app'),contents=path.join(stagedBundle,'Contents');
await mkdir(path.join(contents,'MacOS'),{recursive:true});await mkdir(path.join(contents,'Resources'),{recursive:true});
const xml=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
await writeFile(path.join(contents,'Info.plist'),`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>LocalDocs</string><key>CFBundleIdentifier</key><string>cn.localdocs.editor</string><key>CFBundleName</key><string>本地文档</string><key>CFBundleDisplayName</key><string>本地文档</string><key>CFBundleVersion</key><string>${appVersion}</string><key>CFBundleShortVersionString</key><string>${appVersion}</string><key>LSMinimumSystemVersion</key><string>13.0</string><key>NSHighResolutionCapable</key><true/><key>ChromeExtensionID</key><string>${identity.extensionId}</string><key>CFBundleDocumentTypes</key><array><dict><key>CFBundleTypeName</key><string>本地云文档</string><key>CFBundleTypeRole</key><string>Editor</string><key>LSHandlerRank</key><string>Owner</string><key>LSItemContentTypes</key><array><string>cn.localdocs.document</string></array></dict></array><key>UTExportedTypeDeclarations</key><array><dict><key>UTTypeIdentifier</key><string>cn.localdocs.document</string><key>UTTypeConformsTo</key><array><string>public.json</string></array><key>UTTypeDescription</key><string>本地云文档</string><key>UTTypeTagSpecification</key><dict><key>public.filename-extension</key><array><string>localdoc</string></array><key>public.mime-type</key><string>application/vnd.localdocs+json</string></dict></dict></array></dict></plist>`);
await rm(path.join(contents,'Resources/web'),{recursive:true,force:true});await cp(path.join(root,'app/dist'),path.join(contents,'Resources/web'),{recursive:true});
await cp(extension,path.join(contents,'Resources/ChromeExtension'),{recursive:true});
// Include dependency attribution from the exact installed lockfile, without fetching code.
const lock=JSON.parse(await readFile(path.join(root,'app/package-lock.json'),'utf8'));
let notices='# Third-party software notices\n\n';
for(const entry of Object.keys(lock.packages).filter(p=>p.startsWith('node_modules/'))) {
  const directory=path.join(root,'app',entry);
  try {
    const pkg=JSON.parse(await readFile(path.join(directory,'package.json'),'utf8'));
    notices+=`\n## ${pkg.name} ${pkg.version}\nLicense: ${JSON.stringify(pkg.license||'See package license')}\n`;
    for(const filename of ['LICENSE','LICENSE.md','LICENSE.txt','LICENCE','NOTICE','NOTICE.txt']) {
      try { const content=await readFile(path.join(directory,filename),'utf8'); if(content.length<300000)notices+=`\n${filename}\n\n${content}\n`; }catch{}
    }
  }catch{}
}
await writeFile(path.join(contents,'Resources/THIRD-PARTY-NOTICES.txt'),notices);
await writeFile(path.join(contents,'Resources/native-host'),'#!/bin/sh\nexec "$(dirname "$0")/../MacOS/LocalDocs" --native-host "$@"\n');await chmod(path.join(contents,'Resources/native-host'),0o755);
run('swiftc',['-swift-version','5','-O','-target','arm64-apple-macosx13.0',path.join(root,'desktop/LocalDocs.swift'),'-o',path.join(contents,'MacOS/LocalDocs')]);
// Sign outside File Provider locations, which can reattach Finder metadata while signing.
run('/usr/bin/codesign',['--force','--sign','-',stagedBundle]);
await rm(bundle,{recursive:true,force:true});
await cp(stagedBundle,bundle,{recursive:true});
run('/usr/bin/codesign',['--verify','--deep','--strict',bundle]);
await rm(staging,{recursive:true,force:true});
console.log(JSON.stringify({status:'BUILT',application:bundle,extension,extensionId:identity.extensionId,cloudRoundtrip:'PENDING'}));

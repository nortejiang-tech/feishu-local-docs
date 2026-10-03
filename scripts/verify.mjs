import { readFile, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extension = path.join(root, 'extension');
const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.deepEqual(manifest.permissions, ['activeTab', 'scripting']);
for (const disallowed of ['host_permissions', 'optional_host_permissions', 'content_scripts', 'externally_connectable', 'web_accessible_resources']) assert.equal(manifest[disallowed], undefined);
assert.ok(manifest.content_security_policy.extension_pages.includes("connect-src 'none'"));
await access(path.join(extension, manifest.background.service_worker));
const files = await readdir(extension);
for (const file of files) {
  const full = path.join(extension, file), text = await readFile(full, 'utf8');
  if (file.endsWith('.mjs')) {
    const result = spawnSync(process.execPath, ['--check', full], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    for (const [, reference] of text.matchAll(/from ['"](\.\/[^'"]+)['"]/g)) await access(path.resolve(extension, reference));
    assert.ok(!/\beval\s*\(|new Function\s*\(|XMLHttpRequest|document\.cookie|localStorage|sessionStorage/.test(text), file);
    if(file !== 'resources.mjs')assert.ok(!/\bfetch\s*\(/.test(text), file);
    else {
      assert.equal([...text.matchAll(/\bfetch\s*\(/g)].length,2);
      assert.ok(text.includes('block.imageManager.fetch('));
      assert.ok(text.includes("value.src.startsWith('blob:'+location.origin+'/')"));
      assert.ok(text.includes("u.hostname!=='internal-api-drive-stream.feishu.cn'"));
      assert.ok(text.includes("redirect:'error'"));
      assert.ok(text.includes('reader.cancel()'));
    }
  }
  if (file.endsWith('.html')) for (const [, reference] of text.matchAll(/(?:src|href)="([^"#]+)"/g)) { assert.ok(!reference.includes('://')); await access(path.join(extension, reference)); }
  if (file.endsWith('.css')) assert.ok(!/@import|url\(/.test(text));
}
const html = await readFile(path.join(extension, 'workbench.html'), 'utf8');
const js = await readFile(path.join(extension, 'workbench.mjs'), 'utf8');
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(x => x[1]));
for (const [, id] of js.matchAll(/\$\('([^']+)'\)/g)) assert.ok(ids.has(id), `Missing UI ID: ${id}`);
console.log(JSON.stringify({ status: 'PASS', extensionFiles: files.length, manifestPermissions: manifest.permissions, moduleSyntax: 'PASS', entryReferences: 'PASS', remoteCodeScan: 'PASS' }));

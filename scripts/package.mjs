import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const check = spawnSync(process.execPath, [path.join(root, 'scripts/verify.mjs')], { encoding: 'utf8' });
if (check.status !== 0) { process.stderr.write(check.stderr); process.exit(check.status || 1); }
const dist = path.join(root, 'dist'); await mkdir(dist, { recursive: true });
const entries = await readdir(path.join(root, 'extension'));
const hashes = {};
for (const name of entries.sort()) hashes[`extension/${name}`] = createHash('sha256').update(await readFile(path.join(root, 'extension', name))).digest('hex');
await writeFile(path.join(dist, 'source-sha256.json'), JSON.stringify(hashes, null, 2) + '\n');
const code = `import pathlib,sys,zipfile\nroot=pathlib.Path(sys.argv[1])\nwith zipfile.ZipFile(root/'dist/feishu-local-archive-0.1.0.zip','w',compression=zipfile.ZIP_DEFLATED) as z:\n for p in sorted((root/'extension').iterdir()):\n  if p.is_file(): z.write(p,p.relative_to(root))\n`;
const result = spawnSync('python3', ['-c', code, root], { encoding: 'utf8' });
if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(result.status || 1); }
console.log(JSON.stringify({ status: 'PASS', file: 'dist/feishu-local-archive-0.1.0.zip', files: entries.length, hashes: 'dist/source-sha256.json' }));

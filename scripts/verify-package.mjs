import { listPackage, statFile, extractFile } from '@electron/asar';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { defaultApplicationRoot, packagedPaths } from './package-paths.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expected = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const supplied = process.argv[2];
const suppliedArchive = supplied?.endsWith('.asar');
const applicationRoot = suppliedArchive ? path.resolve(path.dirname(supplied), path.basename(path.dirname(supplied)) === 'Resources' ? '../..' : '..') : supplied;
const application = packagedPaths(applicationRoot || defaultApplicationRoot(root));
const archive = suppliedArchive ? path.resolve(supplied) : application.archive;
const names = listPackage(archive).map(name => name.replace(/^[/\\]+/, '').replaceAll('\\', '/'));
const files = names.filter(name => !statFile(archive, name).files);
for (const required of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'desktop/main.mjs', 'desktop/platform.mjs', 'desktop/preload.cjs', 'assets/app.png', 'assets/app.ico', 'assets/app.icns']) assert(files.includes(required), `Required resource missing: ${required}`);
assert(!files.some(name => /\.sqlite(?:-|$)|market-cache|\.qa|browser-qa|desktop-qa|node_modules|ui-backup/.test(name)), 'No account or test data may be shipped');
const checks = [];
for (const file of files) {
  assert(/^(?:desktop|core|services)\/.*\.(?:mjs|cjs)$|^renderer\/.*\.(?:html|css|js)$|^assets\/.*\.(?:png|ico|icns|plist)$/.test(file) || ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'package.json'].includes(file), `Unexpected packaged file: ${file}`);
  const bytes = extractFile(archive, file);
  if (file === 'package.json') {
    const metadata = JSON.parse(bytes);
    for (const key of ['version', 'main', 'name', 'license']) assert.equal(metadata[key], expected[key]);
  } else assert.equal(Buffer.compare(bytes, await readFile(path.join(root, file))), 0, `Packaged source differs: ${file}`);
  checks.push({ file, sha256: createHash('sha256').update(bytes).digest('hex') });
}
for (const notice of ['LICENSE.electron.txt', 'LICENSES.chromium.html']) assert((await readFile(path.join(application.notices, notice))).length > 0, `Runtime notice missing or empty: ${notice}`);
if (application.mac) {
  const plist = await readFile(path.join(application.root, 'Contents', 'Info.plist'), 'utf8');
  const value = key => new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(plist)?.[1];
  assert.equal(value('CFBundleIdentifier'), expected.build.appId);
  assert.equal(value('CFBundleDisplayName'), expected.productName);
  assert.equal(value('CFBundleShortVersionString'), expected.version);
  assert.equal(value('LSMinimumSystemVersion'), '13.0');
  assert((await readFile(path.join(application.resources, value('CFBundleIconFile')))).length > 0);
  const binary = await readFile(application.executable);
  assert.equal(binary.readUInt32LE(0), 0xfeedfacf, 'Expected a native 64-bit Mach-O executable');
  const architecture = process.argv.find(arg => arg.startsWith('--arch='))?.slice(7) || process.arch;
  assert.equal(architecture, 'arm64', 'This release supports Apple Silicon Macs only');
  assert.equal(binary.readUInt32LE(4), 0x0100000c, 'Mac executable must be native Apple Silicon');
}
await mkdir(path.join(root, '.qa'), { recursive: true });
await writeFile(path.join(root, '.qa', 'package-verification.json'), JSON.stringify({ ok: true, archive, sourceFiles: checks, privateDataIncluded: false }, null, 2));
console.log(JSON.stringify({ ok: true, platform: application.mac ? 'darwin' : 'win32', version: expected.version, fileCount: checks.length, privateDataIncluded: false }));

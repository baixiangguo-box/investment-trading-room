import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const directory = path.resolve(process.argv[2] || path.join(root, 'release'));
const arch = process.argv.find(value => value.startsWith('--arch='))?.slice(7) || process.arch;
const platform = process.argv.includes('--all') ? 'all' : process.platform;
const tag = process.env.RELEASE_TAG;
if (tag && tag !== `v${metadata.version}`) throw new Error(`Tag ${tag} 与 package.json 版本不一致。`);
const names = (await readdir(directory)).filter(name => /^InvestmentTradingRoom-.*\.(?:exe|dmg|zip)$/.test(name)).sort();
const expected = platform === 'all' ? [
  `InvestmentTradingRoom-Setup-${metadata.version}-x64.exe`,
  ...['arm64', 'x64'].flatMap(cpu => ['dmg', 'zip'].map(extension => `InvestmentTradingRoom-Mac-${metadata.version}-${cpu}.${extension}`)),
] : platform === 'win32' ? [`InvestmentTradingRoom-Setup-${metadata.version}-x64.exe`]
  : ['dmg', 'zip'].map(extension => `InvestmentTradingRoom-Mac-${metadata.version}-${arch}.${extension}`);
if (expected.length !== names.length || expected.some(name => !names.includes(name))) throw new Error(`构建产物缺失或混入其他版本：${JSON.stringify({ expected, actual: names })}`);
const files = [];
for (const name of names) { const bytes = await readFile(path.join(directory, name)); files.push({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }); }
await writeFile(path.join(directory, 'SHA256SUMS.txt'), files.map(file => `${file.sha256}  ${file.name}`).join('\n') + '\n');
await writeFile(path.join(directory, 'build-metadata.json'), JSON.stringify({ version: metadata.version, platform, arch: platform === 'all' ? ['x64', 'arm64'] : arch,
  commit: process.env.GITHUB_SHA || null, signing: 'Windows unsigned; Mac ad-hoc only, no Developer ID or notarization', manualMacAcceptance: false, files }, null, 2));
await mkdir(path.join(root, '.qa'), { recursive: true });
console.log(JSON.stringify({ version: metadata.version, platform, arch, files }));

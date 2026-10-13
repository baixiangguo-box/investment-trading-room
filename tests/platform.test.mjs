import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dataDirectory, APP_ID, macMenuTemplate } from '../desktop/platform.mjs';
import { createAccountService } from '../core/account-service.mjs';
import { packagedPaths, defaultApplicationRoot } from '../scripts/package-paths.mjs';

test('Windows redirected Documents keeps the exact pre-1.3 ledger directory', () => {
  assert.equal(dataDirectory({ platform: 'win32', documents: 'D:\\用户文件\\文档', appData: 'C:\\Users\\test\\AppData\\Roaming' }), 'D:\\用户文件\\文档\\投资交易室数据');
  assert.equal(dataDirectory({ platform: 'win32', documents: '\\\\server\\users\\Documents' }), '\\\\server\\users\\Documents\\投资交易室数据');
});
test('Mac account lives in Application Support and never selects Documents', () => {
  assert.equal(dataDirectory({ platform: 'darwin', documents: '/Users/test/Documents', appData: '/Users/test/Library/Application Support' }), `/Users/test/Library/Application Support/${APP_ID}`);
  assert.throws(() => dataDirectory({ platform: 'darwin', appData: 'relative' }));
});
test('isolated profiles require native absolute paths; invalid overrides never fall back to real accounts', () => {
  for (const platform of ['win32', 'darwin']) for (const override of ['', '.', 'relative/profile', null]) assert.throws(() => dataDirectory({ platform, override }));
  assert.throws(() => dataDirectory({ platform: 'darwin', override: 'C:\\test' }));
  assert.equal(dataDirectory({ platform: 'darwin', override: '/tmp/测试 账户' }), '/tmp/测试 账户');
  assert.equal(dataDirectory({ platform: 'win32', override: 'D:\\测试 账户' }), 'D:\\测试 账户');
});
test('Mac close is distinct from quit; native editing and Dock reopening are available', () => {
  let opened = 0;
  const template = macMenuTemplate(() => opened++), items = template.flatMap(menu => menu.submenu);
  assert.equal(items.find(item => item.role === 'close').accelerator, 'Command+W');
  assert.equal(items.find(item => item.role === 'quit').accelerator, 'Command+Q');
  for (const role of ['copy', 'paste', 'cut', 'selectAll', 'undo', 'redo', 'hide', 'services', 'minimize', 'front']) assert(items.some(item => item.role === role));
  items.find(item => item.accelerator === 'Command+N').click(); assert.equal(opened, 1);
});
test('Windows and Apple Silicon bundles have separate resource/executable layouts', () => {
  const root = path.resolve('example');
  {
    const app = packagedPaths(defaultApplicationRoot(root, 'darwin', 'arm64'));
    assert(app.mac); assert.equal(app.archive, path.join(app.root, 'Contents', 'Resources', 'app.asar'));
    assert.equal(app.notices, path.join(app.root, 'Contents', 'Resources'));
    assert.equal(app.executable, path.join(app.root, 'Contents', 'MacOS', '投资交易室'));
  }
  assert.throws(() => defaultApplicationRoot(root, 'darwin', 'x64'));
  const win = packagedPaths(defaultApplicationRoot(root, 'win32', 'x64'));
  assert(!win.mac); assert.equal(win.archive, path.join(root, 'release', 'win-unpacked', 'resources', 'app.asar'));
});
test('JSON transfer and SQLite reopen preserve Chinese names, money, watchlists and reset backups across data layouts', async t => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'trading-platform-'));
  const sources = [];
  t.after(async () => { for (const service of sources) await service.close(); assert(path.resolve(temporary).startsWith(path.resolve(tmpdir()) + path.sep)); rmSync(temporary, { recursive: true, force: true }); });
  const location = layout => path.join(temporary, layout, '测试账户 空格', 'account.sqlite');
  const factory = layout => { const service = createAccountService({ dbPath: location(layout), quoteProvider: async () => { throw new Error('isolated offline'); }, now: () => new Date('2026-10-10T02:00:00Z') }); sources.push(service); return service; };
  const windows = factory('Documents');
  let account = windows.setup({ nickname: '跨平台账户', initial: 10000 });
  account = windows.watch({ symbol: 'sz000001', generation: account.generation });
  account = windows.adjustCapital({ amount: 0.01, expectedVersion: account.version, generation: account.generation });
  const snapshot = JSON.parse(JSON.stringify(windows.exportSnapshot()));
  const mac = factory('Library/Application Support'); let fresh = mac.getAccount();
  assert.equal(mac.inspectSnapshot(snapshot).ok, true);
  const restored = mac.restore(snapshot, { expectedVersion: fresh.version, generation: fresh.generation, confirm: '恢复账户' });
  assert.equal(restored.totalCash, 10000.01); assert.equal(restored.nickname, '跨平台账户'); assert.deepEqual(restored.watchlist, ['sz000001']);
  const reset = mac.reset({ initial: 500, nickname: '重置测试', expectedVersion: restored.version, generation: restored.generation, confirm: '重置账户', clearWatchlist: true });
  const previous = mac.getBackup(mac.listBackups()[0].id);
  mac.restore(previous, { expectedVersion: reset.version, generation: reset.generation, confirm: '恢复账户' });
  const before = mac.exportSnapshot(); await mac.close();
  const reopened = factory('Library/Application Support');
  assert.deepEqual(reopened.exportSnapshot(), before); assert(reopened.diagnostics().ok);
  assert.equal(windows.getAccount().totalCash, 10000.01);
});
test('packaging keeps the Windows NSIS identity and Mac hardened runtime without upgrading dependencies', () => {
  const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(metadata.build.appId, APP_ID); assert.equal(metadata.build.win.target[0].target, 'nsis');
  assert.equal(metadata.build.nsis.deleteAppDataOnUninstall, false);
  assert.equal(metadata.build.mac.hardenedRuntime, true);
  for (const target of metadata.build.mac.target) assert.deepEqual(target.arch, ['arm64']);
  assert.equal(metadata.scripts['package:mac:x64'], undefined);
  assert.equal(metadata.devDependencies.electron, '44.7.0'); assert.equal(metadata.devDependencies['electron-builder'], '26.15.3');
  assert(metadata.build.win.artifactName !== metadata.build.mac.artifactName);
});

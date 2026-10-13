// Real main/preload/renderer and disposable SQLite; network is intentionally
// offline and native file picker choices are controlled, not manual acceptance.
import { app, BrowserWindow, Menu, dialog } from 'electron';
import { mkdir, readFile } from 'node:fs/promises';
import { writeFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { packagedPaths } from './package-paths.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, '.qa', `platform-${Date.now()}-${randomUUID()}`);
await mkdir(directory, { recursive: true });
process.argv.push(`--data-dir=${directory}`);
globalThis.fetch = async () => { throw new Error('platform QA intentional offline'); };
const backup = path.join(directory, '账户备份.json');
const quittingBackup = path.join(directory, '退出备份.json');
let quittingExport = false, dialogOpened = false;
dialog.showErrorBox = (title, detail) => console.error(title, detail);
dialog.showSaveDialog = async () => {
  dialogOpened = true;
  if (quittingExport) await new Promise(resolve => setTimeout(resolve, 300));
  return { canceled: false, filePath: quittingExport ? quittingBackup : backup };
};
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [backup] });
const installed = process.argv.find(arg => arg.startsWith('--installed-root='))?.slice(17);
await import(installed ? pathToFileURL(path.join(packagedPaths(installed).archive, 'desktop', 'main.mjs')).href : '../desktop/main.mjs');
const checks = [];
let window, lastAccount;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(predicate) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) { const result = await predicate(); if (result) return result; await pause(80); }
  throw new Error('Platform QA condition timed out');
}
const evaluate = source => window.webContents.executeJavaScript(source, true);
const call = (name, payload) => evaluate(`(async()=>{const {createDesktopApi}=await import('trading://app/helpers.js');return createDesktopApi(window.trading)[${JSON.stringify(name)}](${JSON.stringify(payload ?? null)})})()`);
async function check(name, work) { await work(); checks.push({ name, ok: true }); console.log('PASS ' + name); }
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
function report(ok, error) {
  writeFileSync(path.join(root, '.qa', 'ci-platform.json'), JSON.stringify({ ok, version, platform: process.platform, arch: process.arch, packaged: !!installed, checks, error,
    scope: { isolatedAccount: true, network: 'controlled offline; not live provider acceptance', fileDialogs: 'controlled returned paths', inputMethod: 'Chromium CDP; not physical OS IME acceptance', nativeMacManualAcceptance: false } }, null, 2));
}
const timeout = setTimeout(() => { report(false, 'Platform QA deadline'); app.exit(1); }, 120000);
async function run() { try {
  await app.whenReady();
  window = await wait(() => BrowserWindow.getAllWindows()[0]);
  await wait(() => !window.webContents.isLoadingMainFrame());
  await check('原生运行时、隔离路径、沙箱和主框架 IPC', async () => {
    assert.equal(await evaluate('typeof window.require'), 'undefined');
    const settings = window.webContents.getLastWebPreferences();
    assert.equal(settings.nodeIntegration, false); assert(settings.contextIsolation); assert(settings.sandbox); assert(settings.webSecurity);
    assert.equal(app.getPath('userData'), directory); assert.equal((await call('account')).initialized, false);
  });
  await check('首次建户、充值和自选经实际 renderer/IPC 保存', async () => {
    await wait(() => evaluate(`!!document.querySelector('[data-form="setup"]')`));
    await evaluate(`(()=>{const form=document.querySelector('[data-form="setup"]');form.querySelector('[name="nickname"]').value='跨平台验收';form.querySelector('[name="initial"]').value='10000';form.requestSubmit()})()`);
    await wait(async () => (await call('account')).initialized && !await evaluate(`document.querySelector('#app-dialog').open`));
    let account = await call('account');
    account = await call('watch', { symbol: 'sz000001', generation: account.generation });
    lastAccount = await call('adjustCapital', { amount: 100, expectedVersion: account.version, generation: account.generation });
    assert.equal(lastAccount.totalCash, 10100); assert.deepEqual(lastAccount.watchlist, ['sz000001']);
  });
  await check('中文文件名原子备份、重置和跨平台 JSON 恢复', async () => {
    assert((await call('backup')).ok);
    const snapshot = JSON.parse(await readFile(backup, 'utf8')); assert.equal(snapshot.account.cashCents, 1010000);
    await call('reset', { initial: 500, nickname: '重置', expectedVersion: lastAccount.version, generation: lastAccount.generation, confirm: '重置账户', clearWatchlist: true });
    const preview = await call('previewRestore'); assert(preview.ok);
    lastAccount = await call('restore', { token: preview.token, expectedVersion: preview.expectedVersion, generation: preview.generation, confirm: '恢复账户' });
    assert.equal(lastAccount.totalCash, 10100); assert.deepEqual(lastAccount.watchlist, ['sz000001']); assert((await call('diagnostics')).ok);
  });
  await check('中文组合输入和 Ctrl/Command 全选保持同一编辑节点', async () => {
    await evaluate(`document.querySelector('.main-nav [data-page="watch"]').click()`);
    await wait(() => evaluate(`!!document.querySelector('#watch-search')`));
    await evaluate(`window.__platformInput=document.querySelector('#watch-search');window.__platformInput.focus()`);
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Input.insertText', { text: 'old query' });
    const modifiers = process.platform === 'darwin' ? ['meta'] : ['control'];
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers });
    await pause(100);
    assert.deepEqual(await evaluate(`[window.__platformInput.selectionStart,window.__platformInput.selectionEnd]`), [0, 9]);
    await window.webContents.debugger.sendCommand('Input.imeSetComposition', { text: 'pingan', selectionStart: 6, selectionEnd: 6 });
    await pause(500);
    assert(await evaluate(`document.querySelector('#watch-search')===window.__platformInput && document.activeElement===window.__platformInput`));
    await window.webContents.debugger.sendCommand('Input.insertText', { text: '平安银行' });
    await pause(500);
    assert.equal(await evaluate(`window.__platformInput.value`), '平安银行');
    window.webContents.debugger.detach();
  });
  await check('最小化和第二实例事件恢复窗口', async () => {
    window.minimize(); await pause(150); app.emit('second-instance');
    await wait(() => !window.isMinimized()); assert.equal(BrowserWindow.getAllWindows().length, 1);
  });
  if (process.platform === 'darwin') await check('Mac 菜单、关闭后 Dock activate 重建窗口并保留账户', async () => {
    const menu = Menu.getApplicationMenu(), entries = menu.items.flatMap(item => item.submenu?.items || []);
    assert(entries.some(item => item.role === 'quit' && item.accelerator === 'Command+Q'));
    assert(entries.some(item => item.role === 'close' && item.accelerator === 'Command+W'));
    const old = window; old.close(); await wait(() => old.isDestroyed());
    assert.equal(BrowserWindow.getAllWindows().length, 0);
    app.emit('activate'); window = await wait(() => BrowserWindow.getAllWindows()[0]);
    await wait(() => !window.webContents.isLoadingMainFrame());
    assert.notEqual(window, old); assert.equal((await call('account')).generation, lastAccount.generation);
    assert.equal((await call('account')).totalCash, 10100);
  });
  await check('另一个 renderer 无法取得账户 IPC', async () => {
    const intruder = new BrowserWindow({ show: false, webPreferences: { preload: path.join(root, 'desktop', 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
    try { await intruder.loadURL('trading://app/index.html'); const result = await intruder.webContents.executeJavaScript('window.trading.account()'); assert.equal(result.ok, false); assert.equal(result.error.code, 'ACCESS_DENIED'); }
    finally { intruder.destroy(); }
  });
  // Quit while a native-dialog operation has already been authorized. The real
  // export must finish before will-quit/SQLite shutdown, even without a window.
  quittingExport = true; dialogOpened = false;
  void call('backup').catch(() => {});
  await wait(() => dialogOpened);
  app.once('will-quit', () => {
    try { assert.equal(JSON.parse(readFileSync(quittingBackup, 'utf8')).account.cashCents, 1010000); checks.push({ name: '退出等待在途备份并完成原子写入', ok: true }); report(true); console.log(JSON.stringify({ ok: true, passed: checks.length, platform: process.platform, arch: process.arch, version })); clearTimeout(timeout); }
    catch (error) { report(false, error.stack); app.exit(1); }
  });
  app.quit();
  setTimeout(() => app.quit(), 30); // Repeated quit cannot interrupt the drain.
} catch (error) { console.error(error); report(false, error.stack); clearTimeout(timeout); app.exit(1); } }
void run();

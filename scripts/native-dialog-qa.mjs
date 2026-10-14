// Real Windows file dialogs driven manually or by desktop automation, in a disposable Electron
// profile. Unlike desktop-qa, this script does not replace Electron.dialog.
import { app, BrowserWindow } from 'electron';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { packagedPaths } from './package-paths.mjs';

const root = path.resolve(import.meta.dirname, '..');
const directory = path.join(root, '.qa', `native-dialog-${Date.now()}`);
const installedRoot = process.argv.find(arg => arg.startsWith('--installed-root='))?.slice(17);
await mkdir(directory, { recursive: true });
process.argv.push(`--data-dir=${directory}`);
const checks = [], deadline = setTimeout(() => { console.error('NATIVE_DIALOG_TIMEOUT'); app.exit(1); }, 600000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let window;
async function waitFor(fn) {
  for (let attempt = 0; attempt < 450; attempt++) { const result = await fn(); if (result) return result; await pause(100); }
  throw new Error('Native dialog setup timed out');
}
const evaluate = source => window.webContents.executeJavaScript(source, true);
async function call(method, payload) {
  return evaluate(`(async()=>{const {createDesktopApi}=await import('trading://app/helpers.js');return createDesktopApi(window.trading)[${JSON.stringify(method)}](${JSON.stringify(payload ?? null)})})()`);
}
async function shot(name) { await writeFile(path.join(directory, name), (await window.webContents.capturePage()).toPNG()); }
async function check(label, fn) { await fn(); checks.push({ label, ok: true }); console.log('PASS ' + label); }
await import(installedRoot ? pathToFileURL(path.join(packagedPaths(installedRoot).archive, 'desktop', 'main.mjs')).href : '../desktop/main.mjs');
async function run() { try {
  await app.whenReady();
  window = await waitFor(() => BrowserWindow.getAllWindows()[0]);
  await waitFor(() => evaluate(`!!window.trading && document.querySelector('#content h1')?.textContent==='市场行情'`).catch(() => false));
  await call('setup', { nickname: 'Windows原生文件对话框隔离账户', initial: 10000 });
  await evaluate(`document.querySelector('#app-dialog').dataset.mandatory='false';document.querySelector('#app-dialog').close();document.querySelector('[data-page="account"]').click()`);
  await waitFor(() => evaluate(`document.querySelector('#content h1')?.textContent==='个人账户' && !!document.querySelector('[data-action="deposit"]:not(:disabled)')`));
  await evaluate(`document.querySelector('#app-dialog').dataset.mandatory='false';document.querySelector('#app-dialog').close()`);
  window.show(); window.focus();
  const initial = await call('account');
  const file = path.join(directory, 'native-export.json'), corrupt = path.join(directory, 'native-corrupt.json');
  await writeFile(corrupt, '{invalid-json');
  console.log(JSON.stringify({ directory, file, corrupt, version: JSON.parse(await readFile(installedRoot ? path.join(packagedPaths(installedRoot).archive, 'package.json') : path.join(root, 'package.json'), 'utf8')).version }));
  await check('Windows原生保存弹窗取消：无账户变化', async () => {
    console.log('ACTION SAVE_CANCEL');
    assert.equal((await call('backup')).cancelled, true);
    assert.equal((await call('account')).version, initial.version);
  });
  await check('Windows原生保存弹窗：导出完整可校验文件', async () => {
    console.log('ACTION SAVE_VALID ' + file);
    const saved = await call('backup');
    assert.equal(saved.ok, true); assert.equal(path.resolve(saved.path), file);
    const snapshot = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(snapshot.account.nickname, initial.nickname); assert.equal(snapshot.account.cashCents, 1000000);
    assert.equal(typeof snapshot.checksum, 'string');
  });
  await check('Windows原生打开弹窗取消：无账户变化', async () => {
    console.log('ACTION OPEN_CANCEL');
    assert.equal((await call('previewRestore')).cancelled, true);
    assert.equal((await call('account')).version, initial.version);
  });
  await check('Windows原生选择损坏文件：拒绝且账本不变', async () => {
    console.log('ACTION OPEN_CORRUPT ' + corrupt);
    // Error custom fields do not survive executeJavaScript's rejected Promise;
    // inspect the error inside the renderer where createDesktopApi constructs it.
    const failure = await evaluate(`(async()=>{const {createDesktopApi}=await import('trading://app/helpers.js');try{await createDesktopApi(window.trading).previewRestore();return null}catch(error){return {code:error.code,message:error.message}}})()`);
    assert.equal(failure?.code, 'SNAPSHOT_INVALID');
    assert.equal((await call('account')).version, initial.version);
  });
  await check('Windows原生选择有效文件：预览、确认与恢复', async () => {
    console.log('ACTION OPEN_VALID ' + file);
    const preview = await call('previewRestore');
    assert.equal(preview.ok, true); assert.equal(preview.summary.nickname, initial.nickname);
    assert.equal(preview.expectedVersion, initial.version); assert.equal(preview.generation, initial.generation);
    const restored = await call('restore', { token: preview.token, expectedVersion: preview.expectedVersion, generation: preview.generation, confirm: '恢复账户' });
    assert.notEqual(restored.generation, initial.generation); assert.equal(restored.cash, initial.cash);
    assert.equal((await call('diagnostics')).ok, true);
    await shot('native-restored-account.png');
  });
  const version = JSON.parse(await readFile(installedRoot ? path.join(packagedPaths(installedRoot).archive, 'package.json') : path.join(root, 'package.json'), 'utf8')).version;
  const result = { ok: true, version, directory, passed: checks.length, checks, method: 'Actual Electron/Windows save and open dialogs controlled through Windows MCP; no dialog mocks; independent account directory' };
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result)); clearTimeout(deadline); app.exit(0);
} catch (error) {
  await writeFile(path.join(directory, 'report.json'), JSON.stringify({ ok: false, directory, checks, error: error.stack }, null, 2));
  console.error(error); clearTimeout(deadline); app.exit(1);
} }
void run();

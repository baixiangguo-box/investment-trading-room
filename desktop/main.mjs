import { app, BrowserWindow, protocol, ipcMain, dialog, session, Menu } from 'electron';
import { readFile, writeFile, mkdir, rename, open, realpath } from 'node:fs/promises';
import { mkdirSync, realpathSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createAccountService } from '../core/account-service.mjs';
import { getMarketSession } from '../core/market-rules.mjs';
import { createMarketService } from '../services/market-service.mjs';
import { mergeQuote } from '../renderer/helpers.js';
import { APP_NAME, dataDirectory, macMenuTemplate } from './platform.mjs';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
app.setName(APP_NAME);
const suppliedData = process.argv.find(value => value.startsWith('--data-dir='))?.slice(11);
let dataDir = dataDirectory({ documents: app.getPath('documents'), appData: app.getPath('appData'), override: suppliedData });
try {
  // Chromium needs an existing userData folder before Electron becomes ready.
  mkdirSync(dataDir, { recursive: true });
  dataDir = realpathSync(dataDir);
  app.setPath('userData', dataDir);
} catch {
  dialog.showErrorBox('投资交易室无法启动', '无法创建本地数据目录，请检查本机数据文件夹的写入权限。');
  app.exit(1);
}
protocol.registerSchemesAsPrivileged([{ scheme: 'trading', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

let window, market, accountService, matchingTimer, runningMatch = null, shuttingDown = false, updateTimer;
let shutdownComplete = false;
const seenQuotes = new Map();
const restoreTokens = new Map();
const pendingOperations = new Set();
const releaseVersion = JSON.parse(readFileSync(path.join(sourceRoot, 'package.json'), 'utf8')).version;
const appInfo = { name: '投资交易室', version: releaseVersion };
const trustedFiles = new Set(['index.html', 'app.js', 'helpers.js', 'polling.js', 'rendering.js', 'styles.css']);

async function writeLog(kind, detail) {
  try {
    await mkdir(path.join(dataDir, 'logs'), { recursive: true });
    const entry = JSON.stringify({ time: new Date().toISOString(), kind, detail });
    await writeFile(path.join(dataDir, 'logs', 'latest-event.json'), entry, 'utf8');
  } catch { /* Diagnostic output does not affect a committed transaction. */ }
}

function changed() {
  if (shuttingDown || updateTimer) return;
  updateTimer = setTimeout(() => {
    updateTimer = null;
    if (window && !window.isDestroyed()) window.webContents.send('trading:updated');
  }, 800);
}

function remember(items) {
  for (const item of items || []) if (item && typeof item.symbol === 'string') seenQuotes.set(item.symbol, mergeQuote(seenQuotes.get(item.symbol), item));
  return items;
}

// Account watchlists allow 500 stocks; upstream queries accept at most 300.
async function quoteResponse(payload) {
  const symbols = payload?.symbols;
  if (!Array.isArray(symbols) || symbols.length > 6000) throw Object.assign(new Error('报价请求需为证券列表，最多6000项。'), { code: 'INVALID_SYMBOL' });
  if (symbols.length <= 300) {
    const result = await market.quotes({ symbols, refresh: payload.refresh === true });
    remember(result.items);
    return result;
  }
  const results = [];
  for (let offset = 0; offset < symbols.length; offset += 300) results.push(await market.quotes({ symbols: symbols.slice(offset, offset + 300), refresh: payload.refresh === true }));
  const items = remember(results.flatMap(result => result.items));
  const times = results.map(result => result.asOf).filter(Boolean).sort();
  const warnings = [...new Set(results.map(result => result.warning).filter(Boolean))];
  return { items, asOf: times[0] || null, source: [...new Set(results.map(result => result.source))].join(' / '), cached: results.some(result => result.cached), ...(warnings.length ? { warning: warnings.join(' ') } : {}) };
}

async function accountQuotes(symbols) { return (await quoteResponse({ symbols })).items; }

async function getAccountView() {
  const first = await accountService.getAccount([...seenQuotes.values()]);
  const missing = [...new Set([...(first.holdings || []).map(item => item.symbol), ...(first.missingQuotes || []), ...(first.todayMissingQuotes || [])])];
  if (missing.length) {
    try { await accountQuotes(missing); } catch { /* The view explicitly reports incomplete valuation. */ }
    return accountService.getAccount([...seenQuotes.values()]);
  }
  return first;
}

// A committed local operation must not wait for a quote provider. The returned
// ledger remains authoritative; missing prices are explicitly marked, and the
// regular account/quote refresh fills the valuation separately.
function localAccountView() { return accountService.getAccount([...seenQuotes.values()]); }

async function getStatus() {
  const provider = await market.status();
  return { ...provider, session: getMarketSession(new Date()) };
}

async function processMatching() {
  if (shuttingDown || runningMatch) return;
  runningMatch = (async () => {
    try { await accountService.processPending(); } catch (error) { await writeLog('matching-error', String(error?.message || error)); }
  })();
  try { await runningMatch; } finally { runningMatch = null; }
}

function authorized(event) {
  return window && !window.isDestroyed() && event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame && event.senderFrame.url.startsWith('trading://app/');
}

function handle(name, callback) {
  ipcMain.handle('trading:' + name, async (event, payload) => {
    if (!authorized(event) || shuttingDown) return { ok: false, error: { code: 'ACCESS_DENIED', message: '桌面会话已结束，请重新打开软件。' } };
    const operation = Promise.resolve().then(() => callback(payload));
    pendingOperations.add(operation);
    try { return { ok: true, value: await operation }; }
    catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'UNKNOWN_RESULT';
      await writeLog('operation-error', { operation: name, code, message: String(error?.message || error) });
      return { ok: false, error: { code, message: error?.message || '操作结果尚未确认，请查询原委托或核对账户。' } };
    }
    finally { pendingOperations.delete(operation); }
  });
}

async function exportBackup() {
  const snapshot = await accountService.exportSnapshot();
  const result = await dialog.showSaveDialog(window, {
    title: '导出模拟账户备份',
    defaultPath: path.join(app.getPath('documents'), `投资交易室-账户备份-${new Date().toISOString().slice(0, 10)}.json`),
    filters: [{ name: '账户备份', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return { cancelled: true };
  const temporary = result.filePath + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(snapshot), { encoding: 'utf8', flag: 'wx' });
  await rename(temporary, result.filePath);
  return { ok: true, path: result.filePath };
}

function stageRestore(snapshot) {
  const inspected = accountService.inspectSnapshot(snapshot);
  if (!inspected.ok) return { ok: false, problems: inspected.problems || ['备份校验没有通过。'], summary: inspected.summary };
  const baseline = localAccountView();
  const token = randomUUID();
  restoreTokens.clear();
  restoreTokens.set(token, { snapshot, expires: Date.now() + 10 * 60 * 1000, expectedVersion: baseline.version, generation: baseline.generation });
  return { ...inspected, token, expectedVersion: baseline.version, generation: baseline.generation };
}

async function previewBackup(payload) {
  restoreTokens.clear();
  if (typeof payload?.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.id)) {
    throw Object.assign(new Error('自动备份编号无效，请重新选择。'), { code: 'BACKUP_NOT_FOUND' });
  }
  let snapshot;
  try { snapshot = accountService.getBackup(payload.id); }
  catch { throw Object.assign(new Error('这份自动备份内容损坏，账户尚未修改；可以选择其他备份。'), { code: 'SNAPSHOT_INVALID' }); }
  if (!snapshot) throw Object.assign(new Error('找不到这份自动备份，请刷新备份列表。'), { code: 'BACKUP_NOT_FOUND' });
  return stageRestore(snapshot);
}

async function previewRestore() {
  restoreTokens.clear();
  const result = await dialog.showOpenDialog(window, { title: '选择模拟账户备份', properties: ['openFile'], filters: [{ name: '账户备份', extensions: ['json'] }] });
  if (result.canceled || !result.filePaths[0]) return { cancelled: true };
  const maximum = 20 * 1024 * 1024, chunks = [];
  const tooLarge = () => Object.assign(new Error('备份文件超过20MiB，无法载入。'), { code: 'SNAPSHOT_TOO_LARGE' });
  const file = await open(result.filePaths[0], 'r');
  let length = 0;
  try {
    if ((await file.stat()).size > maximum) throw tooLarge();
    while (length <= maximum) {
      const buffer = Buffer.alloc(Math.min(65536, maximum + 1 - length));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      length += bytesRead;
      if (length > maximum) throw tooLarge();
      chunks.push(buffer.subarray(0, bytesRead));
    }
  } finally { await file.close(); }
  const bytes = Buffer.concat(chunks, length);
  let snapshot;
  try { snapshot = JSON.parse(bytes.toString('utf8')); } catch { throw Object.assign(new Error('备份文件不是有效JSON，请选择本软件导出的文件。'), { code: 'SNAPSHOT_INVALID' }); }
  return stageRestore(snapshot);
}

function registerHandlers() {
  handle('bootstrap', async () => {
    const [account, overview, status] = await Promise.all([getAccountView(), market.overview().catch(error => ({ indices: [], sectors: [], hot: [], breadth: { up: 0, down: 0, flat: 0, total: 0, amount: null }, source: '', asOf: null, cached: true, warning: error.message })), getStatus()]);
    return { app: appInfo, account, market: overview, status };
  });
  handle('marketOverview', payload => market.overview(payload || {}));
  handle('marketList', payload => market.list(payload || {}));
  handle('quotes', quoteResponse);
  handle('history', payload => market.history(payload));
  handle('account', getAccountView);
  handle('status', getStatus);
  handle('setup', async payload => { await accountService.setup(payload); changed(); return localAccountView(); });
  handle('watch', async payload => { await accountService.watch(payload); changed(); return localAccountView(); });
  handle('adjustCapital', async payload => {
    // Populate current quote valuation before a target-assets adjustment.
    if (payload?.targetAssets !== undefined) await getAccountView();
    await accountService.adjustCapital(payload);
    changed();
    return localAccountView();
  });
  handle('submit', async payload => { const result = await accountService.submit(payload); changed(); return { ...result, account: await getAccountView() }; });
  handle('cancel', async payload => { const result = await accountService.cancel(payload); changed(); return { ...result, account: await getAccountView() }; });
  handle('order', async payload => { const result = await accountService.getOrder(payload); return { ...result, account: await getAccountView() }; });
  handle('diagnostics', () => accountService.diagnostics());
  handle('backup', exportBackup);
  handle('listBackups', () => accountService.listBackups());
  handle('previewBackup', previewBackup);
  handle('previewRestore', previewRestore);
  handle('restore', async payload => {
    const token = restoreTokens.get(payload?.token);
    if (!token || token.expires <= Date.now()) throw Object.assign(new Error('恢复预览已过期，请重新选择备份。'), { code: 'PREVIEW_EXPIRED' });
    if (payload.generation !== token.generation) throw Object.assign(new Error('账户已发生变化，请重新预览备份。'), { code: 'GENERATION_CHANGED' });
    if (payload.expectedVersion !== token.expectedVersion) throw Object.assign(new Error('账户已发生变化，请重新预览备份。'), { code: 'VERSION_CONFLICT' });
    // Use the version captured by the main process, never a newer renderer value.
    await accountService.restore(token.snapshot, { ...payload, expectedVersion: token.expectedVersion, generation: token.generation });
    restoreTokens.delete(payload.token);
    seenQuotes.clear();
    changed();
    return localAccountView();
  });
  handle('reset', async payload => { await accountService.reset(payload); restoreTokens.clear(); seenQuotes.clear(); changed(); return localAccountView(); });
}

function createWindow() {
  window = new BrowserWindow({
    title: '投资交易室', width: 1460, height: 980, minWidth: 1030, minHeight: 700,
    backgroundColor: '#f3f5f0', icon: path.join(sourceRoot, 'assets', process.platform === 'win32' ? 'app.ico' : 'app.png'), show: false,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(sourceRoot, 'desktop', 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  });
  if (process.platform !== 'darwin') window.setMenu(null);
  const createdWindow = window;
  window.on('closed', () => { if (window === createdWindow) window = null; restoreTokens.clear(); });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('render-process-gone', (_event, detail) => writeLog('renderer-exit', detail.reason));
  window.webContents.on('did-fail-load', (_event, code, message) => writeLog('load-failed', { code, message }));
  window.webContents.on('console-message', (...args) => {
    const detail = typeof args[1] === 'object' ? args[1] : { level: args[1], message: args[2] };
    if (detail.level === 'error' || detail.level === 3) writeLog('renderer-error', detail.message);
  });
  window.once('ready-to-show', () => { if (!createdWindow.isDestroyed()) createdWindow.show(); });
  window.webContents.once('did-finish-load', () => writeLog('ready', { version: appInfo.version, renderer: 'loaded', dataDir, process: process.pid }));
  window.loadURL('trading://app/index.html');
}

function openWindow() {
  if (shuttingDown || !app.isReady() || !accountService) return;
  if (!window || window.isDestroyed()) createWindow();
  else { if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', openWindow);
  app.on('activate', openWindow);
  app.whenReady().then(async () => {
    await mkdir(dataDir, { recursive: true });
    // Resolve redirected folders/symlinks before SQLite and atomic cache writes.
    dataDir = await realpath(dataDir);
    protocol.handle('trading', async request => {
      const url = new URL(request.url);
      const name = decodeURIComponent(url.pathname).slice(1);
      if (url.hostname !== 'app' || !trustedFiles.has(name)) return new Response('Not found', { status: 404 });
      const contentType = name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8';
      return new Response(await readFile(path.join(sourceRoot, 'renderer', name)), { headers: { 'Content-Type': contentType } });
    });
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('trading://app/') && !details.url.startsWith('devtools://') }));
    market = createMarketService({ cacheDir: path.join(dataDir, 'market-cache'), onChange: changed });
    accountService = createAccountService({ dbPath: path.join(dataDir, 'account.sqlite'), quoteProvider: accountQuotes, onChange: changed });
    registerHandlers();
    if (process.platform === 'darwin') {
      Menu.setApplicationMenu(Menu.buildFromTemplate(macMenuTemplate(openWindow)));
      app.setAboutPanelOptions({ applicationName: APP_NAME, applicationVersion: releaseVersion });
      if (!app.isPackaged) app.dock?.setIcon(path.join(sourceRoot, 'assets', 'app.png'));
      app.dock?.setMenu(Menu.buildFromTemplate([{ label: '打开主窗口', click: openWindow }]));
    }
    createWindow();
    market.start().catch(error => writeLog('market-start', error.message));
    matchingTimer = setInterval(processMatching, 15000);
    processMatching();
  }).catch(async error => {
    await writeLog('startup-failed', String(error?.stack || error));
    dialog.showErrorBox('投资交易室无法启动', '请保留本地账户目录并重新安装软件。\n\n' + String(error?.message || error));
    app.exit(1);
  });
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin' && !shuttingDown) app.quit(); });
app.on('before-quit', event => {
  if (shuttingDown) { if (!shutdownComplete) event.preventDefault(); return; }
  event.preventDefault();
  shuttingDown = true;
  clearInterval(matchingTimer);
  clearTimeout(updateTimer);
  (async () => {
    // Destroy owned windows to cancel native modal dialogs. Stop network work,
    // then drain authorized operations before closing their SQLite connection.
    for (const owned of BrowserWindow.getAllWindows()) owned.destroy();
    await market?.close();
    if (runningMatch) await runningMatch;
    await Promise.allSettled([...pendingOperations]);
    await accountService?.close();
    shutdownComplete = true;
    app.quit();
  })().catch(async error => { await writeLog('shutdown-failed', String(error?.message || error)); app.exit(1); });
});

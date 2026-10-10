// Production Electron/main/preload/renderer regression checks in a fresh profile.
// Invoke with Electron; optional --installed-root=<installation directory>.
// Native file-picker return paths and selected renderer market replies are
// controlled here. File I/O, account operations and their authorization remain real.
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, '.qa', `feedback-integration-${Date.now()}-${randomUUID().slice(0, 8)}`);
const installedRoot = process.argv.find(value => value.startsWith('--installed-root='))?.slice(17);
await mkdir(path.dirname(directory), { recursive: true });
process.argv.push(`--data-dir=${directory}`);
const files = Object.fromEntries(['export', 'damaged', 'invalid', 'oversized'].map(name => [name, path.join(directory, `feedback-${name}.json`)]));
let saveChoice = { canceled: false, filePath: files.export };
let openChoice = { canceled: false, filePaths: [files.export] };
const dialogCalls = [];
dialog.showSaveDialog = async (_window, options) => {
  dialogCalls.push({ kind: 'save', title: options.title, cancelled: saveChoice.canceled });
  return structuredClone(saveChoice);
};
dialog.showOpenDialog = async (_window, options) => {
  dialogCalls.push({ kind: 'open', title: options.title, cancelled: openChoice.canceled, selected: openChoice.filePaths.map(file => path.basename(file)) });
  return structuredClone(openChoice);
};
dialog.showErrorBox = (title, message) => console.error(title, message);

const checks = [], requests = [], controls = [], screenshots = [], begun = Date.now();
let window, version, activeCheck, fixtureMode = false, missingVolume = false, accountGate = null, quoteGate = null, previewGate = null, replayAccount = null, replayRemaining = 0;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = code => window.webContents.executeJavaScript(code, true);
async function waitFor(predicate, timeout = 20000, label = 'application condition') {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const result = await predicate();
    if (result) return result;
    await pause(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
const call = (method, payload) => evaluate(`(async()=>{const {createDesktopApi}=await import('trading://app/helpers.js');return createDesktopApi(window.trading)[${JSON.stringify(method)}](${JSON.stringify(payload ?? null)})})()`);
const account = () => call('account', { feedbackTruthRead: true });
async function rejection(method, payload) {
  return evaluate(`(async()=>{const {createDesktopApi}=await import('trading://app/helpers.js');try{await createDesktopApi(window.trading)[${JSON.stringify(method)}](${JSON.stringify(payload ?? null)});return null}catch(error){return{code:error.code,message:error.message}}})()`);
}
async function click(selector) {
  await evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node||node.disabled)throw Error('Unavailable click target: '+${JSON.stringify(selector)});node.click()})()`);
}
const text = () => evaluate(`document.querySelector('#content').innerText`);
const economic = value => Object.fromEntries(['initialized', 'nickname', 'initial', 'cash', 'totalCash', 'netDeposits', 'netCapital', 'capitalFlows', 'watchlist', 'orders', 'trades', 'holdings', 'fees', 'realized', 'version', 'generation'].map(key => [key, value[key]]));
async function check(label, run) {
  activeCheck = label;
  await run(); checks.push({ label, ok: true }); console.log(`PASS ${label}`);
}
async function screenshot(name) {
  await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  await writeFile(path.join(directory, name), (await window.webContents.capturePage()).toPNG());
  screenshots.push(name);
}
function gate(kind, symbol = null) {
  let release;
  return { kind, symbol, captured: null, released: false, promise: new Promise(resolve => { release = resolve; }), release() { this.released = true; release(); } };
}

function displayQuote(symbol) {
  const identities = {
    sz000001: ['平安银行', 'stock', 'main', 10],
    sh600519: ['贵州茅台', 'stock', 'main', 100],
    sh689009: ['九号公司-WD', 'stock', 'star', 52],
    sh000001: ['上证指数', 'index', null, 4000],
    'sector:BK0428': ['隔离显示银行板块', 'sector', null, 1500],
  };
  const [name, type, board, price] = identities[symbol], stamp = new Date().toISOString();
  const book = Array.from({ length: 5 }, (_, index) => ({ level: index + 1, price, size: 1000 + index }));
  return { symbol, name, type, ...(board ? { board } : {}), market: 'sh', code: symbol.replace(/^(?:sh|sz|bj|sector:)/, ''), price, previous: price, open: price, high: price, low: price, percent: 0, change: 0, volume: 10000, amount: price * 10000, turnover: 9.99, upper: price * 1.2, lower: price * 0.8, bid: price, ask: price, bidSize: 1000, askSize: 1000, orderBook: { bids: book, asks: book }, time: stamp, fetchedAt: stamp, source: 'isolated-feedback-display-fixture · 隔离显示夹具', warning: '隔离显示夹具，不作为真实行情或成交证据。', cached: false, stale: false, tradeable: false };
}
function fixtureReply(channel, payload, value) {
  if (channel === 'trading:quotes' && payload?.symbols?.every(symbol => ['sz000001', 'sh600519', 'sh689009', 'sh000001', 'sector:BK0428'].includes(symbol))) {
    const items = payload.symbols.map(displayQuote);
    return { items, source: items[0]?.source || 'isolated-feedback-display-fixture', asOf: items[0]?.time || null, fetchedAt: items[0]?.fetchedAt || null, cached: false, warning: items[0]?.warning || '' };
  }
  if (channel === 'trading:history' && ['sz000001', 'sh689009', 'sh000001', 'sector:BK0428'].includes(payload?.symbol)) {
    const quote = displayQuote(payload.symbol), date = new Date().toISOString().slice(0, 10);
    const items = [0, 1, 2].map(index => ({ time: `${date}T09:${30 + index}:00+08:00`, price: quote.price, open: quote.price, high: quote.price, low: quote.price, volume: missingVolume ? null : 100 + index, average: null }));
    return { items, source: quote.source, asOf: quote.time, fetchedAt: quote.fetchedAt, previous: quote.previous, cached: false, warning: quote.warning };
  }
  if (channel === 'trading:marketList') {
    const symbols = payload?.kind === 'indices' ? ['sh000001'] : payload?.kind === 'sectors' ? ['sector:BK0428'] : ['sz000001', 'sh600519', 'sh689009'];
    const query = String(payload?.query || '').trim(), items = symbols.map(displayQuote).filter(item => !query || item.name.includes(query) || item.code.includes(query));
    return { ...(value || {}), items, total: items.length, page: 1, pageSize: payload?.pageSize || 20, pages: 1, loading: false, source: 'isolated-feedback-display-fixture', cached: false, warning: '隔离显示夹具；本检查不验证目录覆盖或实时行情。' };
  }
  return value;
}
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => originalHandle(channel, async (event, payload) => {
  const record = { channel, check: activeCheck, at: Date.now(), symbols: payload?.symbols, query: payload?.query };
  requests.push(record);
  let result = await handler(event, payload);
  if (fixtureMode && ['trading:quotes', 'trading:history', 'trading:marketList'].includes(channel) && result?.error?.code !== 'ACCESS_DENIED') {
    const fixture = fixtureReply(channel, payload, result?.value);
    if (fixture !== result?.value) { result = { ok: true, value: fixture }; record.control = 'renderer-display-fixture-after-real-handler'; }
  }
  if (channel === 'trading:account' && !payload?.feedbackTruthRead && result?.ok) {
    if (accountGate && !accountGate.captured) {
      const pending = accountGate; pending.captured = structuredClone(result);
      record.control = 'delayed-real-account-reply';
      controls.push({ kind: record.control, version: result.value.version, generation: result.value.generation });
      await pending.promise;
    } else if (replayAccount && replayRemaining > 0) {
      result = structuredClone(replayAccount); replayRemaining--;
      record.control = 'duplicate-old-real-account-reply';
      controls.push({ kind: record.control, version: result.value.version, generation: result.value.generation });
    }
  }
  if (channel === 'trading:quotes' && quoteGate && !quoteGate.captured && payload?.symbols?.includes(quoteGate.symbol)) {
    const pending = quoteGate; pending.captured = true;
    record.control = 'delayed-watch-quote-ipc-reply-after-real-handler';
    controls.push({ kind: record.control, symbol: pending.symbol });
    await pending.promise;
  }
  record.deliveredAt = Date.now();
  if (channel === 'trading:previewBackup' && previewGate && !previewGate.captured) {
    const pending = previewGate; pending.captured = true;
    record.control = 'delayed-real-backup-preview-response'; await pending.promise;
  }
  return result;
});
await import(installedRoot ? pathToFileURL(path.join(installedRoot, 'resources', 'app.asar', 'desktop', 'main.mjs')).href : '../desktop/main.mjs');

async function accountPage() {
  await click('.main-nav [data-page="account"]');
  await waitFor(() => evaluate(`document.querySelector('#content h1')?.textContent==='个人账户' && !!document.querySelector('[data-action="deposit"]:not(:disabled)')`));
}
async function closeDialog() {
  await waitFor(() => evaluate(`!!document.querySelector('[data-action="deposit"]:not(:disabled)')`));
  await click('#app-dialog [data-action="close-dialog"]');
  await waitFor(() => evaluate(`!document.querySelector('#app-dialog').open`));
}
async function localPreview(id) {
  await accountPage(); await click('[data-action="list-backups"]');
  await waitFor(() => evaluate(`!!document.querySelector('[data-action="preview-backup"][data-id="${id}"]')`));
  await click(`[data-action="preview-backup"][data-id="${id}"]`);
  await waitFor(() => evaluate(`document.querySelector('#app-dialog').open && !!document.querySelector('[data-form="restore"]')`));
}
async function confirmRestore() {
  await waitFor(() => evaluate(`!!document.querySelector('[data-action="deposit"]:not(:disabled)')`));
  await evaluate(`document.querySelector('#restore-confirm').value='恢复账户';document.querySelector('[data-form="restore"]').requestSubmit()`);
  await waitFor(() => evaluate(`!document.querySelector('#app-dialog').open`));
  await waitFor(() => evaluate(`!!document.querySelector('[data-action="deposit"]:not(:disabled)')`));
}
async function deposit(amount) {
  await click('[data-action="deposit"]');
  await waitFor(() => evaluate(`!!document.querySelector('[data-form="capital"] #capital-value')`));
  await evaluate(`document.querySelector('#capital-value').value=${JSON.stringify(String(amount))};document.querySelector('[data-form="capital"]').requestSubmit()`);
  await waitFor(() => evaluate(`!document.querySelector('#app-dialog').open && !!document.querySelector('[data-action="deposit"]:not(:disabled)')`));
}
async function showDetail(kind, symbol) {
  await click('.main-nav [data-page="market"]');
  await waitFor(() => evaluate(`!!document.querySelector('[data-action="list-kind"][data-kind="${kind}"]:not(:disabled)')`));
  await click(`[data-action="list-kind"][data-kind="${kind}"]`);
  await waitFor(() => evaluate(`!!document.querySelector('[data-action="detail"][data-symbol="${symbol}"]')`));
  await click(`button[data-action="detail"][data-symbol="${symbol}"]`);
  await waitFor(() => evaluate(`!!document.querySelector('[data-interactive-chart]') && document.querySelector('#content h1')?.textContent.includes(${JSON.stringify(displayQuote(symbol).name)})`));
}

async function run() {
  try {
    await app.whenReady();
    window = await waitFor(() => BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed()), 30000);
    await waitFor(() => evaluate(`!!window.trading && !!document.querySelector('#content h1')`).catch(() => false), 60000);
    version = (await call('bootstrap')).app.version;
    const expectedVersion = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
    assert.equal(version, expectedVersion, 'Feedback QA must run sources or an installed package matching package.json.');
    await check('真实main、受限preload、renderer与全新隔离数据目录', async () => {
      assert.equal(window.webContents.getURL(), 'trading://app/index.html');
      assert.equal(await evaluate('typeof require'), 'undefined');
      assert.equal(await evaluate('typeof process'), 'undefined');
      assert.equal(window.webContents.getLastWebPreferences().contextIsolation, true);
      assert.equal(window.webContents.getLastWebPreferences().sandbox, true);
      assert.equal(path.resolve(app.getPath('userData')).toLowerCase(), path.resolve(directory).toLowerCase());
      assert.equal((await account()).initialized, false);
      assert.equal(await evaluate(`typeof window.trading.listBackups`), 'function');
      assert.equal(await evaluate(`typeof window.trading.previewBackup`), 'function');
    });
    let original, reset, restored, oldBackup;
    await check('真实setup、自选与现金调整生成可恢复原账户', async () => {
      await call('setup', { nickname: '隔离反馈原账户', initial: 10000 });
      let current = await account();
      await call('watch', { symbol: 'sz000001', generation: current.generation, expectedVersion: current.version });
      current = await account();
      await call('adjustCapital', { amount: 500.25, generation: current.generation, expectedVersion: current.version });
      original = await account();
      assert.equal(original.cash, 10500.25); assert.equal(original.capitalFlows.length, 1); assert.deepEqual(original.watchlist, ['sz000001']);
      await evaluate(`const dialog=document.querySelector('#app-dialog');dialog.dataset.mandatory='false';dialog.close()`);
      await accountPage();
    });
    await check('真实重置UI默认保留自选并保存原现金与流水自动备份', async () => {
      await click('[data-action="reset"]');
      await waitFor(() => evaluate(`!!document.querySelector('[data-form="reset"] #reset-clear-watchlist')`));
      assert.equal(await evaluate(`document.querySelector('#reset-clear-watchlist').checked`), false);
      await evaluate(`document.querySelector('#reset-name').value='隔离反馈重置账户';document.querySelector('#reset-initial').value='20000';document.querySelector('#reset-confirm').value='重置账户';document.querySelector('[data-form="reset"]').requestSubmit()`);
      await waitFor(() => evaluate(`!document.querySelector('#app-dialog').open`));
      reset = await account(); assert.equal(reset.cash, 20000); assert.equal(reset.capitalFlows.length, 0);
      assert.deepEqual(reset.watchlist, original.watchlist); assert.notEqual(reset.generation, original.generation); assert(reset.version > original.version);
      const backups = await call('listBackups'); assert(Array.isArray(backups));
      oldBackup = backups.find(item => item.version === original.version && item.generation === original.generation);
      assert(oldBackup?.id, 'Reset did not make the original account selectable.');
    });
    await check('自动备份列表、真实UI预览与取消保持当前账户不变', async () => {
      await accountPage(); await click('[data-action="list-backups"]');
      await waitFor(() => evaluate(`!!document.querySelector('[data-action="preview-backup"][data-id="${oldBackup.id}"]')`));
      await screenshot('automatic-backup-list.png');
      await click(`[data-action="preview-backup"][data-id="${oldBackup.id}"]`);
      await waitFor(() => evaluate(`!!document.querySelector('[data-form="restore"]')`));
      assert((await evaluate(`document.querySelector('#app-dialog').innerText`)).includes('10,500.25'));
      await screenshot('automatic-backup-preview.png');
      await closeDialog(); assert.deepEqual(economic(await account()), economic(reset));
    });
    await check('原生Esc关闭自动备份列表后迟到的预览不会重新打开弹窗', async () => {
      const before = await account(); await accountPage(); await click('[data-action="list-backups"]');
      await waitFor(() => evaluate(`!!document.querySelector('[data-action="preview-backup"][data-id="${oldBackup.id}"]')`));
      previewGate = gate('preview'); await click(`[data-action="preview-backup"][data-id="${oldBackup.id}"]`);
      await waitFor(() => previewGate.captured); window.focus();
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      await waitFor(() => evaluate(`!document.querySelector('#app-dialog').open`)); previewGate.release(); previewGate = null;
      await waitFor(() => evaluate(`!!document.querySelector('[data-action="deposit"]:not(:disabled)')`)); await pause(200);
      assert.equal(await evaluate(`document.querySelector('#app-dialog').open`), false);
      assert.deepEqual(economic(await account()), economic(before));
    });
    await check('自动备份UI确认找回原现金流水自选并建立新世代和恢复前备份', async () => {
      const before = await account(), backupCount = (await call('listBackups')).length;
      await localPreview(oldBackup.id); await confirmRestore(); restored = await account();
      assert.equal(restored.cash, original.cash); assert.deepEqual(restored.capitalFlows, original.capitalFlows); assert.deepEqual(restored.watchlist, original.watchlist);
      assert.equal(restored.nickname, original.nickname); assert.notEqual(restored.generation, before.generation); assert(restored.version > before.version);
      assert((await call('listBackups')).length > backupCount); assert.equal((await call('diagnostics')).ok, true);
      await screenshot('automatic-backup-restored.png');
    });
    await check('恢复令牌绑定预览版本，篡改为新版payload仍拒绝覆盖', async () => {
      const before = await account(), preview = await call('previewBackup', { id: oldBackup.id });
      assert.equal(preview.ok, true); assert(preview.token); assert.equal(preview.expectedVersion, before.version); assert.equal(preview.generation, before.generation);
      await call('adjustCapital', { amount: 1, generation: before.generation, expectedVersion: before.version });
      const changed = await account();
      const error = await rejection('restore', { token: preview.token, expectedVersion: changed.version, generation: changed.generation, confirm: '恢复账户' });
      assert.equal(error?.code, 'VERSION_CONFLICT'); assert.deepEqual(economic(await account()), economic(changed));
    });
    await check('损坏隔离SQLite备份不影响列表或其他合法预览', async () => {
      const before = await account(), broken = randomUUID();
      assert(directory.startsWith(path.join(root, '.qa') + path.sep));
      const database = new DatabaseSync(path.join(directory, 'account.sqlite'));
      try {
        database.exec('PRAGMA busy_timeout=5000');
        database.prepare('INSERT INTO account_backups(id,created_at,version,generation,snapshot) VALUES(?,?,?,?,?)').run(broken, new Date().toISOString(), before.version, before.generation, '{broken JSON');
      } finally { database.close(); }
      const backups = await call('listBackups'); assert(backups.some(item => item.id === oldBackup.id));
      assert.equal((await rejection('previewBackup', { id: broken }))?.code, 'SNAPSHOT_INVALID');
      assert.equal((await rejection('previewBackup', { id: randomUUID() }))?.code, 'BACKUP_NOT_FOUND');
      assert.equal((await call('previewBackup', { id: oldBackup.id })).ok, true);
      assert.deepEqual(economic(await account()), economic(before));
    });
    let exported;
    await check('固定Save路径驱动真实导出与原子写入，取消导出不修改账户', async () => {
      const before = await account();
      saveChoice = { canceled: true }; assert.equal((await call('backup')).cancelled, true);
      saveChoice = { canceled: false, filePath: files.export }; assert.equal((await call('backup')).ok, true);
      exported = JSON.parse(await readFile(files.export, 'utf8'));
      assert.equal(exported.kind, 'investment-trading-room'); assert.equal(exported.accountVersion, before.version); assert.equal(exported.account.cashCents, Math.round(before.totalCash * 100));
      assert(!(await readdir(directory)).some(file => file.startsWith('feedback-export.json.') && file.endsWith('.tmp')));
      assert.deepEqual(economic(await account()), economic(before));
    });
    await check('固定Open路径取消、损坏JSON与校验和、超20MiB文件均不能修改账户', async () => {
      const before = await account();
      openChoice = { canceled: true, filePaths: [] }; assert.equal((await call('previewRestore')).cancelled, true);
      await writeFile(files.damaged, '{broken JSON'); openChoice = { canceled: false, filePaths: [files.damaged] };
      assert.equal((await rejection('previewRestore'))?.code, 'SNAPSHOT_INVALID');
      const invalid = structuredClone(exported); invalid.account.cashCents++;
      await writeFile(files.invalid, JSON.stringify(invalid)); openChoice = { canceled: false, filePaths: [files.invalid] };
      const invalidPreview = await call('previewRestore'); assert.equal(invalidPreview.ok, false); assert(invalidPreview.problems.length > 0); assert.equal(invalidPreview.token, undefined);
      await writeFile(files.oversized, Buffer.alloc(20 * 1024 * 1024 + 1)); openChoice = { canceled: false, filePaths: [files.oversized] };
      assert.equal((await rejection('previewRestore'))?.code, 'SNAPSHOT_TOO_LARGE');
      assert.deepEqual(economic(await account()), economic(before));
    });
    await check('有效文件真实预览UI取消后确认恢复，保留导出内容与恢复前备份', async () => {
      let before = await account(); await call('adjustCapital', { amount: 25, generation: before.generation, expectedVersion: before.version });
      before = await account(); openChoice = { canceled: false, filePaths: [files.export] };
      await accountPage(); await click('[data-action="preview-restore"]');
      await waitFor(() => evaluate(`!!document.querySelector('[data-form="restore"]')`)); await closeDialog();
      assert.deepEqual(economic(await account()), economic(before));
      await click('[data-action="preview-restore"]'); await waitFor(() => evaluate(`!!document.querySelector('[data-form="restore"]')`));
      await screenshot('file-backup-preview.png'); await confirmRestore();
      const after = await account(); assert.equal(after.totalCash, exported.account.cashCents / 100); assert.equal(after.nickname, exported.account.nickname);
      assert.deepEqual(after.watchlist, exported.account.watchlist); assert.equal(after.capitalFlows.length, exported.account.capitalFlows.length);
      assert.notEqual(after.generation, before.generation); assert(after.version > before.version); assert.equal((await call('diagnostics')).ok, true);
    });
    await check('延迟及重复旧真实account回包不覆盖已充值的新资产', async () => {
      await accountPage();
      await waitFor(() => evaluate(`document.querySelector('#connection-status').dataset.refreshRunning!=='true'`));
      const before = await account(); accountGate = gate('account');
      window.webContents.send('trading:updated'); await waitFor(() => accountGate.captured, 20000, 'old real account reply capture');
      await deposit(3); const newer = await account(); assert.equal(newer.cash, Math.round((before.cash + 3) * 100) / 100);
      const newText = newer.totalAssets.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const oldText = before.totalAssets.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      assert.equal(await evaluate(`document.querySelector('.account-summary .total .big-value').textContent`), newText);
      await evaluate(`window.__feedbackAssetValues=[];window.__feedbackAssetObserver=new MutationObserver(()=>{const value=document.querySelector('.account-summary .total .big-value')?.textContent;if(value)window.__feedbackAssetValues.push(value)});window.__feedbackAssetObserver.observe(document.querySelector('#content'),{childList:true,subtree:true,characterData:true})`);
      replayAccount = accountGate.captured; replayRemaining = 1; accountGate.release();
      await waitFor(() => evaluate(`document.querySelector('#connection-status').dataset.refreshRunning==='false'`), 20000, 'delayed account refresh completion');
      await pause(300); accountGate = null; replayAccount = null; replayRemaining = 0;
      const values = await evaluate(`window.__feedbackAssetObserver.disconnect();window.__feedbackAssetValues`);
      assert(!values.includes(oldText), 'A stale response temporarily rendered the previous asset amount.');
      assert.equal(await evaluate(`document.querySelector('.account-summary .total .big-value').textContent`), newText);
      assert.deepEqual(economic(await account()), economic(newer));
    });
    fixtureMode = true;
    await check('长期自选行情IPC待返回期间UI充值及本地拒单仍可完成', async () => {
      await click('.main-nav [data-page="watch"]'); await waitFor(() => evaluate(`!!document.querySelector('#watch-search')`));
      await evaluate(`const input=document.querySelector('#watch-search');input.value='贵州茅台';input.dispatchEvent(new Event('input',{bubbles:true}))`);
      await waitFor(() => evaluate(`!!document.querySelector('[data-action="watch-add"][data-symbol="sh600519"]:not(:disabled)')`));
      quoteGate = gate('quotes', 'sh600519'); await click('[data-action="watch-add"][data-symbol="sh600519"]');
      await waitFor(() => quoteGate.captured, 30000, 'watch quote reply capture');
      assert.equal(quoteGate.released, false);
      const started = Date.now(); await accountPage(); const before = await account(); await deposit(10); const after = await account();
      assert(Date.now() - started < 5000, 'Pending watch quotes blocked the local cash operation.');
      assert.equal(after.cash, Math.round((before.cash + 10) * 100) / 100); assert.equal(quoteGate.released, false);
      const status = await call('status'), closed = !status.session.open, rejectStart = Date.now();
      const error = await rejection('submit', { id: 'feedback-local-rejection', symbol: 'sz000001', side: 'buy', qty: closed ? 100 : 0, limit: 10, generation: after.generation });
      assert.equal(error?.code, closed ? 'MARKET_CLOSED' : 'INVALID_QUANTITY'); assert(Date.now() - rejectStart < 3000);
      assert.equal((await account()).orders.length, 0); quoteGate.release(); quoteGate = null;
    });
    for (const [kind, symbol, label, shot] of [['indices', 'sh000001', '指数', 'index-detail.png'], ['sectors', 'sector:BK0428', '板块', 'sector-detail.png']]) {
      await check(`${label}隔离显示夹具不渲染五档或股票专属指标`, async () => {
        await showDetail(kind, symbol); const body = await text();
        assert(!body.includes('五档盘口')); assert.equal(await evaluate(`document.querySelectorAll('#content [data-action="trade-stock"]').length`), 0);
        const metrics = await evaluate(`Array.from(document.querySelectorAll('.detail-overview .metric-label')).map(node=>node.textContent)`);
        assert(metrics.length > 0);
        assert(!metrics.some(label => /换手|涨停|跌停|市盈|市净|流通市值|总市值/.test(label)), 'Non-stock detail displayed a stock-specific metric.');
        assert(body.includes('隔离显示夹具')); await screenshot(shot);
      });
    }
    await check('股票隔离分时均价缺失明确提示，未生成替代均价曲线', async () => {
      await showDetail('stocks', 'sz000001'); const body = await text();
      assert(/均价[^\n]*(?:未提供|缺失|不可用|暂无)/.test(body), 'Missing average price was not explicitly explained.');
      assert.equal(await evaluate(`document.querySelectorAll('.chart-average').length`), 0);
      await screenshot('average-missing.png');
    });
    await check('隔离分时成交量缺失明确提示且不生成零量柱', async () => {
      missingVolume = true;
      await click('[data-action="refresh-detail"]');
      await waitFor(() => evaluate(`document.querySelector('.chart-toolbar').textContent.includes('成交量未提供') && !document.querySelector('[data-action="refresh-detail"]').disabled`));
      assert((await text()).includes('行情源未提供成交量'));
      assert.equal(await evaluate(`document.querySelectorAll('.chart-volume rect').length`), 0);
      await screenshot('volume-missing.png'); missingVolume = false;
    });
    await check('科创CDR可保存自选，详情量和盘口、交易数量按份显示', async () => {
      let current = await account();
      await call('watch', { symbol: 'sh689009', generation: current.generation, expectedVersion: current.version });
      assert((await account()).watchlist.includes('sh689009'));
      await showDetail('stocks', 'sh689009'); const body = await text();
      assert(body.includes('份')); assert(!/盘口[^\n]*股数/.test(body));
      await screenshot('cdr-detail.png');
      await click('[data-action="trade-stock"][data-side="buy"]');
      await waitFor(() => evaluate(`!!document.querySelector('#order-qty') && document.querySelector('#trade-search').value.includes('689009')`));
      assert.equal(await evaluate(`document.querySelector('label[for="order-qty"]').textContent`), '委托数量（份）');
      assert.equal(await evaluate(`document.querySelector('#order-qty').value`), '200');
      assert.equal(await evaluate(`document.querySelector('.quantity-presets button').textContent`), '200份');
      assert((await evaluate(`document.querySelector('.quantity-help').textContent`)).includes('200份'));
      await screenshot('cdr-trade.png');
    });
    await check('已选交易证券的原生Enter保留选择且无无效搜索或误下单', async () => {
      await waitFor(() => evaluate(`!!document.querySelector('#trade-search') && !document.querySelector('#order-form button[type="submit"]').disabled`));
      await evaluate(`document.querySelector('#trade-search').focus();window.__feedbackEnter=[];document.addEventListener('keydown',event=>{if(event.key==='Enter')window.__feedbackEnter.push({trusted:event.isTrusted})},{once:true});document.querySelector('#toast').className='toast';document.querySelector('#toast').textContent=''`);
      const beforeValue = await evaluate(`document.querySelector('#trade-search').value`), start = requests.length;
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' }); window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
      await pause(700);
      assert.equal(await evaluate(`document.querySelector('#trade-search').value`), beforeValue);
      assert.equal(await evaluate(`window.__feedbackEnter.some(event=>event.trusted)`), true);
      assert(!requests.slice(start).some(request => request.channel === 'trading:submit'));
      assert(!await evaluate(`document.querySelector('#toast').classList.contains('error')`));
      assert(!/(?:无效|太长|超出).*(?:搜索|查询)|(?:搜索|查询).*(?:无效|太长|超出)/.test(await text()));
      assert.equal((await account()).orders.length, 0); await screenshot('selected-trade-enter.png');
    });
    fixtureMode = false;
    await check('验收后真实隔离账本一致且无模拟订单或成交', async () => {
      const current = await account(); assert.equal(current.orders.length, 0); assert.equal(current.trades.length, 0);
      assert.equal((await call('diagnostics')).ok, true);
    });
    const result = { ok: true, version, passed: checks.length, checks, directory, durationMs: Date.now() - begun, screenshots,
      scope: { actual: ['production main/preload/renderer/protocol and authorized IPC', 'fresh isolated SQLite account setup/watch/capital/reset/restore and backups', 'actual export temporary-write/rename and bounded file-read/JSON/checksum validation', 'real native Chromium Enter'], controlled: ['Save/Open dialog returned fixed isolated paths/cancel results; no native OS picker mouse automation', 'renderer-only quote/history/list display fixtures, explicitly labelled; no provider/core trade quote override', 'delayed watch quote IPC response after actual handler', 'delayed and optionally duplicated old actual account IPC response', 'one deliberately corrupted isolated SQLite backup row'], excluded: ['existing user account', 'actual weekend fills', 'live market correctness or directory coverage in fixture checks'] }, controls, dialogCalls };
    await writeFile(path.join(directory, 'report.json'), JSON.stringify({ ...result, requests }, null, 2));
    console.log(JSON.stringify(result)); app.quit();
  } catch (error) {
    console.error(error.stack); accountGate?.release(); quoteGate?.release(); previewGate?.release();
    if (window && !window.isDestroyed()) await screenshot('failure.png').catch(() => {});
    await writeFile(path.join(directory, 'report.json'), JSON.stringify({ ok: false, version, checks, failedCheck: activeCheck, error: String(error.stack), directory, controls, dialogCalls, requests }, null, 2)).catch(() => {});
    app.exit(1);
  }
}
void run();

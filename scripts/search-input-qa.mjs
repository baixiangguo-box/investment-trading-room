// Native Chromium IME regression checks in the production Electron application.
// Run with Electron, optionally --installed-root=<installation directory>.
// --expect-regression accepts only the known 1.2.1 composition/DOM interruption.
// This script owns a fresh .qa profile and never attaches to an existing client.
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, '.qa', `search-input-${Date.now()}`);
const installedRoot = process.argv.find(value => value.startsWith('--installed-root='))?.slice(17);
const expectRegression = process.argv.includes('--expect-regression');
await mkdir(path.dirname(directory), { recursive: true });
process.argv.push(`--data-dir=${directory}`);
dialog.showErrorBox = (title, message) => console.error(title, message);

const requests = [], checks = [], commitObservations = [], started = Date.now();
let window, version, activeCheck, delayedReply, regressions = 0;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, timeout = 15000, label = 'application condition') {
  const begun = Date.now();
  while (Date.now() - begun < timeout) {
    const result = await predicate();
    if (result) return result;
    await pause(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
const evaluate = code => window.webContents.executeJavaScript(code, true);
const cdp = (method, parameters) => window.webContents.debugger.sendCommand(method, parameters);
const call = (method, payload) => evaluate(`(async()=>{const {createDesktopApi}=await import('trading://app/helpers.js');return createDesktopApi(window.trading)[${JSON.stringify(method)}](${JSON.stringify(payload ?? null)})})()`);
async function click(selector) {
  await evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node||node.disabled)throw Error('Unavailable target: '+${JSON.stringify(selector)});node.click()})()`);
}
async function snapshot() {
  return evaluate(`(()=>{const p=window.__searchInputProbe,n=p?.input;return{connected:!!n?.isConnected,same:!!n&&document.getElementById(n.id)===n,ancestors:p?.ancestors.every(a=>a.isConnected&&a.contains(n)),detached:p?.detached||0,focused:document.activeElement===n,value:n?.value,start:n?.selectionStart,end:n?.selectionEnd,direction:n?.selectionDirection,events:p?.events||[]}})()`);
}
async function screenshot(name) {
  await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  await writeFile(path.join(directory, name), (await window.webContents.capturePage()).toPNG());
}
async function check(label, run, { regression = false } = {}) {
  activeCheck = label;
  try {
    await run();
    checks.push({ label, ok: true });
    console.log(`PASS ${label}`);
  } catch (error) {
    const probe = await snapshot().catch(() => null);
    const nativeComposition = probe?.events.some(event => event.type === 'compositionstart' && event.trusted);
    const interruptedEditor = probe && (!probe.same || !probe.connected || !probe.ancestors || !probe.focused || probe.detached > 0);
    if (expectRegression && regression && error.code === 'ERR_ASSERTION' && nativeComposition && interruptedEditor) {
      regressions++;
      checks.push({ label, ok: false, expectedRegression: true, error: error.message, probe });
      await screenshot(`regression-${regressions}.png`);
      console.log(`CONFIRMED 1.2.1 REGRESSION ${label}: ${error.message}`);
    } else {
      checks.push({ label, ok: false, error: error.message, probe });
      throw error;
    }
  } finally {
    delayedReply?.release(); delayedReply = null;
  }
}

// Observe genuine production IPC and optionally hold one real reply to prove
// stale-response handling. No generated market data replaces provider results.
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => originalHandle(channel, async (event, payload) => {
  const record = { channel, payload, at: Date.now(), check: activeCheck };
  requests.push(record);
  const result = await handler(event, payload);
  const gateChannel = delayedReply?.channel || 'trading:marketList';
  const gateMatches = channel === gateChannel && (gateChannel === 'trading:quotes'
    ? payload?.symbols?.length === 1 && payload.symbols[0] === delayedReply?.symbol
    : payload?.query === delayedReply?.query);
  if (delayedReply && !delayedReply.captured && gateMatches) {
    const gate = delayedReply;
    gate.captured = record;
    await gate.promise;
    if (gate.error) {
      record.injectedError = gate.error;
      record.deliveredAt = Date.now();
      return { ok: false, error: { code: 'ISOLATED_QUOTES_FAILURE', message: gate.error } };
    }
  }
  record.deliveredAt = Date.now();
  return result;
});
await import(installedRoot ? pathToFileURL(path.join(installedRoot, 'resources', 'app.asar', 'desktop', 'main.mjs')).href : '../desktop/main.mjs');

const contexts = [
  { key: 'market', input: 'market-search', result: 'tbody .stock-link' },
  { key: 'watch', input: 'watch-search', result: '.search-results .name' },
  { key: 'trade', input: 'trade-search', result: '.search-results .name' },
];
async function openContext(context) {
  await cdp('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
  await click(`.main-nav [data-page="${context.key}"]`);
  if (context.key === 'market') {
    await waitFor(() => evaluate(`!!document.querySelector('[data-action="list-kind"][data-kind="stocks"]:not(:disabled)')`));
    await click('[data-action="list-kind"][data-kind="stocks"]');
  }
  if (context.key === 'trade') await click('[data-action="trade-tab"][data-tab="buy"]');
  await waitFor(() => evaluate(`!!document.getElementById(${JSON.stringify(context.input)})`));
  await pause(500);
  await evaluate(`(()=>{const input=document.getElementById(${JSON.stringify(context.input)});input.focus();input.select()})()`);
  await key('Backspace', 8);
  await pause(550);
  await evaluate(`(()=>{window.__searchInputProbe?.observer?.disconnect();const input=document.getElementById(${JSON.stringify(context.input)}),ancestors=[];for(let p=input.parentElement;p&&p.id!=='content';p=p.parentElement)ancestors.push(p);const probe={input,ancestors,events:[],detached:0};probe.observer=new MutationObserver(records=>{for(const record of records)for(const removed of record.removedNodes)if(removed===input||removed.contains?.(input))probe.detached++});probe.observer.observe(document.querySelector('#content'),{subtree:true,childList:true});window.__searchInputProbe=probe;for(const type of ['compositionstart','compositionupdate','compositionend','beforeinput','input','keydown','keyup'])input.addEventListener(type,event=>{const entry={type: event.type,trusted:event.isTrusted,composing:event.isComposing,data:event.data,key:event.key,keyCode:event.keyCode,value:input.value,at:Date.now()};probe.events.push(entry);queueMicrotask(()=>{entry.prevented=event.defaultPrevented})});input.focus()})()`);
}
async function key(keyName, virtualKey = 13) {
  const payload = { key: keyName, code: keyName, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey };
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...payload });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...payload });
}
async function insert(text, { replace = false } = {}) {
  if (replace) await evaluate(`window.__searchInputProbe.input.select()`);
  await cdp('Input.insertText', { text });
}
async function resultsContain(context, name) {
  return evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(context.result)})).some(node=>node.textContent.includes(${JSON.stringify(name)}))`);
}
function assertStable(probe, value, selection) {
  assert.equal(probe.same, true, 'Search input was replaced during editing.');
  assert.equal(probe.connected, true, 'Search input was detached during editing.');
  assert.equal(probe.ancestors, true, 'An editing ancestor was detached or replaced.');
  assert.equal(probe.detached, 0, 'Search input was temporarily detached during editing.');
  assert.equal(probe.focused, true, 'Search input lost focus during editing.');
  if (value !== undefined) assert.equal(probe.value, value);
  if (selection) {
    assert.equal(probe.start, selection.start); assert.equal(probe.end, selection.end);
    assert.equal(probe.direction, selection.direction);
  }
}
async function candidateCheck(context) {
  await openContext(context);
  const requestStart = requests.length;
  await cdp('Input.imeSetComposition', { text: 'p', selectionStart: 1, selectionEnd: 1 });
  await pause(650);
  assertStable(await snapshot(), 'p');
  await cdp('Input.imeSetComposition', { text: 'ping', selectionStart: 4, selectionEnd: 4 });
  await pause(650);
  let probe = await snapshot(); assertStable(probe, 'ping');
  assert(probe.events.some(event => event.type === 'compositionstart' && event.trusted), 'Native compositionstart is required.');
  assert(probe.events.some(event => event.type === 'input' && event.composing && event.trusted), 'Native composing input is required.');
  assert(!probe.events.some(event => event.type === 'compositionend'), 'Candidate composition ended before confirmation.');
  assert(!requests.slice(requestStart).some(request => request.channel === 'trading:marketList' && ['p', 'ping'].includes(request.payload?.query)), 'Uncommitted candidate started a stock search.');
  const enterStart = requests.length;
  // Chromium processes a genuine Enter while its editor has active composition.
  await key('Enter');
  await pause(250);
  probe = await snapshot(); assertStable(probe);
  const enter = probe.events.findLast(event => event.type === 'keydown' && event.key === 'Enter');
  assert(enter?.trusted, 'Enter must be delivered by Chromium.');
  assert.equal(enter.prevented, false, 'The application intercepted IME candidate Enter.');
  assert(!requests.slice(enterStart).some(request => request.channel === 'trading:submit'), 'Candidate Enter submitted a trade.');
  assert(!requests.slice(enterStart).some(request => request.channel === 'trading:marketList' && request.payload?.query === 'ping'), 'Candidate Enter started an unfinished search.');
  await cdp('Input.insertText', { text: '平安银行' });
  await waitFor(() => resultsContain(context, '平安银行'), 20000, `${context.key} committed Chinese result`);
  probe = await snapshot(); assertStable(probe, '平安银行');
  const end = probe.events.findLast(event => event.type === 'compositionend' && event.data === '平安银行');
  assert(end, 'The Chromium commit must finish composition with the submitted Chinese text.');
  assert.equal(typeof end.trusted, 'boolean');
  // Electron 44's CDP ImeCommitText queues a compositionend whose isTrusted can
  // be false. Preserve that observed flag; earlier native composition/input
  // events remain required to be trusted. No synthetic DOM event is dispatched.
  commitObservations.push({ context: context.key, compositionEndTrusted: end.trusted, committedText: probe.value, events: probe.events });
  const committedRequests = requests.slice(requestStart).filter(request => request.channel === 'trading:marketList' && request.payload?.query === '平安银行');
  assert.equal(committedRequests.length, 1, 'Committed Chinese text should enqueue one debounced search.');
  await screenshot(`search-ime-${context.key}.png`);
}
async function slowInputCheck(context) {
  await openContext(context);
  let text = '';
  for (const character of 'pa') {
    await insert(character); text += character; await pause(550);
    assertStable(await snapshot(), text);
  }
  await insert('', { replace: true }); await key('Backspace', 8); await pause(500);
  text = '';
  for (const character of '000001') {
    await insert(character); text += character; await pause(550);
    const probe = await snapshot(); assertStable(probe, text);
    assert.equal(probe.start, text.length); assert.equal(probe.end, text.length);
  }
  await waitFor(() => resultsContain(context, '平安银行'), 20000, `${context.key} stock code result`);
  assertStable(await snapshot(), '000001');
}
async function delayedAndRefreshCheck(context) {
  await openContext(context);
  let release;
  delayedReply = { query: '000001', captured: null, promise: new Promise(resolve => { release = resolve; }), release: () => release() };
  await insert('000001');
  await waitFor(() => delayedReply?.captured, 20000, 'old real search reply');
  await insert('贵州茅台', { replace: true });
  await evaluate(`window.__searchInputProbe.input.setSelectionRange(1,3,'backward')`);
  const selection = { start: 1, end: 3, direction: 'backward' };
  await waitFor(() => resultsContain(context, '贵州茅台'), 20000, 'new result before old reply');
  assertStable(await snapshot(), '贵州茅台', selection);
  delayedReply.release(); delayedReply = null;
  await pause(500);
  assertStable(await snapshot(), '贵州茅台', selection);
  assert.equal(await resultsContain(context, '平安银行'), false, 'Stale search reply replaced the current result.');
  await pause(1700);
  const refreshStart = requests.length;
  window.webContents.send('trading:updated');
  await waitFor(() => requests.slice(refreshStart).some(request => request.channel === 'trading:status'), 15000, 'shared background refresh');
  await waitFor(() => evaluate(`document.querySelector('#connection-status').dataset.refreshRunning==='false'`), 20000, 'background refresh completion');
  assertStable(await snapshot(), '贵州茅台', selection);
  assert.equal(await resultsContain(context, '贵州茅台'), true);
}
async function blurAndNavigationCheck(context) {
  await openContext(context);
  await cdp('Input.imeSetComposition', { text: 'ping', selectionStart: 4, selectionEnd: 4 });
  await evaluate(`window.__searchInputProbe.input.blur()`);
  await cdp('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
  await click('.main-nav [data-page="account"]');
  await waitFor(() => evaluate(`document.querySelector('#content h1')?.textContent==='个人账户'`));
  await openContext(context); await insert('平安银行');
  await waitFor(() => resultsContain(context, '平安银行'), 20000, 'search after composition blur and navigation');
  assertStable(await snapshot(), '平安银行');
}
async function selectedTradeEditingCheck() {
  const context = contexts[2];
  await openContext(context); await insert('平安银行');
  await waitFor(() => evaluate(`!!document.querySelector('.search-results [data-action="select-trade"][data-symbol="sz000001"]:not(:disabled)')`), 20000, 'selectable known stock');
  await click('.search-results [data-action="select-trade"][data-symbol="sz000001"]');
  await waitFor(() => evaluate(`document.querySelector('.trade-quote h2')?.textContent.includes('平安银行') && Number(document.querySelector('#order-limit').value)>0 && !document.querySelector('#order-form button[type="submit"]').disabled`), 20000, 'valid selected stock before editing');
  await evaluate(`window.__searchInputProbe.input.focus();window.__searchInputProbe.input.select()`);
  const requestStart = requests.length;
  await cdp('Input.imeSetComposition', { text: 'mao', selectionStart: 3, selectionEnd: 3 });
  await pause(500); assertStable(await snapshot(), 'mao');
  assert.equal(await evaluate(`document.querySelector('#order-limit').value`), '', 'Editing a selected stock must invalidate the old price.');
  assert.equal(await evaluate(`document.querySelector('#order-form button[type="submit"]').disabled`), true, 'Editing must disable the previous stock order.');
  await key('Enter'); await pause(200);
  assert(!requests.slice(requestStart).some(request => request.channel === 'trading:submit'), 'IME Enter submitted the previously selected stock.');
  await cdp('Input.insertText', { text: '贵州茅台' });
  await waitFor(() => resultsContain(context, '贵州茅台'), 20000, 'new stock result after invalidating selection');
  assertStable(await snapshot(), '贵州茅台');
  assert.equal(await evaluate(`document.querySelector('.trade-quote h2')?.textContent.trim()`), '选择要交易的股票');
  assert.equal(await evaluate(`document.querySelector('#order-form button[type="submit"]').disabled`), true);
  assert(!requests.slice(requestStart).some(request => request.channel === 'trading:submit'));
}
async function staleQuoteFailureCheck() {
  const context = contexts[0], message = '隔离验收旧查询报价失败';
  await openContext(context);
  let release;
  delayedReply = { channel: 'trading:quotes', symbol: 'sz000001', captured: null, error: message, promise: new Promise(resolve => { release = resolve; }), release: () => release() };
  await insert('000001');
  await waitFor(() => delayedReply?.captured, 20000, 'old real quote response');
  await insert('贵州茅台', { replace: true });
  await waitFor(() => resultsContain(context, '贵州茅台'), 20000, 'new market query before quote failure');
  delayedReply.release(); delayedReply = null; await pause(600);
  assertStable(await snapshot(), '贵州茅台');
  assert.equal(await resultsContain(context, '平安银行'), false);
  assert.equal(await evaluate(`document.querySelector('#content').innerText.includes(${JSON.stringify(message)})`), false, 'An old quote failure leaked into the current list.');
}

async function run() {
  try {
    await app.whenReady();
    window = await waitFor(() => BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed()), 30000);
    await waitFor(() => evaluate(`!!window.trading&&!!document.querySelector('#content h1')`).catch(() => false), 60000);
    window.show(); window.focus(); await pause(350);
    window.webContents.debugger.attach('1.3');
    version = (await call('bootstrap')).app.version;
    if (expectRegression) assert.equal(version, '1.2.1', '--expect-regression is only for the original 1.2.1 client.');
    await check('真实Electron原生输入通道与全新隔离账户', async () => {
      assert.equal(window.webContents.getURL(), 'trading://app/index.html');
      assert.equal(await evaluate('typeof require'), 'undefined');
      assert.equal((await call('account')).initialized, false);
      await call('setup', { nickname: '隔离中文输入验收账户', initial: 10000 });
      await evaluate(`const dialog=document.querySelector('#app-dialog');dialog.dataset.mandatory='false';dialog.close()`);
      await waitFor(async () => (await call('marketList', { kind: 'stocks', query: '平安银行', pageSize: 10 })).items.some(item => item.symbol === 'sz000001'), 90000, 'public stock directory');
    });
    for (const context of contexts) {
      await check(`IME ${context.key} 候选停顿、原节点与祖先、Enter选词及汉字提交`, () => candidateCheck(context), { regression: true });
      if (expectRegression) continue;
      await check(`${context.key} 慢速英文字母和六位代码保持节点、焦点与光标`, () => slowInputCheck(context));
      await check(`${context.key} 旧真实请求返回及自动刷新保持新搜索与选区`, () => delayedAndRefreshCheck(context));
      await check(`${context.key} 中文组合输入失焦和切页后恢复正常搜索`, () => blurAndNavigationCheck(context));
    }
    if (expectRegression) assert.equal(regressions, contexts.length, 'Expected the native composition regression in all three original search inputs.');
    else {
      await check('已有选股后中文IME编辑立即清旧价格、禁止旧股票下单', selectedTradeEditingCheck);
      await check('市场旧查询报价延迟失败不残留到新的股票查询', staleQuoteFailureCheck);
      await check('交易搜索普通Enter只搜索、不触发下单且账户无委托', async () => {
      await openContext(contexts[2]); await insert('平安银行');
      const start = requests.length;
      await key('Enter'); await pause(600);
      await waitFor(() => resultsContain(contexts[2], '平安银行'), 20000);
      assert(!requests.slice(start).some(request => request.channel === 'trading:submit'));
      const account = await call('account'); assert.equal(account.orders.length, 0); assert.equal(account.trades.length, 0); assert.equal(account.cash, 10000);
      });
    }
    const result = { ok: true, version, mode: expectRegression ? 'expected-original-regression' : 'fixed-input-validation', regressionConfirmed: expectRegression && regressions === contexts.length, checks, directory, durationMs: Date.now() - started, inputMethod: 'Chromium native CDP Input.imeSetComposition/Input.insertText: start and composing input must be trusted; commit compositionend is required but its original isTrusted flag is recorded (Electron 44 CDP commit may produce false). No DOM events are synthesized.', compositionCommits: commitObservations, isolation: 'Fresh local .qa profile; real public directory; one real IPC reply deliberately delayed and one old quote response deliberately failed for stale-result checks; no user account or market fixtures.' };
    await writeFile(path.join(directory, 'report.json'), JSON.stringify({ ...result, requests }, null, 2));
    console.log(JSON.stringify({ ...result, passed: checks.filter(check => check.ok).length }));
    window.webContents.debugger.detach(); app.quit();
  } catch (error) {
    console.error(error.stack);
    delayedReply?.release();
    if (window && !window.isDestroyed()) await screenshot('failure.png').catch(() => {});
    await writeFile(path.join(directory, 'report.json'), JSON.stringify({ ok: false, version, checks, failedCheck: activeCheck, error: String(error.stack), probe: window ? await snapshot().catch(() => null) : null, requests, directory }, null, 2));
    app.exit(1);
  }
}
void run();

import { mkdir, readFile, writeFile, rename, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { getMarketSession } from '../core/market-rules.mjs';

const STOCK_SOURCE = '新浪财经 · 沪深京A股目录';
const QUOTE_SOURCE = '腾讯财经公开行情';
const SECTOR_SOURCE = '东方财富公开板块行情';
const SINA_SECTOR_SOURCE = '新浪财经公开行业概况';
const INDEX_SYMBOLS = ['sh000001', 'sz399001', 'sz399006', 'sh000300', 'sh000016', 'sz399005', 'bj899050'];
const TTL_DIRECTORY = 60_000;
const TTL_SECTORS = 30_000;
const TTL_QUOTES = 2_000;
const MAX_BODY = 5 * 1024 * 1024;
const CN_DATE = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });

const OWN_ERRORS = new WeakSet();
function failure(message, code = 'MARKET_UNAVAILABLE') { const e = new Error(message); e.code = code; OWN_ERRORS.add(e); return e; }
function friendlyError(error, area = '行情') {
  if (error && typeof error === 'object' && OWN_ERRORS.has(error)) return error;
  // Detailed OS paths and stacks belong to main-process diagnostics, not UI warnings.
  console.warn(`[market:${area}]`, error);
  if (area === '缓存') return failure('本地行情缓存暂不可用，请检查数据目录权限或磁盘剩余空间。', 'MARKET_CACHE_UNAVAILABLE');
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError' || error?.code === 'ETIMEDOUT') return failure('行情请求超时，请稍后刷新。');
  if (error instanceof SyntaxError) return failure('行情源返回内容格式异常，请稍后刷新。');
  return failure('行情源连接失败，请检查网络后重试。');
}
function number(value) { if (value === undefined || value === null || String(value).trim() === '' || value === '-') return null; const n = Number(value); return Number.isFinite(n) ? n : null; }
function positive(value) { const n = number(value); return n !== null && n > 0 ? n : null; }
function scaled(value, scale) { const n = number(value); return n === null || !Number.isFinite(n * scale) ? null : n * scale; }
function board(symbol) { return symbol.startsWith('bj') ? 'bse' : symbol.startsWith('sh688') || symbol.startsWith('sh689') ? 'star' : symbol.startsWith('sz300') || symbol.startsWith('sz301') ? 'chinext' : 'main'; }
function isStock(symbol) { return /^(?:sh(?:60|68)\d{4}|sz(?:00|30)\d{4}|bj(?:92|43|83|87|88)\d{4})$/.test(symbol); }
function symbolType(symbol) { return /^sector:(?:BK\d{4,8}|sina:new_[a-z0-9]{2,30})$/.test(symbol) ? 'sector' : isStock(symbol) ? 'stock' : INDEX_SYMBOLS.includes(symbol) || /^(?:sh000|sz399|bj899)\d{3}$/.test(symbol) ? 'index' : null; }
function validateSymbol(symbol) { if (typeof symbol !== 'string' || !symbolType(symbol)) throw failure('证券代码无效，请从行情列表选择。', 'INVALID_SYMBOL'); return symbol; }
function quoteTime(raw) {
  if (!/^\d{14}$/.test(raw ?? '')) return null;
  const result = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(8, 10)}:${raw.slice(10, 12)}:${raw.slice(12, 14)}+08:00`;
  const d = new Date(result);
  return Number.isFinite(d.getTime()) && CN_DATE.format(d) === result.slice(0, 10) ? result : null;
}
function rawJson(text) { const j = JSON.parse(text); if (!j || typeof j !== 'object') throw failure('行情源返回的内容无效。'); return j; }
function latestTime(items, fallback = null) { const times = items.map(x => x.time).filter(x => typeof x === 'string' && Number.isFinite(Date.parse(x))); return times.length ? times.sort((a, b) => Date.parse(b) - Date.parse(a))[0] : fallback; }

export function parseTencent(text, fetchedAt = new Date().toISOString()) {
  const result = [];
  for (const match of text.matchAll(/v_((?:sh|sz|bj)\d{6})="([^"]*)"/g)) {
    const symbol = match[1], f = match[2].split('~'), type = symbolType(symbol), time = quoteTime(f[30]);
    if (!type || f.length < 49 || f[2] !== symbol.slice(2) || !f[1]?.trim() || !time || !positive(f[3])) continue;
    const book = start => Array.from({ length: 5 }, (_, i) => ({ level: i + 1, price: positive(f[start + i * 2]), size: scaled(f[start + i * 2 + 1], 100) }));
    const bids = book(9), asks = book(19);
    const q = {
      symbol, name: f[1], code: f[2], market: symbol.slice(0, 2), type,
      ...(type === 'stock' ? { board: board(symbol) } : {}),
      price: positive(f[3]), previous: positive(f[4]), open: positive(f[5]), high: positive(f[33]), low: positive(f[34]),
      change: number(f[31]), percent: number(f[32]), volume: scaled(f[6], 100), amount: scaled(f[37], 10_000), turnover: number(f[38]),
      bid: bids[0].price, ask: asks[0].price, bidSize: bids[0].size, askSize: asks[0].size,
      upper: positive(f[47]), lower: positive(f[48]), time, fetchedAt, source: QUOTE_SOURCE,
      orderBook: { bids, asks }, tradeable: false,
    };
    const bidUsable = q.bid > 0 && Number.isSafeInteger(q.bidSize) && q.bidSize > 0;
    const askUsable = q.ask > 0 && Number.isSafeInteger(q.askSize) && q.askSize > 0;
    // This flag expresses only raw quote completeness; session and timestamp checks
    // are applied again for every returned quote and independently by the account core.
    const validPrice = price => price === null || price > 0 && Math.abs(price * 100 - Math.round(price * 100)) < 1e-7 && price >= q.lower - 1e-7 && price <= q.upper + 1e-7;
    q.tradeable = type === 'stock' && (bidUsable || askUsable) && q.volume > 0 && q.upper > 0 && q.lower > 0 && q.upper >= q.lower && [q.price, q.bid, q.ask].every(validPrice) && !(q.bid > 0 && q.ask > 0 && q.bid > q.ask);
    result.push(q);
  }
  return result;
}

export function parseSinaRows(rows) {
  if (!Array.isArray(rows)) throw failure('A股目录不是有效列表。');
  return rows.map(r => {
    if (!r || !isStock(r.symbol) || r.code !== r.symbol.slice(2) || typeof r.name !== 'string' || !r.name.trim()) throw failure('A股目录包含无效证券，未覆盖已有缓存。');
    return { symbol: r.symbol, code: r.code, name: r.name, market: r.symbol.slice(0, 2), type: 'stock', board: board(r.symbol), price: positive(r.trade), change: number(r.pricechange), percent: number(r.changepercent), volume: number(r.volume), amount: number(r.amount), turnover: number(r.turnoverratio), time: null, quoteClock: typeof r.ticktime === 'string' ? r.ticktime : null };
  });
}

export function parseSectorRows(rows) {
  if (!Array.isArray(rows)) throw failure('板块行情返回无效列表。');
  return rows.filter(r => /^BK\d{4,8}$/.test(r?.f12) && typeof r.f14 === 'string').map(r => ({ symbol: `sector:${r.f12}`, code: r.f12, name: r.f14, market: 'sh', type: 'sector', sector: '行业板块', price: positive(r.f2), percent: number(r.f3), change: number(r.f4), volume: scaled(r.f5, 100), amount: number(r.f6), turnover: number(r.f8), time: positive(r.f124) ? new Date(r.f124 * 1000).toISOString() : null }));
}

export function parseSinaSectors(text) {
  const match = /^\s*var\s+S_Finance_bankuai_sinaindustry\s*=\s*(\{[\s\S]*\})\s*;?\s*$/.exec(text);
  if (!match) throw failure('备用行业源返回内容无效。');
  const raw = rawJson(match[1]); if (Array.isArray(raw)) throw failure('备用行业源返回内容无效。');
  const items = Object.entries(raw).flatMap(([key, value]) => {
    if (!/^new_[a-z0-9]{2,30}$/.test(key) || typeof value !== 'string') return [];
    const f = value.split(','); if (f[0] !== key || !f[1]?.trim() || !positive(f[2])) return [];
    return [{ symbol: `sector:sina:${key}`, code: key, name: f[1], market: 'sh', type: 'sector', sector: '新浪行业分类', price: null, averagePrice: positive(f[3]), change: number(f[4]), percent: number(f[5]), volume: number(f[6]), amount: number(f[7]), turnover: null, time: null, members: number(f[2]), leader: isStock(f[8]) ? { symbol: f[8], name: f[12] || f[8], percent: number(f[9]) } : null }];
  });
  if (!items.length || items.length > 200 || new Set(items.map(q => q.symbol)).size !== items.length) throw failure('备用行业目录为空或异常。');
  return items;
}

export function parseCandleRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap(row => {
    if (!Array.isArray(row) || !/^\d{4}-\d{2}-\d{2}$/.test(row[0])) return [];
    const [time, o, c, h, l, v] = row, open = positive(o), price = positive(c), high = positive(h), low = positive(l);
    if (!open || !price || !high || !low || high < Math.max(open, price) || low > Math.min(open, price)) return [];
    return [{ time, open, price, high, low, volume: scaled(v, 100) }];
  });
}

export function parseMinuteRows(data) {
  if (!data || !/^\d{8}$/.test(data.date) || !Array.isArray(data.data)) return [];
  const date = data.date.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
  let previousVolume = null, previousMinute = null;
  return data.data.flatMap(row => {
    if (typeof row !== 'string') return [];
    const [t, p, v, a] = row.trim().split(/\s+/), price = positive(p), volumeTotal = scaled(v, 100), amount = number(a);
    if (!/^\d{4}$/.test(t) || !price || Number(t.slice(2)) > 59) return [];
    const minute = Number(t.slice(0, 2)) * 60 + Number(t.slice(2));
    if (minute < 570 || minute > 900 || (minute > 690 && minute < 780)) return [];
    const adjacent = previousMinute !== null && (minute - previousMinute === 1 || previousMinute === 690 && minute === 780);
    const volume = previousMinute === null && minute === 570 ? volumeTotal : adjacent && volumeTotal !== null && previousVolume !== null && volumeTotal >= previousVolume ? volumeTotal - previousVolume : null;
    previousMinute = minute; previousVolume = volumeTotal;
    return [{ time: `${date}T${t.slice(0, 2)}:${t.slice(2)}:00+08:00`, price, volume, average: volumeTotal > 0 && amount !== null ? amount / volumeTotal : null }];
  });
}

export function createMarketService({ cacheDir, fetchImpl = globalThis.fetch, onChange = () => {}, now = Date.now }) {
  if (typeof cacheDir !== 'string' || !cacheDir) throw new Error('行情缓存目录未配置。');
  let directory = null, sectorCache = null, directoryJob = null, sectorJob = null, closed = false;
  let directoryAttempt = -Infinity, lastSuccess = null, lastFailure = null, directoryFailure = null, sectorFailure = null, quoteFailure = null, liveSectors = false, progress = { loaded: 0, total: 0 };
  const quoteCache = new Map(), quoteJobs = new Map(), historyCache = new Map(), historyJobs = new Map(), liveQuotes = new Set(), liveHistories = new Set();
  const retries = new Map(), clock = () => new Date(now()).getTime(), stamp = () => new Date(clock()).toISOString();
  const deferred = key => clock() < (retries.get(key)?.at ?? -Infinity);
  function defer(key, message, minimum = 5000, maximum = 60_000) {
    const failures = (retries.get(key)?.failures || 0) + 1;
    retries.set(key, { failures, at: clock() + Math.min(maximum, minimum * 2 ** Math.min(failures - 1, 20)), message });
  }
  let quoteSave = Promise.resolve();
  let nextStart = 0, gate = Promise.resolve(), active = 0;
  const slots = [];
  const emit = () => { try { onChange({ type: 'market', progress: { ...progress } }); } catch {} };
  const cachePath = key => join(cacheDir, `${key}.json`);
  async function readCache(key) { try { const j = JSON.parse(await readFile(cachePath(key), 'utf8')); return j.schemaVersion === 1 && typeof j.fetchedAt === 'string' && Array.isArray(j.items) ? j : null; } catch { return null; } }
  async function saveCache(key, value) {
    if (closed) return;
    try {
      await mkdir(cacheDir, { recursive: true });
      const tmp = `${cachePath(key)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
      await writeFile(tmp, JSON.stringify({ schemaVersion: 1, ...value }), 'utf8');
      await rename(tmp, cachePath(key));
    } catch (e) { throw friendlyError(e, '缓存'); }
  }
  const initialized = (async () => {
    try { await mkdir(cacheDir, { recursive: true }); cacheDir = await realpath(cacheDir); }
    catch (e) { throw friendlyError(e, '缓存'); }
    [directory, sectorCache] = await Promise.all([readCache('stocks'), readCache('sectors')]);
    if (directory && (!directory.complete || !directory.coverage || directory.items.length !== directory.coverage.total || new Set(directory.items.map(x => x.symbol)).size !== directory.items.length || directory.items.some(x => !isStock(x.symbol)))) directory = null;
    if (directory) progress = { loaded: directory.items.length, total: directory.items.length };
    const q = await readCache('quotes');
    if (q) for (const item of q.items) { if (symbolType(item.symbol) && typeof item.time === 'string' && item.source === QUOTE_SOURCE) quoteCache.set(item.symbol, item); }
  })();

  async function schedule() {
    if (closed) throw failure('行情服务已关闭。');
    if (active >= 3) await new Promise(resolve => slots.push(resolve));
    else active++;
    const pending = gate.then(async () => { const wait = Math.max(0, nextStart - Date.now()); if (wait) await new Promise(r => setTimeout(r, wait)); nextStart = Date.now() + 150; });
    gate = pending.catch(() => {});
    await pending;
    return () => { const waiter = slots.shift(); if (waiter) waiter(); else active--; };
  }
  async function request(url, encoding = 'utf-8') {
    let last;
    for (let attempt = 0; attempt < 2; attempt++) {
      const release = await schedule();
      try {
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(10_000), headers: { 'User-Agent': 'InvestmentTradingRoom/1.0', Referer: 'https://finance.sina.com.cn/' } });
        if (!response.ok) throw failure(`行情源请求失败（${response.status}）。`);
        const declared = Number(response.headers?.get?.('content-length'));
        if (declared > MAX_BODY) throw failure('行情源返回内容过大。');
        const reader = response.body?.getReader();
        let bytes;
        if (reader) {
          const chunks = []; let count = 0;
          for (;;) { const { done, value } = await reader.read(); if (done) break; count += value.byteLength; if (count > MAX_BODY) { await reader.cancel(); throw failure('行情源返回内容过大。'); } chunks.push(value); }
          bytes = Buffer.concat(chunks.map(c => Buffer.from(c)), count);
        } else { bytes = new Uint8Array(await response.arrayBuffer()); if (bytes.byteLength > MAX_BODY) throw failure('行情源返回内容过大。'); }
        const text = new TextDecoder(encoding).decode(bytes);
        lastSuccess = stamp(); lastFailure = null;
        return text;
      } catch (e) { last = e; } finally { release(); }
      if (attempt === 0) await new Promise(r => setTimeout(r, 350));
    }
    const safe = friendlyError(last);
    lastFailure = safe.message;
    throw safe;
  }
  function currentQuote(q) {
    const now = clock(), age = now - Date.parse(q.time), fetchedAge = now - Date.parse(q.fetchedAt), session = getMarketSession(new Date(now));
    const fresh = age >= -5000 && age <= 90_000 && fetchedAge >= -5000 && fetchedAge <= 30_000 && q.time.slice(0, 10) === session.date;
    const live = liveQuotes.has(q.symbol);
    return { ...q, cached: !live || fetchedAge > TTL_QUOTES, stale: !live || !fresh, tradeable: Boolean(q.tradeable && live && fresh && session.open) };
  }
  async function refreshDirectory({ force = false } = {}) {
    await initialized;
    if (directoryJob) return directoryJob;
    if (deferred('directory')) { if (directory) return directory; throw failure(directoryFailure || '全部A股目录暂不可用，请稍后重试。'); }
    if (directory && ((!force && clock() - Date.parse(directory.fetchedAt) < TTL_DIRECTORY) || clock() - directoryAttempt < TTL_DIRECTORY)) return directory;
    directoryAttempt = clock();
    directoryJob = (async () => {
      try {
        const countUrl = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeStockCount?node=hs_a';
        const countRaw = await request(countUrl, 'gb18030'), total = Number(JSON.parse(countRaw));
        if (!Number.isSafeInteger(total) || total < 1 || total > 10_000) throw failure('A股目录总数异常，没有覆盖已有完整目录。');
        progress = { loaded: 0, total }; emit();
        const pages = new Array(Math.ceil(total / 80)); let nextPage = 0, failed = false;
        const results = await Promise.allSettled(Array.from({ length: 3 }, async () => {
          while (nextPage < pages.length && !failed) {
            try {
            const i = nextPage++;
            const u = new URL('https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData');
            for (const [key, val] of Object.entries({ page: i + 1, num: 80, sort: 'symbol', asc: 1, node: 'hs_a', symbol: '', _s_r_a: 'page' })) u.searchParams.set(key, String(val));
            const text = await request(u.toString(), 'gb18030'), items = parseSinaRows(JSON.parse(text));
            const expected = Math.min(80, total - i * 80);
            if (items.length !== expected) throw failure(`A股目录第${i + 1}页不完整（${items.length}/${expected}），没有覆盖已有目录。`);
            pages[i] = { text, items }; progress.loaded += items.length; emit();
            } catch (e) { failed = true; throw e; }
          }
        }));
        const rejected = results.find(r => r.status === 'rejected'); if (rejected) throw rejected.reason;
        const endRaw = await request(countUrl, 'gb18030');
        if (Number(JSON.parse(endRaw)) !== total) throw failure('加载期间上市目录数量变化，请重新刷新。');
        const items = pages.flatMap(p => p.items), unique = new Set(items.map(x => x.symbol));
        const counts = { sh: 0, sz: 0, bj: 0 }; for (const item of items) counts[item.market]++;
        if (unique.size !== total || Object.values(counts).some(n => n === 0)) throw failure('目录重复或缺少沪深京市场，未更新完整行情目录。');
        const value = { fetchedAt: stamp(), asOf: null, source: STOCK_SOURCE, complete: true, coverage: { total, ...counts, pages: pages.length, unique: unique.size, verifiedTotal: total, complete: true }, items, raw: { count: countRaw, endCount: endRaw, pages: pages.map(p => p.text) } };
        await saveCache('stocks', value); directory = value; lastFailure = null; directoryFailure = null; retries.delete('directory'); emit(); return directory;
      } catch (e) { const safe = friendlyError(e); lastFailure = safe.message; directoryFailure = safe.message; defer('directory', safe.message, TTL_DIRECTORY, 300_000); emit(); if (directory) return directory; throw safe; }
      finally { directoryJob = null; }
    })();
    return directoryJob;
  }
  function ensureDirectory() { if (!closed && !directoryJob && !deferred('directory') && (!directory || clock() - Date.parse(directory.fetchedAt) >= TTL_DIRECTORY)) void refreshDirectory().catch(() => {}); }
  function sectorResult() {
    if (!sectorCache) return { items: [], fetchedAt: null, asOf: null, source: SECTOR_SOURCE, cached: false, warning: sectorFailure || '板块行情暂不可用，请稍后刷新。' };
    return { ...sectorCache, cached: !liveSectors || Boolean(sectorFailure) || clock() - Date.parse(sectorCache.fetchedAt) >= TTL_SECTORS, ...(sectorFailure ? { warning: `板块行情更新失败，显示缓存：${sectorFailure}` } : {}) };
  }
  async function loadSectors(refresh = false) {
    if (sectorJob) return sectorJob;
    if (deferred('sectors') || sectorCache && clock() - Date.parse(sectorCache.fetchedAt) < TTL_SECTORS && !refresh) return sectorResult();
    sectorJob = (async () => {
      const primaryDeferred = deferred('sector-primary');
      try {
        if (primaryDeferred) throw failure('东方财富板块源暂不可用，等待下一次重试。');
        const pages = []; let total = null;
        for (let page = 1; page <= 15; page++) {
          const u = new URL('https://79.push2.eastmoney.com/api/qt/clist/get');
          for (const [k, v] of Object.entries({ pn: page, pz: 100, po: 0, np: 1, fltt: 2, invt: 2, fid: 'f12', fs: 'm:90+t:2', fields: 'f2,f3,f4,f5,f6,f8,f12,f13,f14,f124' })) u.searchParams.set(k, String(v));
          const text = await request(u.toString()), j = rawJson(text); if (j.rc !== 0 || !j.data || !Array.isArray(j.data.diff)) throw failure('板块源未返回有效行情。');
          if (total === null) { total = j.data.total; if (!Number.isSafeInteger(total) || total <= 0 || total > 1500) throw failure('板块目录数量异常。'); }
          if (j.data.total !== total) throw failure('板块目录在加载期间变化。');
          const items = parseSectorRows(j.data.diff); if (items.length !== Math.min(100, total - (page - 1) * 100)) throw failure('板块目录分页不完整。');
          pages.push({ text, items }); if (page * 100 >= total) break;
        }
        const items = pages.flatMap(p => p.items); if (items.length !== total || new Set(items.map(x => x.symbol)).size !== total) throw failure('板块目录重复或截断。');
        const value = { fetchedAt: stamp(), asOf: latestTime(items), source: SECTOR_SOURCE, items, raw: pages.map(p => p.text) };
        await saveCache('sectors', value); sectorCache = value; sectorFailure = null; liveSectors = true; retries.delete('sectors'); retries.delete('sector-primary'); emit(); return sectorResult();
      } catch (e) {
        if (!primaryDeferred) defer('sector-primary', friendlyError(e).message, TTL_SECTORS, 300_000);
        try {
          const raw = await request('https://vip.stock.finance.sina.com.cn/q/view/newSinaHy.php', 'gb18030');
          const items = parseSinaSectors(raw), warning = '东方财富板块源暂不可用，已切换新浪行业概况；行业分类不同，平均股价不作为板块指数，不提供指数走势图。';
          const value = { fetchedAt: stamp(), asOf: null, source: SINA_SECTOR_SOURCE, items, raw, warning };
          await saveCache('sectors', value); sectorCache = value; sectorFailure = null; liveSectors = true; retries.delete('sectors'); emit(); return sectorResult();
        } catch (fallbackError) {
          lastFailure = friendlyError(fallbackError).message; sectorFailure = `板块源不可用：${friendlyError(e).message}；备用源：${lastFailure}`;
          liveSectors = false; defer('sectors', sectorFailure, TTL_SECTORS, 300_000); return sectorResult();
        }
      }
      finally { sectorJob = null; }
    })(); return sectorJob;
  }
  async function quoteData(symbols, { refresh = false } = {}) {
    await initialized;
    if (!Array.isArray(symbols) || symbols.length > 300) throw failure('每次报价查询最多300个证券。', 'INVALID_SYMBOL');
    const valid = [...new Set(symbols.map(validateSymbol))], ordinary = valid.filter(s => !s.startsWith('sector:'));
    const needed = ordinary.filter(s => !quoteJobs.has(s) && !deferred(`quote:${s}`) && (refresh || !liveQuotes.has(s) || !quoteCache.has(s) || clock() - Date.parse(quoteCache.get(s).fetchedAt) >= TTL_QUOTES));
    for (let i = 0; i < needed.length; i += 60) {
      const batch = needed.slice(i, i + 60);
      const job = (async () => {
        try {
          const raw = await request(`https://qt.gtimg.cn/q=${batch.join(',')}`, 'gb18030'), fetchedAt = stamp(), items = parseTencent(raw, fetchedAt).filter(q => batch.includes(q.symbol));
          const received = new Set(items.map(q => q.symbol));
          for (const item of items) { quoteCache.set(item.symbol, item); liveQuotes.add(item.symbol); retries.delete(`quote:${item.symbol}`); }
          const missing = batch.filter(symbol => !received.has(symbol));
          for (const symbol of missing) { liveQuotes.delete(symbol); defer(`quote:${symbol}`, '该证券没有收到有效报价。'); }
          // Serial writes take a current snapshot so overlapping batches cannot
          // overwrite the disk cache with an older, smaller set of quotes.
          quoteSave = quoteSave.catch(() => {}).then(() => saveCache('quotes', { fetchedAt, source: QUOTE_SOURCE, items: [...quoteCache.values()], raw }));
          await quoteSave;
          if (missing.length) quoteFailure = lastFailure = '部分证券没有收到有效报价；不生成替代价格。';
          else quoteFailure = null;
        } catch (e) {
          const message = friendlyError(e).message;
          for (const symbol of batch) { liveQuotes.delete(symbol); defer(`quote:${symbol}`, message); }
          quoteFailure = lastFailure = message;
        }
      })().finally(() => { for (const symbol of batch) if (quoteJobs.get(symbol) === job) quoteJobs.delete(symbol); });
      for (const symbol of batch) quoteJobs.set(symbol, job);
    }
    await Promise.all([...new Set(ordinary.map(symbol => quoteJobs.get(symbol)).filter(Boolean))]);
    const items = ordinary.map(s => quoteCache.get(s)).filter(Boolean).map(currentQuote); let sectorWarning = '';
    if (valid.some(s => s.startsWith('sector:'))) {
      const sectors = await loadSectors(refresh); sectorWarning = sectors.warning || '';
      for (const s of valid.filter(s => s.startsWith('sector:'))) {
        const q = sectors.items.find(x => x.symbol === s);
        if (q) items.push({ ...q, previous: q.price !== null && q.change !== null ? q.price - q.change : null, open: null, high: null, low: null, bid: null, ask: null, bidSize: null, askSize: null, upper: null, lower: null, fetchedAt: sectors.fetchedAt, source: sectors.source, orderBook: { bids: [], asks: [] }, tradeable: false, cached: Boolean(sectors.cached), stale: true });
      }
    }
    return { items, sectorWarning };
  }
  async function getQuotes(symbols, options) {
    return (await quoteData(symbols, options)).items;
  }
  async function quotes({ symbols, refresh = false } = {}) {
    const { items, sectorWarning } = await quoteData(symbols, { refresh }), missing = symbols.filter(s => !items.some(q => q.symbol === s));
    const cached = items.some(q => q.cached), stale = items.some(q => q.type !== 'sector' && q.stale), ordinaryFailure = symbols.some(s => !s.startsWith('sector:')) ? quoteFailure : '';
    const deferredWarnings = [...new Set(symbols.map(s => retries.get(`quote:${s}`)?.message).filter(Boolean))];
    return { items, asOf: latestTime(items), fetchedAt: latestTime(items.map(q => ({ time: q.fetchedAt }))), source: [...new Set(items.map(q => q.source))].join(' / ') || QUOTE_SOURCE, cached, ...(missing.length || stale || ordinaryFailure || sectorWarning || deferredWarnings.length ? { warning: [missing.length ? `缺少报价：${missing.join('、')}` : '', stale ? '当前为收盘、延迟或离线报价，仅供查看；过期行情不会成交。' : '', ...deferredWarnings, ordinaryFailure, sectorWarning].filter(Boolean).join(' ') } : {}) };
  }
  function coverageText() { return directory ? `沪深京A股 ${directory.coverage.total} 只（沪${directory.coverage.sh}、深${directory.coverage.sz}、京${directory.coverage.bj}）；${directoryJob ? `更新中 ${progress.loaded}/${progress.total}` : '分页总数及重复核对通过'}` : directoryJob ? `正在加载全部A股 ${progress.loaded}/${progress.total || '待确认'}` : '全A股目录尚未就绪'; }
  async function status() { await initialized; const warning = [...new Set([directoryFailure, sectorFailure, sectorCache?.warning, quoteFailure, lastFailure].filter(Boolean))].join(' '); return { online: Boolean(lastSuccess && clock() - Date.parse(lastSuccess) < 180_000), session: getMarketSession(new Date(clock())), lastSuccess, coverage: coverageText(), loading: Boolean(directoryJob), progress: { ...progress }, ...(warning ? { warning } : {}) }; }
  function sortItems(items, sort = 'percent', direction = 'desc') {
    const field = ['percent', 'amount', 'turnover', 'code'].includes(sort) ? sort : 'percent', multiplier = direction === 'asc' ? 1 : -1;
    return [...items].sort((a, b) => { const x = a[field], y = b[field]; if (x === null || x === undefined) return y === null || y === undefined ? a.symbol.localeCompare(b.symbol) : 1; if (y === null || y === undefined) return -1; const diff = field === 'code' ? String(x).localeCompare(String(y)) : Number(x) - Number(y); return multiplier * diff || a.symbol.localeCompare(b.symbol); });
  }
  async function overview({ refresh = false } = {}) {
    await initialized; ensureDirectory(); if (refresh && directory) void refreshDirectory({ force: true }).catch(() => {});
    const [indices, sectors] = await Promise.all([getQuotes(INDEX_SYMBOLS, { refresh }), loadSectors(refresh)]);
    const all = directory?.items || [], breadth = { up: 0, down: 0, flat: 0, amount: 0, total: all.length, priced: 0, limitUp: null, limitDown: null, limitWarning: '当前目录源未提供每只股票的当日实际涨跌停价，涨跌停数量暂不统计。' };
    for (const q of all) { if (q.percent !== null) { breadth.priced++; q.percent > 0 ? breadth.up++ : q.percent < 0 ? breadth.down++ : breadth.flat++; } if (q.amount !== null) breadth.amount += q.amount; }
    const warnings = [!directory ? '正在首次加载沪深京全部A股目录；市场统计和热门榜会在完成后显示。' : '', directory && clock() - Date.parse(directory.fetchedAt) >= TTL_DIRECTORY ? '市场广度使用最后一次完整目录缓存。' : '', sectors.warning || sectorFailure || '', directoryFailure || '', quoteFailure || '', !getMarketSession(new Date(clock())).open ? '当前休市，显示最近真实行情。' : ''].filter(Boolean);
    return { indices, sectors: sortItems(sectors.items, 'percent').slice(0, 12), hot: sortItems(all.filter(q => q.price !== null), 'amount').slice(0, 12), breadth, asOf: latestTime(indices), fetchedAt: directory?.fetchedAt || null, source: `${STOCK_SOURCE} / ${QUOTE_SOURCE} / ${sectors.source}`, cached: Boolean(directory && (directoryFailure || clock() - Date.parse(directory.fetchedAt) >= TTL_DIRECTORY)) || indices.some(q => q.cached) || sectors.cached, coverage: coverageText(), coverageDetail: directory?.coverage || { complete: false, ...progress }, loading: !directory, ...(warnings.length ? { warning: warnings.join(' ') } : {}) };
  }
  async function list(params = {}) {
    await initialized;
    const { kind = 'stocks', market = 'all', query = '', sort = 'percent', direction = 'desc' } = params;
    if (!['stocks', 'indices', 'sectors', 'hot'].includes(kind) || !['all', 'sh', 'sz', 'bj'].includes(market) || typeof query !== 'string' || query.length > 80) throw failure('行情列表查询参数无效。', 'INVALID_QUERY');
    const page = Math.max(1, Math.min(1000, Math.floor(Number(params.page) || 1))), pageSize = Math.max(10, Math.min(100, Math.floor(Number(params.pageSize) || 50)));
    let items, source, fetchedAt, asOf, explicitCached, warning = '';
    if (kind === 'indices') { const data = await quotes({ symbols: INDEX_SYMBOLS, refresh: params.refresh }); items = data.items; source = data.source; fetchedAt = data.fetchedAt; asOf = data.asOf; explicitCached = data.cached; warning = data.warning || ''; }
    else if (kind === 'sectors') { const data = await loadSectors(params.refresh); items = data.items; source = data.source; fetchedAt = data.fetchedAt; asOf = data.asOf; explicitCached = data.cached; warning = data.warning || ''; }
    else { ensureDirectory(); items = directory?.items || []; source = STOCK_SOURCE; fetchedAt = directory?.fetchedAt || null; asOf = null; explicitCached = Boolean(directory && (directoryFailure || clock() - Date.parse(directory.fetchedAt) >= TTL_DIRECTORY)); if (!directory) warning = directoryFailure || '全部A股正在加载，请稍后刷新。'; else if (directoryFailure || clock() - Date.parse(directory.fetchedAt) >= TTL_DIRECTORY) warning = `当前显示完整目录缓存，正在尝试更新；目录仅提供行情查看。${directoryFailure || ''}`; if (kind === 'hot') { items = sortItems(items.filter(q => q.price !== null), 'amount').slice(0, 100); source += ' · 成交额热门榜'; } }
    const needle = query.trim().toLowerCase();
    items = items.filter(x => (market === 'all' || x.market === market) && (!needle || x.code.includes(needle) || x.symbol.toLowerCase().includes(needle) || x.name.toLowerCase().includes(needle)));
    items = sortItems(items, kind === 'hot' ? 'amount' : sort, direction);
    const total = items.length, selected = items.slice((page - 1) * pageSize, page * pageSize);
    return { items: selected, total, page, pageSize, asOf, fetchedAt, source, cached: explicitCached ?? Boolean(fetchedAt && clock() - Date.parse(fetchedAt) >= (kind === 'indices' ? TTL_QUOTES : kind === 'sectors' ? TTL_SECTORS : TTL_DIRECTORY)), loading: (kind === 'stocks' || kind === 'hot') && !directory, progress: { ...progress }, coverage: coverageText(), ...(warning ? { warning } : {}) };
  }
  async function historyData({ symbol, kind = 'day', refresh = false } = {}) {
    await initialized; validateSymbol(symbol);
    if (!['minute', 'day', 'week', 'month'].includes(kind)) throw failure('不支持的行情图周期。', 'INVALID_QUERY');
    if (symbol.startsWith('sector:sina:')) return { items: [], source: SINA_SECTOR_SOURCE, asOf: null, fetchedAt: null, cached: false, warning: '新浪备用行业源提供行业涨跌、成交量额和领先股，没有可用板块指数走势图。' };
    const key = `${symbol.replaceAll(':', '-')}-${kind}`, ttl = kind === 'minute' ? 5000 : 30_000;
    if (!historyCache.has(key)) { const saved = await readCache(`history-${key}`); if (saved) historyCache.set(key, saved); }
    const existing = historyCache.get(key);
    if (historyJobs.has(key)) return historyJobs.get(key);
    if (deferred(`history:${key}`)) return { items: existing?.items || [], source: existing?.source || (symbol.startsWith('sector:') ? SECTOR_SOURCE : QUOTE_SOURCE), asOf: existing?.asOf || null, fetchedAt: existing?.fetchedAt || null, cached: Boolean(existing), warning: `${existing ? '更新失败，显示最后缓存走势图：' : ''}${retries.get(`history:${key}`).message}` };
    if (existing && clock() - Date.parse(existing.fetchedAt) < ttl && !refresh) return { items: existing.items, source: existing.source, asOf: existing.asOf, fetchedAt: existing.fetchedAt, cached: !liveHistories.has(key), ...(existing.warning ? { warning: existing.warning } : {}) };
    if (!historyJobs.has(key)) {
      const job = (async () => {
        try {
          let items, raw, source;
          if (symbol.startsWith('sector:')) {
            const minute = kind === 'minute', u = new URL(`https://push2his.eastmoney.com/api/qt/stock/${minute ? 'trends2/get' : 'kline/get'}`);
            for (const [k, v] of Object.entries(minute ? { secid: `90.${symbol.slice(7)}`, ndays: 1, fields1: 'f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11', fields2: 'f51,f52,f53,f54,f55,f56,f57,f58' } : { secid: `90.${symbol.slice(7)}`, klt: kind === 'day' ? 101 : kind === 'week' ? 102 : 103, fqt: 0, end: '20500101', lmt: 160, fields1: 'f1,f2,f3,f4,f5,f6', fields2: 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61' })) u.searchParams.set(k, String(v));
            raw = await request(u.toString()); const j = rawJson(raw); if (j.rc !== 0 || !j.data) throw failure('板块走势图源没有返回数据。');
            const rows = minute ? j.data.trends : j.data.klines;
            if (!Array.isArray(rows)) throw failure('板块走势图源没有返回数据。');
            items = rows.flatMap(row => { const f = typeof row === 'string' ? row.split(',') : [], price = positive(f[2]); if (!price || !f[0]) return []; if (minute) return [{ time: f[0].replace(' ', 'T') + ':00+08:00', price, open: positive(f[1]), high: positive(f[3]), low: positive(f[4]), volume: scaled(f[5], 100), average: positive(f[7]) }]; return parseCandleRows([[f[0], f[1], f[2], f[3], f[4], f[5]]]); }); source = SECTOR_SOURCE;
          } else {
            const url = kind === 'minute' ? `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${symbol}` : `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},${kind},,,160,`;
            raw = await request(url); const j = rawJson(raw), data = j.data?.[symbol];
            if (j.code !== 0 || !data) throw failure('该证券当前没有可用走势图。');
            items = kind === 'minute' ? parseMinuteRows(data.data) : parseCandleRows(data[kind]); source = QUOTE_SOURCE;
          }
          if (!items.length) throw failure('该证券当前没有有效走势图，不生成替代曲线。');
          const warning = kind !== 'minute' && items.length < 20 ? `行情源仅返回${items.length}条历史记录；显示已收到的真实数据，不补造曲线。` : null;
          const value = { items, fetchedAt: stamp(), asOf: items.at(-1).time, source, raw, ...(warning ? { warning } : {}) }; await saveCache(`history-${key}`, value); historyCache.set(key, value); liveHistories.add(key); retries.delete(`history:${key}`);
          return { items, source, asOf: value.asOf, fetchedAt: value.fetchedAt, cached: false, ...(warning ? { warning } : {}) };
        } catch (e) { const warning = friendlyError(e).message; defer(`history:${key}`, warning); liveHistories.delete(key); if (existing) return { items: existing.items, source: existing.source, asOf: existing.asOf, fetchedAt: existing.fetchedAt, cached: true, warning: `更新失败，显示最后缓存走势图：${warning}` }; return { items: [], source: symbol.startsWith('sector:') ? SECTOR_SOURCE : QUOTE_SOURCE, asOf: null, fetchedAt: null, cached: false, warning }; }
      })().finally(() => historyJobs.delete(key)); historyJobs.set(key, job);
    }
    return historyJobs.get(key);
  }
  async function history(payload = {}) {
    const value = await historyData(payload);
    if (symbolType(payload.symbol) !== 'index') return value;
    // Amount / aggregate shares is a constituent-stock price, not index points.
    // Apply this at the return boundary so older in-memory and disk caches are safe.
    return { ...value, items: value.items.map(point => Object.hasOwn(point, 'average') ? { ...point, average: null } : point) };
  }
  return {
    async start() { await initialized; ensureDirectory(); }, overview, list, quotes, getQuotes, history, status, refreshDirectory,
    close() { closed = true; },
  };
}

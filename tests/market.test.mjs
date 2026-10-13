import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMarketService, parseTencent, parseSinaRows, parseSectorRows, parseSinaSectors, parseCandleRows, parseMinuteRows } from '../services/market-service.mjs';

const temp = () => mkdtemp(join(tmpdir(), 'market-unit-'));
function clockFixture() {
  let ms = Date.parse('2026-10-09T10:00:00+08:00');
  return { now: () => new Date(ms), advance: n => { ms += n; }, stamp: () => new Date(ms).toISOString() };
}
const liveTencent = (symbol, fields = {}) => tencent(symbol, { 30: '20261009100000', ...fields });
const sectorFixture = () => new Response(JSON.stringify({ rc: 0, data: { total: 1, diff: [{ f12: 'BK1234', f14: 'Sector', f2: 100, f3: 1, f5: 300, f6: 30000, f124: 1791511200 }] } }));
function historyFixture(url) {
  const minute = url.includes('/minute/'), params = new URL(url).searchParams;
  const symbol = minute ? params.get('code') : params.get('param').split(',')[0], kind = minute ? 'minute' : params.get('param').split(',')[1];
  const data = minute ? { data: { date: '20261009', data: ['0930 10 1 1000', '0931 10.1 3 3030'] } } : { [kind]: [['2026-10-09', '10', '11', '12', '9', '30']] };
  return new Response(JSON.stringify({ code: 0, data: { [symbol]: data } }));
}
const row = (symbol, name = symbol) => ({ symbol, code: symbol.slice(2), name, trade: '10.01', pricechange: -0.2, changepercent: -1.96, volume: 300, amount: 3003, turnoverratio: 0.12, ticktime: '15:00:00' });
function tencent(symbol = 'sh600519', overrides = {}) {
  const f = Array(90).fill(''); Object.assign(f, { 0: '1', 1: 'Real upstream fixture', 2: symbol.slice(2), 3: '10.01', 4: '10', 5: '10', 6: '123', 9: '10.00', 10: '7', 19: '10.01', 20: '9', 30: '20261009150000', 31: '0.01', 32: '0.1', 33: '10.1', 34: '9.9', 37: '123.45', 38: '0.1', 47: '11', 48: '9', ...overrides });
  return `v_${symbol}="${f.join('~')}";`;
}
function directoryFetch(rows, opts = {}) {
  const calls = []; let active = 0, maxActive = 0;
  const fetchImpl = async url => {
    calls.push(url); active++; maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 2)); active--;
    if (url.includes('getHQNodeStockCount')) return new Response(JSON.stringify(String(rows.length)));
    if (url.includes('getHQNodeData')) { const page = Number(new URL(url).searchParams.get('page')); const items = rows.slice((page - 1) * 80, page * 80); return new Response(JSON.stringify(opts.truncate && page === 1 ? items.slice(0, -1) : items)); }
    if (url.includes('qt.gtimg')) return new Response(tencent());
    throw new Error(`Unexpected URL: ${url}`);
  };
  return { fetchImpl, calls, get maxActive() { return maxActive; } };
}

test('腾讯解析保留报价日期，五档手数转换为股，并区分同代码指数/股票/北交所', () => {
  const qs = parseTencent(tencent('sh000001') + tencent('sz000001') + tencent('bj920001'));
  assert.deepEqual(qs.map(q => q.type), ['index', 'stock', 'stock']);
  assert.equal(qs[0].time, '2026-10-09T15:00:00+08:00');
  assert.equal(qs[1].bidSize, 700); assert.equal(qs[1].askSize, 900); assert.equal(qs[1].volume, 12300); assert.equal(qs[1].amount, 1234500);
  assert.equal(qs[2].board, 'bse'); assert.equal(qs[0].tradeable, false);
});
test('腾讯拒绝身份错配、坏时间及零价格，不构造缺失价格', () => {
  assert.equal(parseTencent(tencent('sh600519', { 2: '600000' })).length, 0);
  assert.equal(parseTencent(tencent('sh600519', { 30: '20260230150000' })).length, 0);
  assert.equal(parseTencent(tencent('sh600519', { 30: '20261009259900' })).length, 0);
  assert.equal(parseTencent(tencent('sh600519', { 3: '0' })).length, 0);
});
test('盘口交叉或上下限缺失仅看行情，不能成为可执行报价', () => {
  assert.equal(parseTencent(tencent('sh600519', { 9: '10.02', 19: '10.01' }))[0].tradeable, false);
  assert.equal(parseTencent(tencent('sh600519', { 47: '-1', 48: '-1' }))[0].tradeable, false);
  assert.equal(parseTencent(tencent('sh600519', { 9: '0', 19: '0' }))[0].tradeable, false);
  assert.equal(parseTencent(tencent('sh600519', { 19: '11.01' }))[0].tradeable, false);
  assert.equal(parseTencent(tencent('sh600519', { 19: '10.001' }))[0].tradeable, false);
});
test('上游超大响应有流式上限，失败重试有限，不返回虚构报价', async () => {
  let calls = 0, cancelled = 0;
  const m = createMarketService({ cacheDir: await temp(), fetchImpl: async () => {
    calls++;
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(3 * 1024 * 1024)); controller.enqueue(new Uint8Array(3 * 1024 * 1024)); }, cancel() { cancelled++; } }));
  } });
  assert.deepEqual(await m.getQuotes(['sh600519']), []); assert.equal(calls, 2); assert.equal(cancelled, 2); assert((await m.status()).warning.includes('过大')); m.close();
});
test('新浪列表不把无日期的ticktime当实际行情时间，成交量原单位股', () => {
  const [q] = parseSinaRows([row('bj920001')]); assert.equal(q.time, null); assert.equal(q.quoteClock, '15:00:00'); assert.equal(q.volume, 300);
  assert.throws(() => parseSinaRows([row('sh000001')]));
  assert.throws(() => parseSinaRows([{ ...row('sh600519'), code: '600000' }]));
});
test('板块使用独立标识，缺数值保留null，拒绝非板块证券', () => {
  const qs = parseSectorRows([{ f12: 'BK1234', f14: 'Sector', f2: '-', f3: '-', f5: 3 }, { f12: '600519', f14: 'Stock' }]);
  assert.equal(qs.length, 1); assert.equal(qs[0].symbol, 'sector:BK1234'); assert.equal(qs[0].type, 'sector'); assert.equal(qs[0].price, null); assert.equal(qs[0].volume, 300);
});
test('新浪行业只安全解析JSON包装，不执行脚本、不把平均股价当指数', () => {
  const raw = 'var S_Finance_bankuai_sinaindustry = {"new_bank":"new_bank,Bank,10,10.5,0.1,1,1000,10500,sz000001,2,11,0.1,PingAn"};';
  const [q] = parseSinaSectors(raw); assert.equal(q.symbol, 'sector:sina:new_bank'); assert.equal(q.price, null); assert.equal(q.averagePrice, 10.5); assert.equal(q.members, 10); assert.equal(q.leader.symbol, 'sz000001');
  assert.throws(() => parseSinaSectors(raw + 'globalThis.injected=true;')); assert.throws(() => parseSinaSectors('var S_Finance_bankuai_sinaindustry = {};'));
});
test('东方财富受限时换真实新浪行业源，明确不同分类及缺指数曲线', async () => {
  let emCalls = 0;
  const m = createMarketService({ cacheDir: await temp(), fetchImpl: async url => { if (url.includes('eastmoney')) { emCalls++; throw new Error('Upstream socket closed'); } return new Response('var S_Finance_bankuai_sinaindustry = {"new_bank":"new_bank,Bank,10,10.5,0.1,1,1000,10500,sz000001,2,11,0.1,PingAn"};'); } });
  const l = await m.list({ kind: 'sectors' }); assert.equal(emCalls, 2); assert.equal(l.total, 1); assert(l.source.includes('新浪')); assert(l.warning.includes('分类不同'));
  const q = (await m.getQuotes([l.items[0].symbol]))[0]; assert.equal(q.price, null); assert.equal(q.tradeable, false); assert(q.source.includes('新浪'));
  assert.equal(q.cached, false); assert.equal(q.stale, true);
  const wrapped = await m.quotes({ symbols: [q.symbol] }); assert.equal(wrapped.cached, false); assert.equal(wrapped.warning, l.warning);
  const h = await m.history({ symbol: q.symbol, kind: 'day' }); assert.equal(h.items.length, 0); assert(h.warning.includes('没有可用')); m.close();
});
test('日K保留OHLC真实关系，坏记录不补线', () => {
  const points = parseCandleRows([['2026-10-09', '10', '11', '12', '9', '30'], ['2026-10-09', '10', '11', '9', '8', '2']]);
  assert.equal(points.length, 1); assert.deepEqual(points[0], { time: '2026-10-09', open: 10, price: 11, high: 12, low: 9, volume: 3000 });
});
test('分时量从累计真实量求差，跳分钟不冒造量，午休不插值', () => {
  const points = parseMinuteRows({ date: '20261009', data: ['0930 10 1 1000', '0931 10.1 3 3030', '0933 10.2 4 4080', '1200 10.2 4 4080', '1500 11 5 5500'] });
  assert.equal(points.length, 4); assert.equal(points[0].volume, 100); assert.equal(points[1].volume, 200); assert.equal(points[2].volume, null); assert.equal(points[0].average, 10);
  assert.equal(points[0].time, '2026-10-09T09:30:00+08:00');
});
test('指数历史不返回成分股均价，股票均价与各周期真实量保持原样', async () => {
  const m = createMarketService({ cacheDir: await temp(), fetchImpl: async url => {
    const minute = url.includes('/minute/'), symbol = minute ? new URL(url).searchParams.get('code') : new URL(url).searchParams.get('param').split(',')[0];
    const data = minute ? { data: { date: '20261009', data: ['0930 10 1 1000', '0931 10.1 3 3030'] } } : { day: [['2026-10-09', '10', '11', '12', '9', '30']] };
    return new Response(JSON.stringify({ code: 0, data: { [symbol]: data } }));
  } });
  const index = await m.history({ symbol: 'sh000001', kind: 'minute' });
  const stock = await m.history({ symbol: 'sz000001', kind: 'minute' });
  assert.deepEqual(index.items.map(p => p.average), [null, null]);
  assert.deepEqual(stock.items.map(p => p.average), [10, 10.1]);
  assert.deepEqual(index.items.map(p => p.volume), [100, 200]);
  assert.deepEqual(index.items.map(({ average, ...p }) => p), stock.items.map(({ average, ...p }) => p));
  assert.equal(index.asOf, '2026-10-09T09:31:00+08:00');
  assert.deepEqual((await m.history({ symbol: 'sh000001', kind: 'minute' })).items, index.items);
  const indexDay = await m.history({ symbol: 'sh000001', kind: 'day' }), stockDay = await m.history({ symbol: 'sz000001', kind: 'day' });
  assert.deepEqual(indexDay.items, stockDay.items); assert.equal(indexDay.items[0].volume, 3000); assert(!Object.hasOwn(indexDay.items[0], 'average')); m.close();
});
test('旧指数分时磁盘缓存无论有效期内或断网回退均清除错误均价，不重写原始缓存', async () => {
  for (const fresh of [true, false]) {
    const cacheDir = await temp(), file = join(cacheDir, 'history-sh000001-minute.json');
    const saved = { schemaVersion: 1, fetchedAt: fresh ? new Date().toISOString() : '2000-01-01T00:00:00.000Z', asOf: '2026-10-09T09:30:00+08:00', source: 'isolated-old-cache-fixture', items: [{ time: '2026-10-09T09:30:00+08:00', price: 3804.09, volume: 360022400, average: 16.58405369388127 }], raw: 'isolated old cache fixture' };
    await writeFile(file, JSON.stringify(saved)); let calls = 0;
    const m = createMarketService({ cacheDir, fetchImpl: async () => { calls++; throw new Error('Isolated offline fixture'); } });
    const value = await m.history({ symbol: 'sh000001', kind: 'minute' });
    assert.deepEqual(value.items, [{ ...saved.items[0], average: null }]); assert.equal(value.asOf, saved.asOf); assert.equal(value.cached, true);
    assert.equal(calls, fresh ? 0 : 2); if (!fresh) assert(value.warning.includes('显示最后缓存'));
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), saved); m.close();
  }
});
test('完整目录逐页/总数/覆盖检查及分页搜索排序', async () => {
  const rows = Array.from({ length: 161 }, (_, i) => row(i < 80 ? `sh${600000 + i}` : i < 160 ? `sz${String(i - 79).padStart(6, '0')}` : 'bj920001'));
  const f = directoryFetch(rows), cacheDir = await temp(), m = createMarketService({ cacheDir, fetchImpl: f.fetchImpl });
  const loaded = await m.refreshDirectory(); assert.equal(loaded.coverage.total, 161); assert.equal(loaded.coverage.pages, 3); assert.equal(loaded.coverage.bj, 1);
  const pages = [await m.list({ page: 1, pageSize: 100, sort: 'code', direction: 'asc' }), await m.list({ page: 2, pageSize: 100, sort: 'code', direction: 'asc' })];
  assert.equal(pages[0].items.length, 100); assert.equal(pages[1].items.length, 61); assert.equal(new Set(pages.flatMap(p => p.items.map(x => x.symbol))).size, 161);
  assert.equal((await m.list({ market: 'bj' })).total, 1); assert.equal((await m.list({ query: '600001' })).total, 1);
  assert.equal(f.calls.filter(x => x.includes('getHQNodeStockCount')).length, 2); assert(f.maxActive <= 3);
  const stored = JSON.parse(await readFile(join(cacheDir, 'stocks.json'), 'utf8')); assert.equal(stored.raw.pages.length, 3); m.close();
});
test('冷启动目录未齐返回明确loading，不能以示例证券冒充全A股', async () => {
  const f = directoryFetch([row('sh600519'), row('sz000001'), row('bj920001')]), m = createMarketService({ cacheDir: await temp(), fetchImpl: f.fetchImpl });
  const first = await m.list(); assert.equal(first.loading, true); assert.equal(first.items.length, 0); assert(first.warning);
  await m.refreshDirectory(); assert.equal((await m.list()).total, 3); m.close();
});
test('目录截断、重复和缺市场均拒绝发布完整目录', async () => {
  for (const [rows, options] of [[ [row('sh600519'), row('sz000001'), row('bj920001')], { truncate: true } ], [ [row('sh600519'), row('sh600519'), row('bj920001')], {} ], [ [row('sh600519'), row('sz000001')], {} ]]) {
    const f = directoryFetch(rows, options), m = createMarketService({ cacheDir: await temp(), fetchImpl: f.fetchImpl });
    await assert.rejects(m.refreshDirectory()); assert.equal((await m.status()).coverage.includes('尚未'), true); m.close();
  }
});
test('刷新失败保留原完整目录和原始源数据，不覆盖为不完整结果', async () => {
  const cacheDir = await temp(), rows = [row('sh600519'), row('sz000001'), row('bj920001')], f = directoryFetch(rows), m = createMarketService({ cacheDir, fetchImpl: f.fetchImpl });
  await m.refreshDirectory(); m.close();
  const p = join(cacheDir, 'stocks.json'), saved = JSON.parse(await readFile(p, 'utf8')); saved.fetchedAt = '2000-01-01T00:00:00Z'; await writeFile(p, JSON.stringify(saved));
  const bad = directoryFetch(rows, { truncate: true }), second = createMarketService({ cacheDir, fetchImpl: bad.fetchImpl });
  assert.equal((await second.refreshDirectory()).items.length, 3); assert((await second.status()).warning.includes('不完整'));
  const stillSaved = JSON.parse(await readFile(p, 'utf8')); assert.deepEqual(stillSaved.items, saved.items); second.close();
});
test('离线报价缓存永不变成可成交报价，原成交时间不替换为当前时间', async () => {
  const cacheDir = await temp(), m = createMarketService({ cacheDir, fetchImpl: async () => new Response(tencent()) });
  await m.getQuotes(['sh600519']); m.close();
  const offline = createMarketService({ cacheDir, fetchImpl: async () => { throw new Error('Offline'); } });
  const q = (await offline.getQuotes(['sh600519']))[0]; assert.equal(q.tradeable, false); assert.equal(q.cached, true); assert.equal(q.stale, true); assert.equal(q.time, '2026-10-09T15:00:00+08:00'); assert.equal((await offline.status()).online, false); offline.close();
});
test('历史数据缺失清晰报错，不用合成图；非法代码/周期拒绝', async () => {
  const m = createMarketService({ cacheDir: await temp(), fetchImpl: async () => new Response('{"code":0,"data":{}}') });
  const h = await m.history({ symbol: 'sh600519', kind: 'day' }); assert.equal(h.items.length, 0); assert(h.warning);
  await assert.rejects(m.history({ symbol: '../../secret', kind: 'day' })); await assert.rejects(m.history({ symbol: 'sh600519', kind: 'second' }));
  await assert.rejects(m.getQuotes(['sh600519', 'https://malicious.example'])); await assert.rejects(m.list({ query: 'a'.repeat(81) })); m.close();
});
test('读取真实历史缓存后断网仍可看，缓存不会生成新价格', async () => {
  const cacheDir = await temp();
  const m = createMarketService({ cacheDir, fetchImpl: async () => new Response(JSON.stringify({ code: 0, data: { sh600519: { day: [['2026-10-09', '10', '11', '12', '9', '3']] } } })) });
  const first = await m.history({ symbol: 'sh600519', kind: 'day' }); m.close();
  const key = join(cacheDir, 'history-sh600519-day.json'), saved = JSON.parse(await readFile(key, 'utf8')); saved.fetchedAt = '2000-01-01T00:00:00Z'; await writeFile(key, JSON.stringify(saved));
  const offline = createMarketService({ cacheDir, fetchImpl: async () => { throw new Error('Offline'); } });
  const last = await offline.history({ symbol: 'sh600519', kind: 'day' }); assert.equal(last.cached, true); assert(last.warning.includes('缓存')); assert.deepEqual(last.items, first.items); offline.close();
});
test('缓存路径经junction映射到真实目录后，首次与再次原子保存均成功', async () => {
  const base = await temp(), physical = join(base, 'physical'), alias = join(base, 'alias');
  await mkdir(physical); await symlink(await realpath(physical), alias, 'junction');
  const m = createMarketService({ cacheDir: alias, fetchImpl: async () => new Response(tencent()) });
  assert.equal((await m.getQuotes(['sh600519'])).length, 1);
  const stored = JSON.parse(await readFile(join(physical, 'quotes.json'), 'utf8')); assert.equal(stored.items[0].symbol, 'sh600519'); m.close();
  const again = createMarketService({ cacheDir: alias, fetchImpl: async () => new Response(tencent('sh600519', { 3: '10.02' })) });
  await again.getQuotes(['sh600519']); assert.equal(JSON.parse(await readFile(join(physical, 'quotes.json'), 'utf8')).items[0].price, 10.02); again.close();
});
test('缓存初始化错误返回友好中文，不将操作系统路径送至页面', async () => {
  const path = join(await temp(), 'not-a-directory'); await writeFile(path, 'file');
  const m = createMarketService({ cacheDir: path });
  await assert.rejects(m.start(), error => error.code === 'MARKET_CACHE_UNAVAILABLE' && error.message.includes('本地行情缓存') && !error.message.includes(path) && !/[A-Z]:\\/i.test(error.message)); m.close();
});
test('网络错误含Windows路径时，各行情接口警告只显示友好信息', async () => {
  const m = createMarketService({ cacheDir: await temp(), fetchImpl: async () => { throw new Error("EXDEV: cross-device link, rename 'C:\\PrivateData\\quotes.json.tmp' -> 'D:\\PrivateData\\quotes.json'"); } });
  const q = await m.quotes({ symbols: ['sh600519'] }), s = await m.status(), h = await m.history({ symbol: 'sh600519', kind: 'day' });
  for (const value of [q.warning, s.warning, h.warning]) { assert(value.includes('行情源连接失败')); assert(!value.includes('PrivateData')); assert(!value.includes('EXDEV')); assert(!/[A-Z]:\\/i.test(value)); }
  m.close();
});
test('指数都缺价时不把目录获取时间冒充行情时间，涨跌停不按百分比猜数', async () => {
  const rows = [row('sh600519'), row('sz000001'), row('bj920001')], base = directoryFetch(rows);
  const m = createMarketService({ cacheDir: await temp(), fetchImpl: async url => {
    if (url.includes('qt.gtimg')) return new Response('');
    if (url.includes('eastmoney')) return new Response(JSON.stringify({ rc: 0, data: { total: 1, diff: [{ f12: 'BK1234', f14: 'Sector', f2: 100, f3: 1 }] } }));
    return base.fetchImpl(url);
  } });
  await m.refreshDirectory(); const overview = await m.overview();
  assert.equal(overview.indices.length, 0); assert.equal(overview.asOf, null); assert(Number.isFinite(Date.parse(overview.fetchedAt)));
  assert.equal(overview.breadth.limitUp, null); assert.equal(overview.breadth.limitDown, null); assert(overview.breadth.limitWarning.includes('暂不统计')); m.close();
});
test('指数列表沿用离线Quote缓存标记，刚写过的缓存也不冒充在线新报价', async () => {
  const cacheDir = await temp(), now = new Date().toISOString(), q = parseTencent(tencent('sh000001'), now)[0];
  await writeFile(join(cacheDir, 'quotes.json'), JSON.stringify({ schemaVersion: 1, fetchedAt: now, source: q.source, items: [q] }));
  const m = createMarketService({ cacheDir, fetchImpl: async () => { throw new Error('Offline'); } });
  const list = await m.list({ kind: 'indices' }); assert.equal(list.items.length, 1); assert.equal(list.items[0].cached, true); assert.equal(list.cached, true); assert(list.warning.includes('离线报价')); assert.equal(list.asOf, q.time); m.close();
});
test('报价两秒过期，手动刷新更新获取时间但不重写真实行情时间', async () => {
  const c = clockFixture(); let calls = 0;
  const m = createMarketService({ cacheDir: await temp(), now: c.now, fetchImpl: async () => { calls++; return new Response(liveTencent('sh600519')); } });
  const first = await m.quotes({ symbols: ['sh600519'] }); assert.equal(first.items[0].tradeable, true); assert.equal(first.fetchedAt, c.stamp());
  c.advance(1999); await m.getQuotes(['sh600519']); assert.equal(calls, 1);
  c.advance(1); const updated = await m.quotes({ symbols: ['sh600519'] }); assert.equal(calls, 2); assert.equal(updated.fetchedAt, c.stamp()); assert.equal(updated.asOf, first.asOf);
  await m.quotes({ symbols: ['sh600519'], refresh: true }); assert.equal(calls, 3); m.close();
});
test('重叠报价请求逐证券合并并等待在途请求，缓存完整保存三只证券', async () => {
  const c = clockFixture(), cacheDir = await temp(), calls = []; let release, started;
  const held = new Promise(r => { release = r; }), began = new Promise(r => { started = r; });
  const m = createMarketService({ cacheDir, now: c.now, fetchImpl: async url => {
    const symbols = url.split('q=')[1].split(','); calls.push(symbols); if (symbols.includes('sh600519')) { started(); await held; }
    return new Response(symbols.map(s => liveTencent(s)).join(''));
  } });
  const first = m.getQuotes(['sh600519', 'sz000001']); await began;
  const second = m.getQuotes(['sz000001', 'bj920001']), third = m.getQuotes(['sh600519']); release();
  const [a, b, d] = await Promise.all([first, second, third]);
  assert.deepEqual(a.map(q => q.symbol), ['sh600519', 'sz000001']); assert.deepEqual(b.map(q => q.symbol), ['sz000001', 'bj920001']); assert.equal(d.length, 1);
  assert.equal(calls.length, 2); assert.equal(calls.flat().filter(s => s === 'sz000001').length, 1);
  const saved = JSON.parse(await readFile(join(cacheDir, 'quotes.json'), 'utf8')); assert.deepEqual(saved.items.map(q => q.symbol).sort(), ['bj920001', 'sh600519', 'sz000001']); m.close();
});
test('批量成功缺一证券立即关闭它的成交标记，旧鲜报价在逐证券退避中不会复活', async () => {
  const c = clockFixture(); let missing = false; const calls = [];
  const m = createMarketService({ cacheDir: await temp(), now: c.now, fetchImpl: async url => {
    const symbols = url.split('q=')[1].split(','); calls.push(symbols);
    return new Response(symbols.filter(s => !missing || s !== 'sz000001').map(s => liveTencent(s)).join(''));
  } });
  const first = await m.getQuotes(['sh600519', 'sz000001']); assert(first.every(q => q.tradeable)); missing = true;
  const failed = await m.quotes({ symbols: ['sh600519', 'sz000001'], refresh: true }), old = failed.items.find(q => q.symbol === 'sz000001');
  assert.equal(old.tradeable, false); assert.equal(old.cached, true); assert.equal(old.stale, true); assert.equal(old.fetchedAt, first[1].fetchedAt); assert.equal(old.time, first[1].time); assert(failed.warning.includes('没有收到有效报价'));
  c.advance(4999); const still = (await m.getQuotes(['sz000001'], { refresh: true }))[0]; assert.equal(calls.length, 2); assert.equal(still.tradeable, false);
  await m.getQuotes(['sh600519']); assert.equal(calls.length, 3); assert.deepEqual(calls.at(-1), ['sh600519']);
  c.advance(1); await m.getQuotes(['sz000001']); assert.equal(calls.length, 4);
  c.advance(9999); await m.getQuotes(['sz000001'], { refresh: true }); assert.equal(calls.length, 4);
  c.advance(1); missing = false; assert.equal((await m.getQuotes(['sz000001']))[0].tradeable, true); assert.equal(calls.length, 5); m.close();
});
test('429失败只有有限请求，手动刷新不绕五秒/十秒退避，成功恢复后重新可成交', async () => {
  const c = clockFixture(); let offline = false, calls = 0;
  const m = createMarketService({ cacheDir: await temp(), now: c.now, fetchImpl: async () => { calls++; return offline ? new Response('', { status: 429 }) : new Response(liveTencent('sh600519')); } });
  const first = (await m.getQuotes(['sh600519']))[0]; offline = true;
  const failed = (await m.getQuotes(['sh600519'], { refresh: true }))[0]; assert.equal(calls, 3); assert.equal(failed.tradeable, false); assert.equal(failed.time, first.time); assert.equal(failed.fetchedAt, first.fetchedAt);
  c.advance(4999); await m.quotes({ symbols: ['sh600519'], refresh: true }); assert.equal(calls, 3);
  c.advance(1); await m.getQuotes(['sh600519']); assert.equal(calls, 5);
  c.advance(9999); await m.getQuotes(['sh600519'], { refresh: true }); assert.equal(calls, 5);
  c.advance(1); offline = false; const recovered = (await m.getQuotes(['sh600519']))[0]; assert.equal(calls, 6); assert.equal(recovered.tradeable, true); assert.equal(recovered.cached, false); assert.equal(recovered.fetchedAt, c.stamp()); m.close();
});
test('分时五秒、日周月K三十秒过期；真实记录和源时间保持不变', async () => {
  const c = clockFixture(), calls = new Map();
  const m = createMarketService({ cacheDir: await temp(), now: c.now, fetchImpl: async url => { const kind = url.includes('/minute/') ? 'minute' : new URL(url).searchParams.get('param').split(',')[1]; calls.set(kind, (calls.get(kind) || 0) + 1); return historyFixture(url); } });
  for (const [kind, ttl] of [['minute', 5000], ['day', 30_000], ['week', 30_000], ['month', 30_000]]) {
    const first = await m.history({ symbol: 'sh600519', kind }); assert.equal(first.fetchedAt, c.stamp());
    c.advance(ttl - 1); await m.history({ symbol: 'sh600519', kind }); assert.equal(calls.get(kind), 1);
    c.advance(1); const updated = await m.history({ symbol: 'sh600519', kind }); assert.equal(calls.get(kind), 2); assert.equal(updated.fetchedAt, c.stamp()); assert.deepEqual(updated.items, first.items); assert.equal(updated.asOf, first.asOf);
    await m.history({ symbol: 'sh600519', kind, refresh: true }); assert.equal(calls.get(kind), 3);
  }
  m.close();
});
test('开市时刚保存的磁盘报价也必须联网验证，失败退避不会恢复旧会话成交资格', async () => {
  const c = clockFixture(), cacheDir = await temp(), saved = parseTencent(liveTencent('sh600519'), c.stamp())[0]; let calls = 0;
  assert.equal(saved.tradeable, true); await writeFile(join(cacheDir, 'quotes.json'), JSON.stringify({ schemaVersion: 1, fetchedAt: c.stamp(), source: saved.source, items: [saved] }));
  const m = createMarketService({ cacheDir, now: c.now, fetchImpl: async () => { calls++; return new Response('', { status: 429 }); } });
  assert.equal((await m.status()).session.open, true); const quote = (await m.getQuotes(['sh600519']))[0]; assert.equal(calls, 2);
  assert.equal(quote.tradeable, false); assert.equal(quote.cached, true); assert.equal(quote.stale, true); assert.equal(quote.time, saved.time); assert.equal(quote.fetchedAt, saved.fetchedAt); assert.equal(quote.source, saved.source);
  c.advance(1999); const again = (await m.getQuotes(['sh600519'], { refresh: true }))[0]; assert.equal(calls, 2); assert.equal(again.tradeable, false); m.close();
});
test('分时手动更新失败时仍鲜旧缓存明确标注，失败轮询退避保留原获取时间', async () => {
  const c = clockFixture(); let offline = false, calls = 0;
  const m = createMarketService({ cacheDir: await temp(), now: c.now, fetchImpl: async url => { calls++; return offline ? new Response('', { status: 503 }) : historyFixture(url); } });
  const first = await m.history({ symbol: 'sh600519', kind: 'minute' }); c.advance(1000); offline = true;
  const failed = await m.history({ symbol: 'sh600519', kind: 'minute', refresh: true }); assert.equal(calls, 3); assert.equal(failed.cached, true); assert(failed.warning.includes('503')); assert.deepEqual(failed.items, first.items); assert.equal(failed.fetchedAt, first.fetchedAt);
  c.advance(4999); const waiting = await m.history({ symbol: 'sh600519', kind: 'minute', refresh: true }); assert.equal(calls, 3); assert.equal(waiting.cached, true); assert(waiting.warning.includes('503')); assert.equal(waiting.fetchedAt, first.fetchedAt);
  c.advance(1); offline = false; const recovered = await m.history({ symbol: 'sh600519', kind: 'minute' }); assert.equal(calls, 4); assert.equal(recovered.cached, false); assert.equal(recovered.warning, undefined); assert.equal(recovered.fetchedAt, c.stamp()); m.close();
});
test('全量目录一分钟内不重复全抓，实时单股补价不污染完整目录快照', async () => {
  const c = clockFixture(), rows = [row('sh600519'), row('sz000001'), row('bj920001')], f = directoryFetch(rows);
  const m = createMarketService({ cacheDir: await temp(), now: c.now, fetchImpl: async url => url.includes('qt.gtimg') ? new Response(liveTencent('sh600519', { 3: '10.99' })) : f.fetchImpl(url) });
  const first = await m.refreshDirectory(); assert.equal(f.calls.length, 3); assert.equal(first.fetchedAt, c.stamp());
  const quote = (await m.getQuotes(['sh600519']))[0]; assert.equal(quote.price, 10.99); assert.equal((await m.list({ query: '600519' })).items[0].price, 10.01);
  c.advance(59_999); await m.refreshDirectory({ force: true }); assert.equal(f.calls.length, 3);
  c.advance(1); const second = await m.refreshDirectory(); assert.equal(f.calls.length, 6); assert.deepEqual(second.items, first.items); assert.equal(second.coverage.complete, true); assert.equal(second.fetchedAt, c.stamp()); m.close();
});
test('目录失败保留全量缓存，五秒轮询及手动刷新均遵守一分钟以上退避', async () => {
  const c = clockFixture(), rows = [row('sh600519'), row('sz000001'), row('bj920001')], f = directoryFetch(rows); let offline = false, failures = 0;
  const m = createMarketService({ cacheDir: await temp(), now: c.now, fetchImpl: async url => { if (offline) { failures++; return new Response('', { status: 503 }); } return f.fetchImpl(url); } });
  const first = await m.refreshDirectory(); c.advance(60_000); offline = true; await m.refreshDirectory(); assert.equal(failures, 2);
  for (let i = 0; i < 11; i++) { c.advance(5000); const list = await m.list(); assert.equal(list.total, 3); assert.equal(list.cached, true); assert.equal(list.fetchedAt, first.fetchedAt); assert.equal(list.asOf, null); await m.refreshDirectory({ force: true }); }
  assert.equal(failures, 2); c.advance(5000); await m.refreshDirectory(); assert.equal(failures, 4);
  c.advance(119_999); await m.refreshDirectory({ force: true }); assert.equal(failures, 4);
  c.advance(1); offline = false; const recovered = await m.refreshDirectory(); assert.equal(failures, 4); assert.deepEqual(recovered.items, first.items); assert.equal(recovered.fetchedAt, c.stamp()); assert.equal((await m.list()).cached, false); m.close();
});
test('板块三十秒过期，两个源都失败时显式缓存和退避，恢复清除失败状态', async () => {
  const c = clockFixture(); let offline = false, calls = 0;
  const m = createMarketService({ cacheDir: await temp(), now: c.now, fetchImpl: async () => { calls++; return offline ? new Response('', { status: 503 }) : sectorFixture(); } });
  const first = await m.list({ kind: 'sectors' }); assert.equal(calls, 1); assert.equal(first.cached, false); assert.equal(first.fetchedAt, c.stamp());
  c.advance(29_999); await m.list({ kind: 'sectors' }); assert.equal(calls, 1);
  c.advance(1); const updated = await m.list({ kind: 'sectors' }); assert.equal(calls, 2); assert.equal(updated.fetchedAt, c.stamp());
  offline = true; const failed = await m.list({ kind: 'sectors', refresh: true }); assert.equal(calls, 6); assert.equal(failed.cached, true); assert(failed.warning.includes('显示缓存')); assert.equal(failed.fetchedAt, updated.fetchedAt); assert.equal(failed.asOf, first.asOf);
  c.advance(29_999); await m.list({ kind: 'sectors', refresh: true }); assert.equal(calls, 6);
  c.advance(1); offline = false; const recovered = await m.list({ kind: 'sectors' }); assert.equal(calls, 7); assert.equal(recovered.cached, false); assert.equal(recovered.warning, undefined); m.close();
});
test('主板块源失败独立退避，备用行业成功仍按三十秒获取真实新快照', async () => {
  const c = clockFixture(); let primary = 0, fallback = 0;
  const m = createMarketService({ cacheDir: await temp(), now: c.now, fetchImpl: async url => {
    if (url.includes('eastmoney')) { primary++; return new Response('', { status: 503 }); }
    fallback++; return new Response('var S_Finance_bankuai_sinaindustry = {"new_bank":"new_bank,Bank,10,10.5,0.1,1,1000,10500,sz000001,2,11,0.1,PingAn"};');
  } });
  const first = await m.list({ kind: 'sectors' }); assert.equal(primary, 2); assert.equal(fallback, 1); assert.equal(first.items[0].price, null);
  c.advance(30_000); await m.list({ kind: 'sectors' }); assert.equal(primary, 4); assert.equal(fallback, 2);
  c.advance(30_000); const latest = await m.list({ kind: 'sectors' }); assert.equal(primary, 4); assert.equal(fallback, 3); assert.equal(latest.fetchedAt, c.stamp()); assert.equal(latest.cached, false); assert(latest.warning.includes('分类不同')); m.close();
});
test('新鲜板块报价按源标为非缓存且仍不可成交，不串入其他股票失败警告', async () => {
  const c = clockFixture(); let sectorCalls = 0;
  const m = createMarketService({ cacheDir: await temp(), now: c.now, fetchImpl: async url => {
    if (url.includes('qt.gtimg')) return new Response('', { status: 429 });
    sectorCalls++; return sectorFixture();
  } });
  await m.getQuotes(['sh600519']);
  const fresh = await m.quotes({ symbols: ['sector:BK1234'] }); assert.equal(sectorCalls, 1); assert.equal(fresh.cached, false); assert.equal(fresh.warning, undefined); assert.equal(fresh.fetchedAt, c.stamp()); assert(fresh.source.includes('东方财富'));
  const q = fresh.items[0]; assert.equal(q.type, 'sector'); assert.equal(q.cached, false); assert.equal(q.stale, true); assert.equal(q.tradeable, false); assert.equal(q.volume, 30000);
  const direct = await m.getQuotes(['sector:BK1234']); assert(Array.isArray(direct)); assert.equal(direct[0].cached, false); assert.equal(direct[0].tradeable, false); assert.equal(sectorCalls, 1); m.close();
});
test('板块报价更新失败保留原缓存和真实警告，手动退避后恢复新鲜状态仍不可成交', async () => {
  const c = clockFixture(); let offline = false, calls = 0;
  const m = createMarketService({ cacheDir: await temp(), now: c.now, fetchImpl: async () => { calls++; return offline ? new Response('', { status: 503 }) : sectorFixture(); } });
  const fresh = await m.quotes({ symbols: ['sector:BK1234'] }); assert.equal(calls, 1); offline = true;
  const failed = await m.quotes({ symbols: ['sector:BK1234'], refresh: true }); assert.equal(calls, 5); assert.equal(failed.cached, true); assert.equal(failed.items[0].cached, true); assert.equal(failed.items[0].tradeable, false); assert.equal(failed.items[0].stale, true);
  assert(failed.warning.includes('板块行情更新失败，显示缓存')); assert(failed.warning.includes('503')); assert.equal(failed.fetchedAt, fresh.fetchedAt); assert.equal(failed.asOf, fresh.asOf); assert.equal(failed.items[0].source, fresh.items[0].source);
  assert.equal(failed.warning, (await m.list({ kind: 'sectors' })).warning);
  c.advance(29_999); await m.quotes({ symbols: ['sector:BK1234'], refresh: true }); assert.equal(calls, 5);
  c.advance(1); offline = false; const recovered = await m.quotes({ symbols: ['sector:BK1234'] }); assert.equal(calls, 6); assert.equal(recovered.cached, false); assert.equal(recovered.items[0].cached, false); assert.equal(recovered.warning, undefined); assert.equal(recovered.items[0].tradeable, false); m.close();
});

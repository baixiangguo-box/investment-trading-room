import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createMarketService } from '../services/market-service.mjs';

if (process.env.MARKET_LIVE === '1') {
const cacheDir = await mkdtemp(join(tmpdir(), 'trading-market-live-'));
const m = createMarketService({ cacheDir });
const begun = Date.now();
await m.start();
const first = await m.list({ kind: 'stocks' });
assert(first.loading || first.total > 0);
const overviewEarly = await m.overview();
console.log(JSON.stringify({ stage: 'early', ms: Date.now() - begun, loading: overviewEarly.loading, indices: overviewEarly.indices.map(q => ({ symbol: q.symbol, time: q.time, price: q.price })), sectors: overviewEarly.sectors.length }));
const directory = await m.refreshDirectory();
assert(directory.complete);
assert.equal(new Set(directory.items.map(x => x.symbol)).size, directory.coverage.total);
assert(directory.coverage.sh > 0 && directory.coverage.sz > 0 && directory.coverage.bj > 0);
const allPages = [];
for (let page = 1; page <= Math.ceil(directory.coverage.total / 100); page++) allPages.push(...(await m.list({ page, pageSize: 100, sort: 'code', direction: 'asc' })).items);
assert.equal(allPages.length, directory.coverage.total);
assert.equal(new Set(allPages.map(x => x.symbol)).size, directory.coverage.total);
for (const market of ['sh', 'sz', 'bj']) assert.equal((await m.list({ market })).total, directory.coverage[market]);
assert((await m.list({ query: '茅台' })).items.some(x => x.symbol === 'sh600519'));
assert((await m.list({ query: '000001' })).items.some(x => x.symbol === 'sz000001'));
const qs = await m.quotes({ symbols: ['sh600519', 'sz000001', 'bj920001', 'sh000001'] });
assert.equal(qs.items.length, 4);
assert.equal(qs.items.find(q => q.symbol === 'sh000001').type, 'index');
assert.equal(qs.items.find(q => q.symbol === 'sz000001').type, 'stock');
if (!(await m.status()).session.open) assert(qs.items.every(q => !q.tradeable)); // A closed session must never be reported as a live fill.
const histories = [];
for (const symbol of ['sh600519', 'sz000001', 'bj920001', 'sh000001']) {
  for (const kind of ['minute', 'day', 'week', 'month']) {
    const h = await m.history({ symbol, kind });
    histories.push({ symbol, kind, count: h.items.length, asOf: h.asOf, warning: h.warning || null });
    assert(h.items.length > 0, `${symbol} ${kind} ${h.warning}`);
  }
}
const sector = (await m.list({ kind: 'sectors', sort: 'code' })).items[0];
const sectorDay = await m.history({ symbol: sector.symbol, kind: 'day' });
const overview = await m.overview();
assert.equal(overview.breadth.total, directory.coverage.total);
assert.equal(overview.breadth.priced, overview.breadth.up + overview.breadth.down + overview.breadth.flat);
console.log(JSON.stringify({ stage: 'complete', ms: Date.now() - begun, coverage: directory.coverage, sectors: (await m.list({ kind: 'sectors' })).total, breadth: overview.breadth, histories, sectorDay: { symbol: sector.symbol, count: sectorDay.items.length, warning: sectorDay.warning || null }, status: await m.status(), cacheDir }));
m.close();
const offline = createMarketService({ cacheDir, fetchImpl: async () => { throw new Error('Live smoke offline probe'); } });
const saved = await offline.list({ query: '600519' });
assert.equal(saved.items[0].symbol, 'sh600519');
const old = await offline.getQuotes(['sh600519']);
assert(old.length === 1 && !old[0].tradeable);
assert((await offline.history({ symbol: 'sh600519', kind: 'day' })).items.length > 0);
console.log(JSON.stringify({ stage: 'offline', directory: saved.total, retainedQuote: old[0].symbol, tradeable: old[0].tradeable, status: await offline.status() }));
offline.close();
}

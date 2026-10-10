import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, number, signed, compact, direction, mergeQuote, validatePending, capitalPayload, validateCapitalPending, isDefinitiveRejection, createDesktopApi, chartSvg, chartModel, chartPointAt, refreshInterval, securityUnit, tradeSearchQuery, acceptsAccount } from '../renderer/helpers.js';

test('Selected display text resolves to its stock code; newly edited searches retain their input', () => {
  const stock = { symbol: 'sh600000', name: '浦发银行', code: '600000' };
  assert.equal(tradeSearchQuery('浦发银行 600000', stock), '600000');
  assert.equal(tradeSearchQuery('  浦发银行 600000  ', stock), '600000');
  assert.equal(tradeSearchQuery('平安', stock), '平安');
  assert.equal(tradeSearchQuery('浦发银行 600000', null), '浦发银行 600000');
});
test('Older account responses cannot overwrite newer cash or a restored generation', () => {
  const current = { version: 10, generation: 'new' };
  assert.equal(acceptsAccount(current, { version: 9, generation: 'new' }), false);
  assert.equal(acceptsAccount(current, { version: 10, generation: 'old' }), false);
  assert.equal(acceptsAccount(current, { version: 10, generation: 'new' }), true);
  assert.equal(acceptsAccount(current, { version: 11, generation: 'restored' }), true);
  for (const invalid of [null, {}, { version: NaN }, { version: -1 }]) assert.equal(acceptsAccount(current, invalid), false);
});
test('CDR price/quantity unit is receipt units without changing ordinary stock units', () => {
  assert.equal(securityUnit('sh689009'), '份');
  for (const symbol of ['sh688001', 'sz000001', 'bj920047', '', 'sh689']) assert.equal(securityUnit(symbol), '股');
});
test('CDR volume charts preserve receipt counts and expose the correct unit', () => {
  const points = [{ time: '2026-10-09T09:30:00+08:00', price: 50, volume: 201 }];
  const model = chartModel(points, 'minute', 49, false, '份');
  assert.equal(model.volumeUnit, '份'); assert.equal(model.points[0].volume, 201);
  assert.match(chartSvg(points, 'minute', 49, false, '份'), /成交量（份）/);
});

test('Missing and nonfinite market values remain missing, while a real zero is shown', () => {
  for (const missing of [null, undefined, NaN, Infinity, '123']) {
    assert.equal(number(missing), '—'); assert.equal(signed(missing), '—'); assert.equal(compact(missing), '—');
  }
  assert.equal(number(0), '0.00'); assert.equal(signed(0, 2, '%'), '0.00%');
  assert.equal(direction(0), 'neutral'); assert.equal(direction(-0.01), 'down');
  assert.equal(direction(0.01), 'up'); assert.equal(compact(100000000), '1.00亿');
});
test('Provider names and times cannot inject HTML or SVG attributes', () => {
  assert.equal(escapeHtml('<img src=x onerror="x"> & \'y\''), '&lt;img src=x onerror=&quot;x&quot;&gt; &amp; &#39;y&#39;');
  const svg = chartSvg([{ time: '2026-10-09 <evil', price: 10 }]);
  assert.ok(!svg.includes('<script>')); assert.ok(svg.includes('&lt;'));
});
test('Only a complete persisted intent can be retried with the same order identity', () => {
  const pending = { schema: 1, intent: { id: 'id-1', generation: 'generation-1', symbol: 'sh600000', side: 'buy', qty: 100, limit: 10.01 } };
  assert.equal(validatePending(pending), true);
  for (const [key, bad] of [['id', ''], ['generation', ''], ['symbol', 'sh000001<script>'], ['side', 'cancel'], ['qty', 0], ['qty', 1.5], ['limit', null], ['limit', NaN], ['limit', '10']]) {
    assert.equal(validatePending({ ...pending, intent: { ...pending.intent, [key]: bad } }), false, key);
  }
  assert.equal(validatePending({ ...pending, schema: 2 }), false);
});
test('Transport failures are never classified as confirmed business rejection', () => {
  assert.equal(isDefinitiveRejection('MARKET_CLOSED'), true);
  assert.equal(isDefinitiveRejection('INSUFFICIENT_CASH'), true);
  for (const code of [undefined, 'IPC_ERROR', 'ETIMEDOUT', 'DATABASE_ERROR', 'INTERNAL', 'GENERIC']) assert.equal(isDefinitiveRejection(code), false);
});
test('Empty or malformed history never generates an artificial price line', () => {
  for (const points of [[], null, [{ price: null }], [{ price: Infinity }]]) {
    const chart = chartSvg(points);
    assert.ok(chart.includes('暂无可用走势数据')); assert.ok(!chart.includes('<path'));
  }
});
test('One point and flat real minute series remain finite and keep the input unchanged', () => {
  for (const points of [[{ time: '2026-10-09 15:00', price: 10 }], [{ time: '2026-10-09 09:30', price: 10 }, { time: '2026-10-09 15:00', price: 10 }]]) {
    const before = JSON.stringify(points), chart = chartSvg(points, 'minute', 10);
    assert.ok(chart.includes('真实数据点')); assert.ok(!/NaN|Infinity/.test(chart)); assert.equal(JSON.stringify(points), before);
  }
});
test('K-lines require actual OHLC and encode rise/drop independently per candle', () => {
  const points = [{ time: '2026-10-08', price: 12, open: 10, high: 13, low: 9 }, { time: '2026-10-09', price: 11, open: 12, high: 13, low: 10 }];
  const chart = chartSvg(points, 'day');
  assert.ok(chart.includes('candle up')); assert.ok(chart.includes('candle down'));
  assert.ok(!/NaN|Infinity/.test(chart));
  assert.ok(chartSvg([{ price: 10 }], 'day').includes('暂无可用走势数据'));
});
test('The renderer unwraps successful serializable IPC values and forwards the exact request', async () => {
  let delivered;
  const request = { id: 'test-id', generation: 'test-generation', symbol: 'sh600000', side: 'buy', qty: 100, limit: 10 };
  const result = { order: { id: 'test-id', status: 'pending' } };
  const api = createDesktopApi({ transportVersion: 1, submit: async payload => { delivered = payload; return { ok: true, value: result }; } });
  assert.strictEqual(await api.submit(request), result); assert.strictEqual(delivered, request);
  assert.equal(createDesktopApi(undefined), null);
});
test('Business rejection codes survive contextBridge as plain envelope fields', async () => {
  for (const code of ['MARKET_CLOSED', 'T_PLUS_ONE', 'INSUFFICIENT_CASH']) {
    const api = createDesktopApi({ transportVersion: 1, submit: async () => ({ ok: false, error: { code, message: '委托未提交' } }) });
    await assert.rejects(api.submit({}), error => error instanceof Error && error.code === code && error.message === '委托未提交' && isDefinitiveRejection(error.code));
  }
});
test('Malformed envelopes and missing error codes keep order results unconfirmed', async () => {
  for (const result of [null, {}, { ok: true }, { ok: false }, { ok: false, error: { message: '连接中断' } }]) {
    const api = createDesktopApi({ transportVersion: 1, submit: async () => result });
    await assert.rejects(api.submit({}), error => error.code === 'IPC_UNCONFIRMED' && !isDefinitiveRejection(error.code));
  }
  await assert.rejects(createDesktopApi({ transportVersion: 2, submit: async () => ({ ok: true, value: null }) }).submit({}), error => error.code === 'IPC_UNCONFIRMED');
});
test('Transport exceptions stay unknown and update subscriptions forward no untrusted payload', async () => {
  let callback, subscriptions = 0, stopped = false;
  const api = createDesktopApi({ transportVersion: 1, submit: async () => { throw new Error('IPC disconnected'); }, onUpdate: listener => { callback = listener; return () => { stopped = true; }; } });
  await assert.rejects(api.submit({}), error => !isDefinitiveRejection(error.code));
  const stop = api.onUpdate((...args) => { subscriptions++; assert.equal(args.length, 0); });
  callback({ account: { fake: true } }); assert.equal(subscriptions, 1); stop(); assert.equal(stopped, true);
});
test('Capital adjustment chooses one money field and keeps the original version baseline', () => {
  const baseline = { expectedVersion: 7, generation: 'account-generation' };
  assert.deepEqual(capitalPayload('target', 0, baseline), { ...baseline, targetAssets: 0 });
  assert.deepEqual(capitalPayload('deposit', 123.45, baseline), { ...baseline, amount: 123.45 });
  assert.deepEqual(capitalPayload('withdraw', 23.45, baseline), { ...baseline, amount: -23.45 });
  assert.deepEqual(baseline, { expectedVersion: 7, generation: 'account-generation' });
});
test('Capital drafts reject fractional cents, missing generations, and invalid targets', () => {
  const baseline = { expectedVersion: 2, generation: 'generation' };
  for (const value of [NaN, Infinity, -1, 10.001, 1e10]) assert.throws(() => capitalPayload('target', value, baseline));
  assert.throws(() => capitalPayload('deposit', 0, baseline));
  assert.throws(() => capitalPayload('withdraw', 0, baseline));
  assert.throws(() => capitalPayload('target', 100, { ...baseline, expectedVersion: 1.5 }));
  assert.throws(() => capitalPayload('target', 100, { ...baseline, generation: '' }));
  assert.equal(isDefinitiveRejection('CLOCK_REVERSED'), true);
});
test('A persistent unknown capital request cannot silently become a new-version retry', async () => {
  const request = capitalPayload('deposit', 100, { expectedVersion: 3, generation: 'generation' });
  const pending = { schema: 1, request };
  assert.equal(validateCapitalPending(JSON.parse(JSON.stringify(pending))), true);
  for (const bad of [{ ...request, targetAssets: 1000 }, { ...request, amount: 0 }, { ...request, expectedVersion: null }]) assert.equal(validateCapitalPending({ schema: 1, request: bad }), false);
  let received;
  const api = createDesktopApi({ transportVersion: 1, adjustCapital: async payload => { received = payload; return { ok: false, error: { code: 'IPC_UNCONFIRMED', message: 'unknown' } }; } });
  await assert.rejects(api.adjustCapital(request), error => !isDefinitiveRejection(error.code));
  assert.equal(received.expectedVersion, 3);
});

test('Price and volume use identical slots and include complete first and last bars', () => {
  const source=[{time:'2026-10-09 09:30',price:10,volume:1000},{time:'2026-10-09 09:31',price:11,volume:2000}];
  const before=JSON.stringify(source),model=chartModel(source,'minute',9);
  assert.equal(model.volumeUnit,'股');assert.equal(model.volumeMax,2000);
  for(const p of model.points){assert(p.x-model.volumeBarWidth/2>=model.plotLeft);assert(p.x+model.volumeBarWidth/2<=model.plotRight);assert(p.volumeY>=model.volumeTop);assert.equal(p.volumeY+p.volumeHeight,model.volumeBottom);assert.equal(chartPointAt(model,p.x),p);}
  assert.equal(chartPointAt(model,-100).index,0);assert.equal(chartPointAt(model,1e6).index,1);
  assert.equal(chartPointAt(model,NaN),null);assert.equal(chartPointAt(chartModel([]),10),null);
  assert.equal(JSON.stringify(source),before);
});
test('Missing volume is distinct from zero and is not represented by a fabricated bar', () => {
  const source=[{price:10,volume:null},{price:10,volume:0},{price:10,volume:-1}];
  const model=chartModel(source);assert.deepEqual(model.points.map(p=>p.volume),[null,0,null]);
  assert.equal(model.points[1].volumeHeight,0);assert.equal(model.points[0].volumeHeight,null);
  assert.equal((chartSvg(source).match(/class="chart-volume-bar /g)||[]).length,1);
  assert(chartSvg([{price:10}]).includes('行情源未提供成交量'));
});
test('Minute volume follows the prior price while candle volume follows its own open and close', () => {
  assert.deepEqual(chartModel([{price:10,volume:1},{price:9,volume:1},{price:9,volume:1}],'minute',8).points.map(p=>p.tone),['up','down','neutral']);
  const source=[{price:11,open:10,high:12,low:9,volume:2},{price:12,open:13,high:14,low:11,volume:3}];
  assert.deepEqual(chartModel(source,'day').points.map(p=>p.tone),['up','down']);
});
test('Average values share the price scale and missing average segments are not bridged', () => {
  const source=[{price:10,average:20},{price:11,average:null},{price:12,average:21}];
  const model=chartModel(source);assert(model.hasAverage);
  for(const p of model.points.filter(p=>p.averageY!==null)){assert(p.averageY>=model.priceTop&&p.averageY<=model.priceBottom);}
  const path=chartSvg(source).match(/<path d="([^"]*)" class="chart-average"/)[1];
  assert.equal((path.match(/M/g)||[]).length,2);assert(!path.includes('L'));
});
test('Malformed candles are omitted and a single valid candle keeps finite geometry', () => {
  const source=[{price:12,open:10,high:11,low:9},{price:12,open:10,high:13,low:11},{price:10,open:10,high:10,low:10,volume:0}];
  const model=chartModel(source,'month');assert.equal(model.points.length,1);assert.equal(model.points[0].sourceIndex,2);
  assert.equal(chartPointAt(model,model.plotLeft).index,0);
  for(const field of ['x','y','openY','highY','lowY','volumeY','volumeHeight'])assert(Number.isFinite(model.points[0][field]),field);
  assert(!/NaN|Infinity/.test(chartSvg(source,'month')));
});
test('Overview miniature charts remain price-only while full charts expose aligned volume coordinates', () => {
  const source=[{time:'2026-10-09',price:10,volume:1500}];
  const miniature=chartSvg(source,'minute',null,true);assert(!miniature.includes('chart-volume-bar'));assert(!miniature.includes('chart-hit-zone'));assert(miniature.includes('260 80'));
  const full=chartSvg(source);assert(full.includes('1000 460'));assert(full.includes('data-volume="1500"'));assert(full.includes('data-chart-count="1"'));
});


test('Automatic refresh respects open sessions, rest, hidden windows and bounded failure retries', () => {
  assert.equal(refreshInterval({sessionOpen:true}),5000);
  assert.equal(refreshInterval({sessionOpen:false}),30000);
  assert.equal(refreshInterval({sessionOpen:true,hidden:true}),60000);
  assert.equal(refreshInterval({sessionOpen:true,failures:1}),10000);
  assert.equal(refreshInterval({sessionOpen:true,failures:4}),80000);
  assert.equal(refreshInterval({sessionOpen:true,failures:99}),120000);
  assert.equal(refreshInterval({sessionOpen:false,failures:1}),30000);
  assert.equal(refreshInterval({hidden:true,failures:4}),80000);
  assert.equal(refreshInterval({sessionOpen:true,failures:NaN}),5000);
});

const realQuote = overrides => ({ symbol: 'sh600000', code: '600000', name: '浦发银行', market: 'sh', type: 'stock', board: 'main', price: 10.02, time: '2026-10-09T10:00:03+08:00', fetchedAt: '2026-10-09T02:00:04.000Z', source: '腾讯财经公开行情', bid: 10.01, ask: 10.03, bidSize: 100, askSize: 200, orderBook: { bids: [{ price: 10.01, size: 100 }], asks: [{ price: 10.03, size: 200 }] }, tradeable: true, cached: false, stale: false, ...overrides });

test('An undated directory cannot overwrite a dated direct quote or its trading safety', () => {
  const before = realQuote(), directory = { symbol: before.symbol, price: 8, time: null, fetchedAt: '2026-10-09T03:00:00.000Z', source: '新浪目录', cached: true, tradeable: false };
  const saved = JSON.stringify([before, directory]);
  assert.deepEqual(mergeQuote(before, directory), before);
  assert.equal(JSON.stringify([before, directory]), saved);
});
test('A late overview with an older source time cannot roll a newer direct quote backwards', () => {
  const before = realQuote(), late = realQuote({ price: 8, time: '2026-10-09T10:00:02+08:00', fetchedAt: '2026-10-09T02:00:10.000Z' });
  assert.deepEqual(mergeQuote(before, late), before);
  assert.deepEqual(mergeQuote(before, realQuote({ price: 8, fetchedAt: '2026-10-09T02:00:03.000Z' })), before);
});
test('An older failed or cached response disables trading without replacing retained price, time or book', () => {
  const before = realQuote();
  for (const flags of [{ cached: true }, { stale: true }, { tradeable: false }]) {
    const late = realQuote({ price: 8, time: '2026-10-09T10:00:02+08:00', fetchedAt: '2026-10-09T02:00:10.000Z', warning: '本次更新失败', ...flags });
    const result = mergeQuote(before, late);
    assert.equal(result.tradeable, false);
    for (const field of ['price', 'time', 'fetchedAt', 'source', 'bid', 'ask', 'orderBook']) assert.deepEqual(result[field], before[field], field);
    assert.equal(result.warning, late.warning);
    if (flags.cached) assert.equal(result.cached, true);
    if (flags.stale) assert.equal(result.stale, true);
  }
  assert.equal(before.tradeable, true);
  assert.equal(before.warning, undefined);
});
test('An advancing direct quote clears obsolete cache warnings and never borrows old dynamic fields', () => {
  const before = realQuote({ cached: true, stale: true, tradeable: false, warning: '上次连接失败' });
  const next = { symbol: before.symbol, price: 10.1, time: '2026-10-09T10:00:05+08:00', fetchedAt: '2026-10-09T02:00:06.000Z', tradeable: true };
  const result = mergeQuote(before, next);
  assert.equal(result.price, 10.1); assert.equal(result.name, before.name); assert.equal(result.board, before.board);
  assert.equal(result.cached, false); assert.equal(result.stale, false); assert.equal(result.tradeable, true);
  for (const field of ['warning', 'bid', 'ask', 'bidSize', 'askSize', 'orderBook', 'source']) assert.equal(Object.hasOwn(result, field), false, field);
  assert.equal(before.warning, '上次连接失败');
});
test('The same source second with a later fetch recovers while a healthy duplicate cannot undo failure', () => {
  const before = realQuote(), failed = mergeQuote(before, realQuote({ cached: true, stale: true, tradeable: false, warning: '没有收到报价' }));
  assert.equal(failed.tradeable, false);
  assert.deepEqual(mergeQuote(failed, before), failed);
  const later = realQuote({ price: 10.04, fetchedAt: '2026-10-09T02:00:05.000Z' });
  const recovered = mergeQuote(failed, later);
  assert.equal(recovered.price, 10.04); assert.equal(recovered.tradeable, true);
  assert.equal(recovered.cached, false); assert.equal(recovered.stale, false); assert.equal(Object.hasOwn(recovered, 'warning'), false);
});
test('Newer source time is primary and new explicit warning and cache state remain visible', () => {
  const before = realQuote(), next = realQuote({ price: 10.05, time: '2026-10-09T10:00:05+08:00', fetchedAt: '2026-10-09T02:00:03.000Z', cached: true, stale: true, tradeable: false, warning: '延迟报价' });
  const result = mergeQuote(before, next);
  assert.equal(result.price, next.price); assert.equal(result.time, next.time); assert.equal(result.fetchedAt, next.fetchedAt);
  assert.equal(result.cached, true); assert.equal(result.stale, true); assert.equal(result.tradeable, false); assert.equal(result.warning, next.warning);
});
test('Quote identity metadata does not leak between Shanghai and Beijing securities', () => {
  const result = mergeQuote(realQuote(), { symbol: 'bj920001', price: 12, time: '2026-10-09T10:00:05+08:00', fetchedAt: '2026-10-09T02:00:06.000Z' });
  assert.equal(result.symbol, 'bj920001'); assert.equal(result.price, 12); assert.equal(result.tradeable, false);
  for (const field of ['code', 'name', 'market', 'type', 'board', 'orderBook', 'source']) assert.equal(Object.hasOwn(result, field), false, field);
});

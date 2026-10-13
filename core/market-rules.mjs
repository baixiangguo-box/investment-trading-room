/** Rules verified against SSE/SZSE/BSE official trading rules, 2026-10-10.
 * The simulator supports continuous-auction limit orders only, not opening/
 * closing auctions, after-hours fixed-price sessions, or queue priority.
 */
const HOLIDAYS = new Set([
  '2026-01-01','2026-01-02','2026-01-03',
  '2026-02-15','2026-02-16','2026-02-17','2026-02-18','2026-02-19','2026-02-20','2026-02-21','2026-02-22','2026-02-23',
  '2026-04-04','2026-04-05','2026-04-06',
  '2026-05-01','2026-05-02','2026-05-03','2026-05-04','2026-05-05',
  '2026-06-19','2026-06-20','2026-06-21',
  '2026-09-25','2026-09-26','2026-09-27',
  '2026-10-01','2026-10-02','2026-10-03','2026-10-04','2026-10-05','2026-10-06','2026-10-07',
]);
export const RULE_SOURCES = [
  'https://www.sse.com.cn/disclosure/dealinstruc/closed/',
  'https://www.sse.com.cn/lawandrules/sselawsrules2025/fund/trading/c/c_20260424_10817739.shtml',
  'https://docs.static.szse.cn/www/lawrules/rule/trade/current/W020260424690713155663.pdf',
  'https://www.bse.cn/jygl_list/200028217.html',
  'https://edu.sse.com.cn/tib/',
];
export function fail(code, message) { const e = new Error(message); e.code = code; throw e; }
export function chinaTime(value = new Date()) {
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) fail('INVALID_TIME', '系统时间无效');
  const p = new Date(d.getTime() + 8 * 3600_000);
  return { date: p.toISOString().slice(0, 10), minutes: p.getUTCHours()*60 + p.getUTCMinutes(), weekday: p.getUTCDay(), iso: d.toISOString() };
}
export function isTradingDay(date) {
  if (!/^2026-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(`${date}T04:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === date && d.getUTCDay() !== 0 && d.getUTCDay() !== 6 && !HOLIDAYS.has(date);
}
export function getMarketSession(value = new Date()) {
  const t = chinaTime(value), known = t.date.startsWith('2026-');
  const tradingDay = known && isTradingDay(t.date);
  const open = tradingDay && ((t.minutes >= 570 && t.minutes < 690) || (t.minutes >= 780 && t.minutes < 897));
  const label = !known ? '交易日历待更新，暂停模拟成交' : !tradingDay ? '休市' : open ? '连续竞价' : t.minutes >= 897 && t.minutes < 900 ? '收盘集合竞价（本版不撮合）' : t.minutes >= 690 && t.minutes < 780 ? '午间休市' : t.minutes < 570 ? '开盘前（本版不参与集合竞价）' : '已收盘';
  return { open, label, date:t.date, tradingDay, knownCalendar:known };
}
export function stockBoard(symbol) {
  if (typeof symbol !== 'string') fail('INVALID_SYMBOL', '证券代码无效');
  // SSE 2026 section 6.1 applies the STAR rules to both stocks (688) and
  // depositary receipts (689). Their quantities remain shares/units respectively.
  if (/^sh68[89]\d{3}$/.test(symbol)) return 'star';
  if (/^sh60\d{4}$/.test(symbol)) return 'main';
  if (/^sz30\d{4}$/.test(symbol)) return 'chinext';
  if (/^sz00\d{4}$/.test(symbol)) return 'main';
  if (/^bj(?:[48]\d{5}|92\d{4})$/.test(symbol)) return 'bse';
  fail('INVALID_SYMBOL', '仅支持沪深京 A 股股票与科创板存托凭证，指数、板块和基金不能下单');
}
export function validateQuantity(board, side, qty, available = 0) {
  const max = board === 'star' ? 100_000 : board === 'chinext' ? 300_000 : 1_000_000;
  if (!Number.isSafeInteger(qty) || qty <= 0 || qty > max) fail('INVALID_QUANTITY', `单笔数量必须为 1 至 ${max.toLocaleString('zh-CN')} 的整数`);
  const min = board === 'star' ? 200 : 100;
  if (board === 'star' || board === 'bse') {
    if (qty < min && !(side === 'sell' && available < min && qty === available)) fail('INVALID_QUANTITY', `${board === 'star' ? '科创板' : '北交所'}委托数量至少 ${min}；不足的可卖余额须一次卖清`);
  } else if (qty % 100 !== 0 && !(side === 'sell' && qty % 100 === available % 100)) {
    fail('INVALID_QUANTITY', '主板、创业板买入须为 100 股整数倍；卖出须为整手或包含完整零股余额，不能拆分零股');
  }
}
export function cents(value, label = '金额', allowZero = false) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('INVALID_AMOUNT', `${label}必须是有效数字`);
  const s = String(value);
  if (!/^\d+(?:\.\d{1,2})?$/.test(s)) fail('INVALID_AMOUNT', `${label}最多保留两位小数`);
  const [a,b=''] = s.split('.');
  const n = Number(BigInt(a)*100n + BigInt(b.padEnd(2,'0')));
  if (!Number.isSafeInteger(n) || n < (allowZero ? 0 : 1)) fail('INVALID_AMOUNT', `${label}超出支持范围`);
  return n;
}
export function money(n) { return n / 100; }
function roundedRate(gross, n, d) { return Number((BigInt(gross)*BigInt(n) + BigInt(d)/2n)/BigInt(d)); }
/** Explicit simulator tariff, not an assertion of a user's brokerage contract:
 * commission 0.03%, minimum CNY5 per order; transfer 0.001% both ways;
 * stamp 0.05% on sales. Cumulative gross per order, integer half-up cents.
 */
export function cumulativeFees(gross, side) {
  if (!Number.isSafeInteger(gross) || gross < 0) fail('INVALID_AMOUNT','成交金额超出支持范围');
  const commission = gross ? Math.max(500, roundedRate(gross,3,10_000)) : 0;
  const transfer = roundedRate(gross,1,100_000);
  const stamp = side === 'sell' ? roundedRate(gross,5,10_000) : 0;
  return {commission, transfer, stamp, total:commission+transfer+stamp};
}
export function feesForIncrement(previousGross, gross, side) {
  const a=cumulativeFees(previousGross,side), b=cumulativeFees(previousGross+gross,side);
  return { commission:b.commission-a.commission, transfer:b.transfer-a.transfer, stamp:b.stamp-a.stamp, total:b.total-a.total };
}
export function priceCage(board, side, baselineCents) {
  const rate=board==='bse'?5:2;
  const percent=Number((BigInt(baselineCents)*BigInt(side==='buy'?100+rate:100-rate)+50n)/100n);
  // SSE 2026 section 6.8 keeps STAR's 2% bound; other boards also
  // allow ten ticks. Never permit a nonpositive price after rounding.
  const edge=board==='star'?percent:side==='buy'?Math.max(percent,baselineCents+10):Math.min(percent,baselineCents-10);
  return Math.max(1,edge);
}

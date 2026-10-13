export const finite = value => typeof value === 'number' && Number.isFinite(value);
export function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
export function number(value, decimals = 2) { return finite(value) ? value.toLocaleString('zh-CN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : '—'; }
export function signed(value, decimals = 2, suffix = '') { return finite(value) ? `${value > 0 ? '+' : ''}${number(value, decimals)}${suffix}` : '—'; }
export function compact(value, suffix = '') { if (!finite(value)) return '—'; const absolute = Math.abs(value); return absolute >= 1e8 ? `${number(value / 1e8, 2)}亿${suffix}` : absolute >= 1e4 ? `${number(value / 1e4, 2)}万${suffix}` : `${number(value, 0)}${suffix}`; }
export function direction(value) { return finite(value) && value !== 0 ? (value > 0 ? 'up' : 'down') : 'neutral'; }
export function timeLabel(value) { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false }); }
export function shortTime(value) { if (!value) return ''; const match = String(value).match(/(?:T|\s)(\d{2}:\d{2})(?::\d{2})?/); return match ? match[1] : String(value).slice(-5); }
export function marketLabel(market) { return ({ sh: '沪市', sz: '深市', bj: '北交所' })[market] || '市场'; }
export function orderStatus(status) { return ({ pending: '待成交', partial: '部分成交', filled: '已成交', cancelled: '已撤单', expired: '已过期', rejected: '已拒绝' })[status] || status || '—'; }
export function securityUnit(symbol) { return /^sh689\d{3}$/.test(String(symbol || '')) ? '份' : '股'; }
export function tradeSearchQuery(value, selected) {
  const query = String(value ?? '').trim(), symbol = String(selected?.symbol || '');
  const code = /^(sh|sz|bj)\d{6}$/.test(symbol) ? symbol.slice(2) : '';
  const display = `${selected?.name || ''} ${selected?.code || symbol}`.trim();
  return code && query === display ? code : query;
}
export function acceptsAccount(current, incoming) {
  if (!incoming || typeof incoming !== 'object' || !Number.isSafeInteger(incoming.version) || incoming.version < 0) return false;
  if (!current || !Number.isSafeInteger(current.version)) return true;
  return incoming.version > current.version || incoming.version === current.version && incoming.generation === current.generation;
}
export function mergeQuote(previous, item) {
  const timestamp = value => typeof value === 'string' && value ? Date.parse(value) : NaN;
  const sameSymbol = previous?.symbol === item?.symbol;
  const before = sameSymbol ? timestamp(previous?.time) : NaN, after = timestamp(item?.time);
  if (Number.isFinite(before)) {
    // Directory snapshots have no source date and cannot replace a direct quote.
    if (!Number.isFinite(after)) return { ...previous };
    const beforeFetch = timestamp(previous.fetchedAt), afterFetch = timestamp(item.fetchedAt);
    const fetchAdvanced = Number.isFinite(afterFetch) && (!Number.isFinite(beforeFetch) || afterFetch > beforeFetch);
    const fetchRegressed = Number.isFinite(beforeFetch) && (!Number.isFinite(afterFetch) || afterFetch < beforeFetch);
    const regressed = after < before || after === before && fetchRegressed;
    const unchanged = after === before && !fetchAdvanced;
    if (regressed || unchanged && (previous.cached === true || previous.stale === true || previous.tradeable === false)) {
      const retained = { ...previous };
      // A late failed/cache response may downgrade safety, never the retained price.
      if (item.cached === true || item.stale === true || item.tradeable === false) {
        retained.tradeable = false;
        if (item.cached === true) retained.cached = true;
        if (item.stale === true) retained.stale = true;
        if (typeof item.warning === 'string' && item.warning) retained.warning = item.warning;
      }
      return retained;
    }
  }
  // Keep identity metadata only. Dynamic fields, books, source and warnings belong
  // to this snapshot, so missing fields must not silently retain older prices.
  const identity = {};
  if (sameSymbol) for (const key of ['symbol', 'code', 'name', 'market', 'type', 'board']) {
    if (previous[key] !== undefined) identity[key] = previous[key];
  }
  return { ...identity, ...item, cached: item.cached === true, stale: item.stale === true, tradeable: item.tradeable === true };
}
export function createOrderId() { return globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `order-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
export function validatePending(value) { if (!value || typeof value !== 'object' || value.schema !== 1 || !value.intent || typeof value.intent !== 'object') return false; const p = value.intent; return typeof p.id === 'string' && p.id.length > 0 && typeof p.generation === 'string' && p.generation.length > 0 && /^(sh|sz|bj)\d{6}$/.test(p.symbol) && ['buy', 'sell'].includes(p.side) && Number.isInteger(p.qty) && p.qty > 0 && finite(p.limit) && p.limit > 0; }
const definiteCodes = new Set(['INVALID_ORDER', 'INVALID_ORDER_ID', 'INVALID_SYMBOL', 'INVALID_SIDE', 'INVALID_QUANTITY', 'INVALID_AMOUNT', 'GENERATION_REQUIRED', 'GENERATION_CHANGED', 'VERSION_CONFLICT', 'ACCOUNT_NOT_INITIALIZED', 'ORDER_CANCELLED', 'ORDER_INTENT_CONFLICT', 'MARKET_CLOSED', 'T_PLUS_ONE', 'INSUFFICIENT_CASH', 'QUOTE_UNAVAILABLE', 'NOT_TRADEABLE', 'QUOTE_STALE', 'PRICE_OUT_OF_RANGE', 'PRICE_CAGE', 'STATE_CAPACITY', 'CLOCK_REVERSED']);
export const isDefinitiveRejection = code => definiteCodes.has(code);
const desktopMethods = ['bootstrap', 'marketOverview', 'marketList', 'quotes', 'history', 'account', 'setup', 'watch', 'adjustCapital', 'submit', 'cancel', 'order', 'diagnostics', 'backup', 'listBackups', 'previewBackup', 'previewRestore', 'restore', 'reset', 'status'];
export function capitalPayload(mode, value, baseline) {
  if (!['target', 'deposit', 'withdraw'].includes(mode) || !finite(value) || value < 0 || value > 1e9 || Math.abs(value * 100 - Math.round(value * 100)) > 0.00001 || (mode !== 'target' && value === 0)) throw new Error('请输入有效金额，最多保留两位小数。');
  if (!Number.isSafeInteger(baseline?.expectedVersion) || baseline.expectedVersion < 0 || typeof baseline.generation !== 'string' || !baseline.generation) throw new Error('账户状态不可用，请重新打开资金设置。');
  return { expectedVersion: baseline.expectedVersion, generation: baseline.generation, ...(mode === 'target' ? { targetAssets: value } : { amount: mode === 'withdraw' ? -value : value }) };
}
export function validateCapitalPending(value) {
  const p = value?.request;
  if (value?.schema !== 1 || !p || typeof p !== 'object' || !Number.isSafeInteger(p.expectedVersion) || p.expectedVersion < 0 || typeof p.generation !== 'string' || !p.generation) return false;
  const target = Object.hasOwn(p, 'targetAssets'), amount = Object.hasOwn(p, 'amount');
  if (target === amount) return false;
  const money = target ? p.targetAssets : p.amount;
  return finite(money) && Math.abs(money) <= 1e9 && Math.abs(money * 100 - Math.round(money * 100)) < 0.00001 && (target ? money >= 0 : money !== 0);
}
export function createDesktopApi(transport) {
  if (!transport) return null;
  const api = {};
  for (const name of desktopMethods) api[name] = async payload => {
    if (transport.transportVersion !== 1 || typeof transport[name] !== 'function') {
      const error = new Error('桌面通信接口不可用，请重新打开软件并核对操作记录。');
      error.code = 'IPC_UNCONFIRMED'; throw error;
    }
    // The preload returns plain serializable envelopes. Construct the Error in
    // the renderer: Electron contextBridge does not preserve custom Error.code.
    const envelope = await transport[name](payload);
    if (envelope?.ok === true && Object.hasOwn(envelope, 'value')) return envelope.value;
    if (envelope?.ok === false && envelope.error && typeof envelope.error.message === 'string') {
      const error = new Error(envelope.error.message);
      error.code = typeof envelope.error.code === 'string' && envelope.error.code ? envelope.error.code : 'IPC_UNCONFIRMED';
      throw error;
    }
    const error = new Error('本地服务返回了无法识别的结果，请先核对操作记录。');
    error.code = 'IPC_UNCONFIRMED'; throw error;
  };
  api.onUpdate = callback => {
    if (typeof callback !== 'function' || typeof transport.onUpdate !== 'function') return () => {};
    const unsubscribe = transport.onUpdate(() => callback());
    return typeof unsubscribe === 'function' ? unsubscribe : () => {};
  };
  return Object.freeze(api);
}
const positiveChartValue = value => finite(value) && value > 0;
export function chartModel(points, kind = 'minute', previous = null, miniature = false, volumeUnit = '股') {
  kind = ['minute', 'day', 'week', 'month'].includes(kind) ? kind : 'minute';
  const model = {
    kind, miniature: Boolean(miniature), width: miniature ? 260 : 1000, height: miniature ? 80 : 460,
    plotLeft: miniature ? 2 : 60, plotRight: miniature ? 258 : 976,
    priceTop: miniature ? 6 : 18, priceBottom: miniature ? 77 : 304,
    volumeTop: miniature ? null : 344, volumeBottom: miniature ? null : 422,
    volumeUnit: volumeUnit === '份' ? '份' : '股', volumeBasis: kind === 'minute' ? '时段成交量' : '周期成交量',
    priceMin: null, priceMax: null, volumeMax: null, hasVolume: false, hasAverage: false,
    xStep: 0, candleWidth: 0, volumeBarWidth: 0, points: [],
  };
  const valid = (Array.isArray(points) ? points : []).flatMap((point, sourceIndex) => {
    if (!point || !positiveChartValue(point.price)) return [];
    if (kind !== 'minute' && (![point.open, point.high, point.low].every(positiveChartValue) || point.high < Math.max(point.open, point.price) || point.low > Math.min(point.open, point.price) || point.high < point.low)) return [];
    return [{ ...point, sourceIndex, time: String(point.time ?? ''),
      open: positiveChartValue(point.open) ? point.open : null,
      high: positiveChartValue(point.high) ? point.high : null,
      low: positiveChartValue(point.low) ? point.low : null,
      average: positiveChartValue(point.average) ? point.average : null,
      volume: finite(point.volume) && point.volume >= 0 ? point.volume : null,
    }];
  });
  if (!valid.length) return model;
  let minimum = Infinity, maximum = -Infinity;
  for (const point of valid) {
    minimum = Math.min(minimum, kind === 'minute' ? point.price : point.low);
    maximum = Math.max(maximum, kind === 'minute' ? point.price : point.high);
    if (kind === 'minute' && !miniature && positiveChartValue(point.average)) {
      minimum = Math.min(minimum, point.average); maximum = Math.max(maximum, point.average);
      model.hasAverage = true;
    }
  }
  if (positiveChartValue(previous) && !miniature) { minimum = Math.min(minimum, previous); maximum = Math.max(maximum, previous); }
  const spread = maximum - minimum || Math.max(maximum * 0.01, 0.01);
  model.priceMin = Math.max(0, minimum - spread * 0.06);
  model.priceMax = Math.min(Number.MAX_VALUE, maximum + spread * 0.06);
  const range = model.priceMax - model.priceMin;
  const priceY = value => model.priceTop + (model.priceMax - value) / range * (model.priceBottom - model.priceTop);
  const volumes = valid.filter(point => point.volume !== null).map(point => point.volume);
  model.hasVolume = !miniature && volumes.length > 0;
  model.volumeMax = model.hasVolume ? volumes.reduce((maximum, value) => Math.max(maximum, value), 0) : null;
  model.xStep = (model.plotRight - model.plotLeft) / valid.length;
  model.candleWidth = Math.min(12, model.xStep * 0.65);
  model.volumeBarWidth = Math.min(14, model.xStep * 0.72);
  model.points = valid.map((point, index) => {
    const reference = index > 0 ? valid[index - 1].price : positiveChartValue(previous) ? previous : point.price;
    const tone = direction(point.price - (kind === 'minute' ? reference : point.open));
    const volumeHeight = !miniature && point.volume !== null ? (model.volumeMax > 0 ? point.volume / model.volumeMax * (model.volumeBottom - model.volumeTop) : 0) : null;
    return { ...point, index, x: model.plotLeft + (index + 0.5) * model.xStep, y: priceY(point.price),
      openY: point.open !== null ? priceY(point.open) : null,
      highY: point.high !== null ? priceY(point.high) : null,
      lowY: point.low !== null ? priceY(point.low) : null,
      averageY: kind === 'minute' && !miniature && point.average !== null ? priceY(point.average) : null,
      tone, volumeHeight, volumeY: volumeHeight !== null ? model.volumeBottom - volumeHeight : null,
    };
  });
  return model;
}
export function chartPointAt(model, svgX) {
  if (!model?.points?.length || !finite(svgX) || !finite(model.xStep) || model.xStep <= 0) return null;
  const index = Math.max(0, Math.min(model.points.length - 1, Math.round((svgX - model.plotLeft) / model.xStep - 0.5)));
  return model.points[index];
}
export function chartSvg(points, kind = 'minute', previous = null, miniature = false, volumeUnit = '股') {
  const model = chartModel(points, kind, previous, miniature, volumeUnit);
  if (!model.points.length) return `<div class="chart-empty${miniature ? ' mini-empty' : ''}">${miniature ? '暂无走势' : '暂无可用走势数据'}</div>`;
  const { plotLeft, plotRight, priceTop, priceBottom, volumeTop, volumeBottom } = model;
  let drawing = '';
  if (!miniature) for (let index = 0; index <= 4; index++) {
    const ratio = index / 4, yy = priceTop + (priceBottom - priceTop) * ratio;
    const value = model.priceMax - (model.priceMax - model.priceMin) * ratio;
    drawing += `<line x1="${plotLeft}" y1="${yy}" x2="${plotRight}" y2="${yy}" class="chart-grid"/><text x="${plotLeft - 10}" y="${yy + 4}" text-anchor="end" class="chart-label">${number(value)}</text>`;
  }
  if (model.kind === 'minute') {
    const tone = direction(model.points.at(-1).price - (positiveChartValue(previous) ? previous : model.points[0].price));
    const line = model.points.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(3)},${point.y.toFixed(3)}`).join(' ');
    drawing += `<path d="${line} L${model.points.at(-1).x},${priceBottom} L${model.points[0].x},${priceBottom} Z" class="chart-fill ${tone}"/><path d="${line}" class="chart-line ${tone}"/>`;
    if (model.points.length === 1) drawing += `<circle cx="${model.points[0].x}" cy="${model.points[0].y}" r="${miniature ? 1.5 : 3}" class="chart-price-point ${tone}" fill="currentColor"/>`;
    if (model.hasAverage) {
      let connected = false, average = '';
      for (const point of model.points) {
        if (point.averageY === null) { connected = false; continue; }
        average += `${connected ? ' L' : ' M'}${point.x.toFixed(3)},${point.averageY.toFixed(3)}`; connected = true;
      }
      drawing += `<path d="${average.trim()}" class="chart-average"/>`;
    }
  } else drawing += model.points.map(point => `<g class="candle ${point.tone}" data-chart-index="${point.index}" data-chart-x="${point.x}"><line x1="${point.x}" y1="${point.highY}" x2="${point.x}" y2="${point.lowY}"/><rect x="${point.x - model.candleWidth / 2}" y="${Math.min(point.openY, point.y)}" width="${model.candleWidth}" height="${Math.max(0.75, Math.abs(point.openY - point.y))}"/></g>`).join('');
  if (!miniature) {
    drawing += `<g class="chart-volume" aria-label="${model.volumeBasis}，单位${model.volumeUnit}"><text x="${plotLeft}" y="${volumeTop - 12}" class="chart-volume-label">成交量（${model.volumeUnit}） · ${model.volumeBasis}</text>`;
    for (let index = 0; index <= 2; index++) {
      const ratio = index / 2, yy = volumeTop + (volumeBottom - volumeTop) * ratio;
      drawing += `<line x1="${plotLeft}" y1="${yy}" x2="${plotRight}" y2="${yy}" class="chart-volume-grid"/>`;
      if (model.hasVolume) drawing += `<text x="${plotLeft - 10}" y="${yy + 4}" text-anchor="end" class="chart-volume-label">${compact(model.volumeMax * (1 - ratio))}</text>`;
    }
    if (!model.hasVolume) drawing += `<text x="${(plotLeft + plotRight) / 2}" y="${(volumeTop + volumeBottom) / 2 + 4}" text-anchor="middle" class="chart-volume-label">行情源未提供成交量</text>`;
    drawing += model.points.filter(point => point.volume !== null).map(point => `<rect class="chart-volume-bar ${point.tone}" x="${point.x - model.volumeBarWidth / 2}" y="${point.volumeY}" width="${model.volumeBarWidth}" height="${point.volumeHeight}" data-chart-index="${point.index}" data-chart-x="${point.x}" data-volume="${point.volume}"/>`).join('');
    drawing += '</g>';
    const labels = [...new Set([0, Math.floor((model.points.length - 1) / 2), model.points.length - 1])];
    drawing += labels.map(index => `<text x="${model.points[index].x}" y="${model.height - 10}" text-anchor="middle" class="chart-label">${escapeHtml(model.kind === 'minute' ? shortTime(model.points[index].time) : model.points[index].time.slice(0, 10))}</text>`).join('');
    drawing += model.points.map(point => `<rect class="chart-hit-zone" x="${plotLeft + point.index * model.xStep}" y="${priceTop}" width="${model.xStep}" height="${volumeBottom - priceTop}" fill="transparent" data-chart-index="${point.index}" data-chart-x="${point.x}"/>`).join('');
  }
  return `<svg class="price-chart${miniature ? ' miniature' : ''}" viewBox="0 0 ${model.width} ${model.height}" role="img" aria-label="${model.kind === 'minute' ? '分时' : 'K线'}${miniature ? '' : '与成交量'}图，共${model.points.length}个真实数据点" data-chart-kind="${model.kind}" data-plot-left="${plotLeft}" data-plot-right="${plotRight}" data-price-top="${priceTop}" data-price-bottom="${priceBottom}" data-volume-top="${volumeTop ?? ''}" data-volume-bottom="${volumeBottom ?? ''}" data-chart-count="${model.points.length}">${drawing}</svg>`;
}
// Delays are measured after a completed refresh. Rest/hidden pages reduce traffic.
export function refreshInterval({ hidden = false, sessionOpen = false, failures = 0 } = {}) {
  const base = hidden ? 60000 : sessionOpen ? 5000 : 30000;
  const count = Number.isFinite(failures) ? Math.max(0, Math.floor(failures)) : 0;
  return Math.max(base, count ? Math.min(120000, 5000 * 2 ** Math.min(count, 5)) : 0);
}

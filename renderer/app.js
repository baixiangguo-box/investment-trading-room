import { finite, escapeHtml as e, number as n, signed, compact, direction, timeLabel, shortTime, marketLabel, orderStatus, securityUnit, tradeSearchQuery, acceptsAccount, createOrderId, validatePending, capitalPayload, validateCapitalPending, isDefinitiveRejection, createDesktopApi, chartSvg, chartModel, chartPointAt, refreshInterval, mergeQuote } from './helpers.js';

import { createPolling } from './polling.js';
import { reconcileContent } from './rendering.js';

const api = createDesktopApi(window.trading);
const content = document.querySelector('#content');
const dialog = document.querySelector('#app-dialog');
const PENDING_KEY = 'investment-trading-room.pending.v1';
const CAPITAL_KEY = 'investment-trading-room.capital-pending.v1';
const listDefaults = kind => ({ kind, market: 'all', query: '', page: 1, pageSize: 20, sort: kind === 'sectors' ? 'percent' : 'amount', direction: 'desc' });
const state = {
  page: 'market', previousPage: 'market', booted: false, bootError: '', app: {}, account: null,
  status: null, overview: null, overviewError: '', marketItems: null, marketError: '', marketBusy: false,
  homeList: { ...listDefaults('stocks'), pageSize: 10 }, list: listDefaults('stocks'),
  listStates: new Map(), listItems: null, listError: '', listBusy: false, listRequest: 0, previousScroll: 0, homeScroll: 0,
  quotes: new Map(), histories: new Map(), detail: null, detailKind: 'minute', detailHistory: null,
  detailError: '', detailBusy: false, detailRequest: 0, marketRequest: 0, searchRequest: 0,
  searchResults: [], searchBusy: false, searchContext: 'watch', watchQuoteState: null, tradeRequest: 0, tradeTab: 'buy', selected: null,
  form: { symbolSearch: '', qty: '100', limit: '' }, drafts: { watchSearch: '', marketSearch: '' },
  pending: null, pendingError: '', storageError: '', busy: false, tradeError: '', preview: null, resetPreview: null,
  capitalPreview: null, capitalPending: null, capitalStorageError: '',
  backups: { items: [], page: 1, loading: false, error: '', previewId: null },
  refresh: { running: false, lastCheck: null, failures: 0, warning: '' },
};
let toastTimer, searchTimer, marketTimer, stopUpdates, miniInFlight, lastPollFinished = 0, lastMiniRefresh = 0;
let detailChartModel = null, chartHoverIndex = -1, chartHover = null;
let composingInput = null, compositionContext = '', renderedContext = '', deferredRender = false;
let dialogRequest = 0;
const searchKeys = new Set(['market-search', 'watch-search', 'trade-search']);
const pageContext = () => `${state.page}|${state.page === 'trade' ? state.tradeTab : state.page === 'market-list' ? state.list.kind : ''}`;
const activeSearch = input => input?.isConnected && content.contains(input) && searchKeys.has(input.dataset.input)
  && ({ 'market-search': 'market-list', 'watch-search': 'watch', 'trade-search': 'trade' })[input.dataset.input] === state.page;

const emptyAccount = { initialized: false, watchlist: [], holdings: [], orders: [], trades: [] };
const acct = () => state.account || emptyAccount;
const disabled = condition => condition ? ' disabled' : '';
const priced = (value, decimals = 2) => `<span class="${direction(value)}">${signed(value, decimals)}</span>`;
const button = (label, action, data = '', cls = '', isDisabled = false) => `<button type="button" class="button ${cls}" data-action="${action}" ${data}${disabled(isDisabled || state.busy)}>${label}</button>`;
const stockButton = item => `<button class="stock-link" data-action="detail" data-symbol="${e(item.symbol)}">${e(item.name || item.symbol)}<span class="stock-code">${e(item.code || String(item.symbol || '').replace(/^(sh|sz|bj)/, ''))} · ${e(marketLabel(item.market || String(item.symbol || '').slice(0, 2)))}</span></button>`;
const detailRow = item => item.symbol && !item.identityOnly ? ` class="clickable" data-action="detail" data-symbol="${e(item.symbol)}" tabindex="0" aria-label="查看${e(item.name || item.symbol)}详情"` : '';
function watchToggle(item) {
  if (item.type !== 'stock' || !/^(sh|sz|bj)\d{6}$/.test(item.symbol || '')) return '—';
  const watched = acct().watchlist.includes(item.symbol), label = `${watched ? '取消' : '加入'}自选 ${item.name || item.symbol}`;
  return `<button class="watch-toggle ${watched ? 'watched' : ''}" data-action="${watched ? 'watch-remove' : 'watch-add'}" data-symbol="${e(item.symbol)}" aria-label="${e(label)}" title="${e(label)}"${disabled(state.busy || !acct().initialized)}>${watched ? '−' : '+'}</button>`;
}
const dataWarning = object => object?.warning || object?.cached ? `<div class="data-warning">${e(object.warning || '当前显示已保存的行情，价格可能已过期。')} ${object.asOf ? `行情时间：${e(timeLabel(object.asOf))}` : ''}</div>` : '';
const tableEmpty = (columns, text) => `<tr class="loading-row"><td colspan="${columns}">${e(text)}</td></tr>`;
const quantity = (value, symbol) => finite(value) ? `${n(value, 0)} ${securityUnit(symbol)}` : '—';
const securityPrice = (value, symbol, decimals = 2) => finite(value) ? `${n(value, decimals)} <span class="small muted">元/${securityUnit(symbol)}</span>` : '—';
const starSecurity = quote => quote?.board === 'star' || securityUnit(quote?.symbol) === '份';

function toast(message, error = false) {
  const node = document.querySelector('#toast');
  node.textContent = message;
  node.className = `toast visible${error ? ' error' : ''}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { node.className = 'toast'; }, 5000);
}
function errorMessage(error) { return error?.message || '操作未完成，请重试。'; }
function storeQuotes(items = []) {
  for (const item of items) if (item?.symbol) state.quotes.set(item.symbol, mergeQuote(state.quotes.get(item.symbol), item));
}
function liveItem(item) {
  const quote = state.quotes.get(item.symbol);
  return quote?.time ? { ...item, ...quote } : item;
}
function quoteResult(result, symbols) {
  storeQuotes(result.items);
  const received = new Set((result.items || []).map(item => item.symbol));
  const missing = symbols.filter(symbol => !received.has(symbol));
  for (const symbol of missing) {
    const old = state.quotes.get(symbol);
    if (old) state.quotes.set(symbol, { ...old, tradeable: false, stale: true, warning: '本次未取得有效报价，保留上次数据。' });
  }
  return symbols.length === 0 || (result.items || []).some(item => !item.cached && received.has(item.symbol));
}
function rememberAccount(account) { if (!acceptsAccount(state.account, account)) return false; state.account = account; return true; }
function formSnapshot() {
  const focused = document.activeElement;
  if (!focused || !content.contains(focused)) return null;
  if (focused.matches('[data-interactive-chart]')) return { chart: true };
  if (!focused.id) return null;
  return { id: focused.id, start: focused.selectionStart, end: focused.selectionEnd, direction: focused.selectionDirection };
}
function restoreFocus(saved) {
  if (!saved) return;
  const element = saved.chart ? content.querySelector('[data-interactive-chart]') : document.getElementById(saved.id);
  if (!element || !content.contains(element)) return;
  if (document.activeElement !== element) element.focus({ preventScroll: true });
  if (typeof saved.start === 'number' && ['text', 'search'].includes(element.type)
    && (element.selectionStart !== saved.start || element.selectionEnd !== saved.end || element.selectionDirection !== saved.direction)) {
    element.setSelectionRange(saved.start, saved.end, saved.direction);
  }
}
function render() {
  const context = pageContext();
  if (composingInput && compositionContext === context && composingInput.isConnected && content.contains(composingInput)) {
    deferredRender = true; renderStatus(); renderNotice(); return;
  }
  if (composingInput) stopSearchEditing();
  const hoverToRestore = state.page === 'detail' && chartHover?.symbol === state.detail?.symbol && chartHover?.kind === state.detailKind ? chartHover : null;
  chartHover = null;
  detailChartModel = null; chartHoverIndex = -1;
  const focus = formSnapshot();
  for (const node of document.querySelectorAll('.main-nav button')) {
    const navigationPage = state.page === 'detail' ? state.previousPage : state.page;
    node.classList.toggle('active', node.dataset.page === (navigationPage === 'market-list' ? 'market' : navigationPage));
    node.setAttribute('aria-current', node.classList.contains('active') ? 'page' : 'false');
  }
  renderStatus(); renderNotice();
  if (!api) {
    content.innerHTML = `<div class="empty-state"><h1>请从桌面客户端打开</h1><p>此界面通过本地桌面程序读取行情与账户。<br>直接打开 HTML 文件无法连接交易服务。</p></div>`;
    return;
  }
  if (state.bootError) {
    content.innerHTML = `<div class="empty-state"><h1>暂时无法打开本地账户</h1><p>${e(state.bootError)}</p>${button('重新连接', 'boot', '', 'primary')}</div>`;
    return;
  }
  if (!state.booted) return;
  const html = ({ market: marketPage, 'market-list': marketListPage, watch: watchPage, detail: detailPage, trade: tradePage, account: accountPage })[state.page]();
  if (renderedContext !== context) { content.replaceChildren(); renderedContext = context; }
  reconcileContent(content, html); deferredRender = false;
  restoreFocus(focus);
  if (hoverToRestore && detailChartModel) {
    const point = detailChartModel.points.find(point => point.time === hoverToRestore.time);
    const wrapper = content.querySelector('[data-interactive-chart]');
    if (point && wrapper) showChartPoint(wrapper, point, hoverToRestore.clientY);
  }
}
function renderStatus() {
  const node = document.querySelector('#connection-status');
  const status = state.status;
  if (!status) { node.textContent = '正在读取行情状态'; node.className = 'connection-status'; return; }
  const interval = refreshInterval({ hidden: document.hidden, sessionOpen: status.session?.open, failures: state.refresh.failures });
  const auto = state.refresh.running ? '正在更新' : state.refresh.failures ? `${interval / 1000}秒后重试` : `${interval / 1000}秒自动刷新`;
  node.textContent = `${status.online ? '● 行情已连接' : '● 暂无网络行情'} · ${status.session?.label || '市场状态未知'} · ${auto}`;
  node.dataset.refreshInterval = String(interval);
  node.dataset.refreshFailures = String(state.refresh.failures);
  node.dataset.refreshRunning = String(state.refresh.running);
  node.className = `connection-status ${status.online ? 'online' : 'offline'}`;
  node.title = [state.refresh.warning, state.refresh.lastCheck ? `最近检查：${timeLabel(state.refresh.lastCheck)}` : '', status.warning, status.coverage, status.lastSuccess ? `最近更新：${timeLabel(status.lastSuccess)}` : ''].filter(Boolean).join('\n');
  document.querySelector('#footer-status').textContent = state.overview ? `${state.overview.source || '行情来源'} · ${state.overview.asOf ? timeLabel(state.overview.asOf) : state.overview.fetchedAt ? `目录获取 ${timeLabel(state.overview.fetchedAt)}` : '未提供报价时间'}${state.overview.cached ? ' · 缓存' : ''}` : '行情由网络获取，交易仅记入本机模拟账户';
}
function renderNotice() {
  const notices = [];
  if (state.status?.online === false && state.page !== 'market') notices.push(`<div class="notice"><strong>行情暂未连接</strong><span>${e(state.status.warning || '当前行情可能来自缓存，本地账户和记录仍可查看。新委托须等待有效行情。')}</span></div>`);
  if (state.storageError) notices.push(`<div class="notice error">${e(state.storageError)}</div>`);
  if (state.capitalStorageError) notices.push(`<div class="notice error">${e(state.capitalStorageError)}</div>`);
  if (state.capitalPending) notices.push(`<div class="notice"><strong>上次虚拟资金调整尚待核对</strong><span>请查看账户和资金流水；核对前不会再次调整资金。</span><div class="notice-actions">${button('查看资金流水', 'capital-records', '', 'small-button')}${button('已核对结果', 'capital-confirm', '', 'small-button')}</div></div>`);
  if (state.pending) {
    const p = state.pending.intent;
    const stale = state.account && p.generation !== state.account.generation;
    notices.push(`<div class="notice"><div class="pending-description"><strong>${stale ? '旧账户委托待核对' : '有一笔委托尚未确认结果'}</strong> · ${e(state.quotes.get(p.symbol)?.name || p.symbol)} ${p.side === 'buy' ? '买入' : '卖出'} ${quantity(p.qty, p.symbol)}，限价 ${securityPrice(p.limit, p.symbol)}。<br><span class="small">${e(stale ? '账户已恢复或重置，此委托不能在新账户重试。' : state.pendingError || '查询结果或以同一编号重试，避免重复下单。')}</span></div><div class="notice-actions">${stale ? button('结束旧账户委托提示', 'archive-pending', '', 'small-button') : `${button('查询结果', 'query-pending', '', 'small-button')}${button('同编号重试', 'retry-pending', '', 'small-button')}${button('撤销此委托', 'cancel-pending', '', 'small-button')}`}</div></div>`);
  }
  document.querySelector('#global-notice').innerHTML = notices.join('');
}
function pageTitle(title, subtitle = '', actions = '') { return `<div class="page-title"><h1>${title}</h1>${subtitle ? `<span class="subtitle">${e(subtitle)}</span>` : ''}<div class="page-actions">${actions}</div></div>`; }
function miniChart(item) { const points = state.histories.get(`${item.symbol}|minute`); return chartSvg(points, 'minute', item.previous, true); }

function marketPage() {
  const overview = state.overview;
  const indices = (overview?.indices || []).map(liveItem);
  const breadth = overview?.breadth;
  const total = finite(breadth?.total) ? breadth.total : (breadth?.up || 0) + (breadth?.down || 0) + (breadth?.flat || 0);
  const upWidth = total > 0 ? (breadth.up || 0) / total * 100 : 0;
  const downWidth = total > 0 ? (breadth.down || 0) / total * 100 : 0;
  const sectors = (overview?.sectors || []).slice(0, 6), hot = (overview?.hot || []).slice(0, 5).map(liveItem);
  return `${pageTitle('市场行情', '沪深京市场总览', `${button('全部指数 ›', 'list-kind', 'data-kind="indices"', 'small-button')}${button('刷新行情', 'refresh-market', '', 'small-button', state.marketBusy)}`)}
    ${state.overviewError ? `<div class="data-warning">${e(state.overviewError)} ${button('重新获取', 'refresh-market', '', 'small-button')}</div>` : dataWarning(overview)}
    <div class="index-grid">${indices.length ? indices.slice(0, 4).map(item => `<button class="index-card" data-action="detail" data-symbol="${e(item.symbol)}"><div class="index-heading">${e(item.name)}<span>${e(item.code)}</span></div><div class="index-price ${direction(item.percent)}">${n(item.price)}</div><div class="index-change ${direction(item.percent)}"><span>${signed(item.change)}</span><span>${signed(item.percent, 2, '%')}</span></div><div class="index-chart">${miniChart(item)}</div></button>`).join('') : `<div class="section-card section-loading">${state.overviewError ? '暂无可用指数行情' : '正在获取主要指数…'}</div>`}</div>
    <section class="section-card breadth-card" aria-label="市场涨跌概况">${[
      ['市场成交额', compact(breadth?.amount), 'amount'], ['上涨', n(breadth?.up, 0), 'up'], ['下跌', n(breadth?.down, 0), 'down'], ['平盘', n(breadth?.flat, 0), ''], ['涨停', finite(breadth?.limitUp) ? n(breadth.limitUp, 0) : '<span class="small muted" title="行情源未提供实际涨停数量">源未提供</span>', 'up'], ['跌停', finite(breadth?.limitDown) ? n(breadth.limitDown, 0) : '<span class="small muted" title="行情源未提供实际跌停数量">源未提供</span>', 'down']
    ].map(([label, value, cls]) => `<div class="breadth-number ${cls}"><div class="label">${label}</div><strong>${value}</strong></div>`).join('')}<div class="breadth-bar"><svg viewBox="0 0 100 3" role="img" aria-label="市场上涨${n(upWidth, 1)}%，下跌${n(downWidth, 1)}%"><rect width="100" height="3" rx="1.5" fill="#c5cfc9"/><rect width="${upWidth}" height="3" fill="#ef294a"/><rect x="${100 - downWidth}" width="${downWidth}" height="3" fill="#087d5a"/></svg><div class="breadth-caption"><span class="up">上涨 ${total ? `${n(upWidth, 1)}%` : '—'}</span><span class="down">下跌 ${total ? `${n(downWidth, 1)}%` : '—'}</span></div></div></section>
    <div class="market-middle"><section class="section-card"><div class="section-header"><h2>板块行情 <span class="small muted">按涨幅</span></h2><button class="text-button" data-action="list-kind" data-kind="sectors">全部板块 ›</button></div><div class="sector-grid">${sectors.length ? sectors.map(item => `<button class="sector-card ${item.percent > 0 ? 'sector-up' : ''}" data-action="detail" data-symbol="${e(item.symbol)}"><strong>${e(item.name)}</strong><span class="sector-percent ${direction(item.percent)}">${signed(item.percent, 2, '%')}</span><span class="sector-chart">${miniChart(item)}</span></button>`).join('') : '<div class="section-loading">暂无板块行情</div>'}</div></section>
    <section class="section-card"><div class="section-header"><h2>热门股票 <span class="small muted">按成交额</span></h2><button class="text-button" data-action="list-kind" data-kind="hot">更多 ›</button></div><div class="table-wrap"><table class="hot-table"><thead><tr><th>#</th><th class="align-left">名称</th><th>最新价</th><th>涨跌幅</th><th>自选</th></tr></thead><tbody>${hot.length ? hot.map((item, i) => `<tr${detailRow(item)}><td class="muted">${i + 1}</td><td class="align-left">${stockButton(item)}</td><td class="${direction(item.percent)}">${n(item.price)}</td><td class="${direction(item.percent)}">${signed(item.percent, 2, '%')}</td><td>${watchToggle(item)}</td></tr>`).join('') : tableEmpty(5, '暂无热门股票行情')}</tbody></table></div></section></div>
    ${marketTable(false)}
    <p class="data-source detail-last-note">${e(overview?.coverage || state.status?.coverage || '覆盖沪市、深市、北交所。缺失的行情字段以 — 显示。')} 热门列表按成交额排序。</p>`;
}
function marketListPage() {
  const heading = ({ stocks: '全部A股', indices: '市场指数', sectors: '全部板块', hot: '热门股票' })[state.list.kind];
  return `<div class="detail-heading"><button class="back-button" data-action="list-back" aria-label="返回行情首页">‹</button><div><h1>${heading}</h1><p class="detail-type">${state.list.kind === 'hot' ? '按真实成交额排列；点击股票进入详细行情' : '独立行情列表 · 点击名称或整行查看详情'}</p></div><div class="page-actions">${button('刷新列表', 'reload-list', '', 'small-button', state.listBusy)}</div></div>${marketTable(true)}`;
}
function marketTable(full = false) {
  const list = full ? state.list : state.homeList, result = full ? state.listItems : state.marketItems;
  const busy = full ? state.listBusy : state.marketBusy, listError = full ? state.listError : state.marketError;
  const heading = ({ stocks: '全部A股', indices: '市场指数', sectors: '全部板块', hot: '热门股票' })[list.kind];
  const hasWatch = ['stocks', 'hot'].includes(list.kind), columns = hasWatch ? 9 : 8;
  const headers = [['代码', 'code'], ['名称', null], ['最新价', null], ['涨跌幅', 'percent'], ['涨跌额', null], ['成交量（股）', null], ['成交额', 'amount'], ['换手率', 'turnover'], ...(hasWatch ? [['自选', null]] : [])];
  return `<section class="section-card"><div class="table-toolbar">${full ? `<div class="tabs" aria-label="行情种类">${[['stocks','A股'],['indices','指数'],['sectors','板块'],['hot','热门']].map(([kind,label]) => `<button data-action="list-kind" data-kind="${kind}" class="${list.kind === kind ? 'active' : ''}">${label}</button>`).join('')}</div>${list.kind === 'stocks' ? `<div class="tabs" aria-label="交易市场">${[['all','全部'],['sh','沪市'],['sz','深市'],['bj','北交所']].map(([market,label]) => `<button data-action="list-market" data-market="${market}" class="${list.market === market ? 'active' : ''}">${label}</button>`).join('')}</div>` : ''}<div class="search-field"><label class="visually-hidden" for="market-search">搜索名称或代码</label><input id="market-search" type="search" data-input="market-search" value="${e(state.drafts.marketSearch)}" placeholder="搜索名称 / 代码" autocomplete="off"></div>` : `<h2>${heading}</h2><span class="muted small">按成交额显示前10只 · ${n(result?.total, 0)}只</span><button class="text-button table-more" data-action="list-kind" data-kind="stocks">查看全部A股 ›</button>`}</div>
    ${result?.warning || result?.quoteWarning || result?.cached ? `<p class="table-title-caption">${e([result.warning || (result.cached ? '当前为缓存目录' : ''), result.quoteWarning].filter(Boolean).join(' '))}</p>` : ''}
    ${listError ? `<div class="table-error"><span>${e(listError)}</span>${button('重试', full ? 'reload-list' : 'refresh-market', '', 'small-button')}</div>` : ''}
    <div class="table-wrap"><table><thead><tr>${headers.map(([name, sort], i) => `<th class="${i === 1 ? 'align-left' : ''}">${full && sort ? `<button class="sort-button" data-action="sort" data-sort="${sort}">${name}${list.sort === sort ? (list.direction === 'asc' ? ' ↑' : ' ↓') : ' ↕'}</button>` : name}</th>`).join('')}</tr></thead><tbody>${busy && !result ? tableEmpty(columns, '正在获取行情…') : result?.items?.length ? result.items.map(liveItem).map(item => `<tr${detailRow(item)}><td>${e(item.code || item.symbol)}</td><td class="align-left">${stockButton(item)}</td><td class="${direction(item.percent)}">${n(item.price)}</td><td class="${direction(item.percent)}">${signed(item.percent, 2, '%')}</td><td class="${direction(item.change)}">${signed(item.change)}</td><td>${compact(item.volume)}</td><td>${compact(item.amount)}</td><td>${finite(item.turnover) ? `${n(item.turnover)}%` : '—'}</td>${hasWatch ? `<td>${watchToggle(item)}</td>` : ''}</tr>`).join('') : tableEmpty(columns, listError ? '暂时无法取得行情' : '没有找到符合条件的行情')}</tbody></table></div>
    <div class="table-meta"><span>${busy ? '正在更新…' : `${n(result?.total, 0)} 条行情`} ${result?.asOf || result?.fetchedAt ? `· ${result.asOf ? '目录行情时间' : '目录获取时间'} ${e(timeLabel(result.asOf || result.fetchedAt))}` : ''}${result?.quoteAsOf ? ` · 报价时间 ${e(timeLabel(result.quoteAsOf))} · 排序按目录快照` : ''}</span>${full ? `<div class="pagination">${button('上一页', 'list-page', `data-page="${Math.max(1, list.page - 1)}"`, 'small-button', list.page <= 1 || busy)}<span>第 ${list.page} / ${Math.max(1, Math.ceil((result?.total || 0) / list.pageSize))} 页</span>${button('下一页', 'list-page', `data-page="${list.page + 1}"`, 'small-button', !result || list.page * list.pageSize >= result.total || busy)}</div>` : '<span>点击股票查看详情 · + / − 切换自选</span>'}</div></section>`;
}

function searchResultHtml(context) {
  if (state.searchContext !== context) return '';
  if (state.searchBusy) return '<div class="progress-line">正在搜索…</div>';
  if (!state.searchResults.length) return '';
  return `<div class="section-card search-results">${state.searchResults.map(item => `<div class="search-result"><div><span class="name">${e(item.name)}</span><span class="stock-code">${e(item.code)} · ${e(marketLabel(item.market))}</span></div><span class="${direction(item.percent)}">${n(item.price)}</span>${context === 'watch' ? button(acct().watchlist.includes(item.symbol) ? '已添加' : '加入自选', 'watch-add', `data-symbol="${e(item.symbol)}"`, 'small-button', acct().watchlist.includes(item.symbol)) : button('选择', 'select-trade', `data-symbol="${e(item.symbol)}"`, 'small-button')}</div>`).join('')}</div>`;
}
function watchPage() {
  const watch = acct().watchlist || [];
  const rows = watch.map(symbol => state.quotes.get(symbol) || { symbol, code: symbol.slice(2), name: symbol, market: symbol.slice(0, 2) });
  return `${pageTitle('我的自选', `${watch.length} 只股票`, button('刷新', 'refresh-watch', '', 'small-button'))}
    <div class="watch-search"><label class="visually-hidden" for="watch-search">搜索并加入自选</label><input id="watch-search" type="search" data-input="watch-search" value="${e(state.drafts.watchSearch)}" placeholder="输入名称或代码，添加自选" autocomplete="off">${button('搜索', 'search-watch', '', 'primary')}</div>
    ${searchResultHtml('watch')}${dataWarning(state.watchQuoteState)}
    <section class="section-card"><div class="table-wrap"><table><thead><tr><th class="align-left">股票</th><th>最新价</th><th>涨跌幅</th><th>涨跌额</th><th>成交额</th><th>换手率</th><th>操作</th></tr></thead><tbody>${rows.length ? rows.map(item => `<tr${detailRow(item)}><td>${stockButton(item)}</td><td class="${direction(item.percent)}">${n(item.price)}</td><td class="${direction(item.percent)}">${signed(item.percent, 2, '%')}</td><td class="${direction(item.change)}">${signed(item.change)}</td><td>${compact(item.amount)}</td><td>${finite(item.turnover) ? `${n(item.turnover)}%` : '—'}</td><td><div class="table-action-group">${button('买入', 'trade-stock', `data-symbol="${e(item.symbol)}" data-side="buy"`, 'small-button')}${button('移除', 'watch-remove', `data-symbol="${e(item.symbol)}"`, 'small-button')}</div></td></tr>`).join('') : tableEmpty(7, '自选列表为空。搜索股票或在行情详情中加入自选。')}</tbody></table></div></section><p class="detail-last-note">点击股票名称查看分时、K线和盘口。</p>`;
}
function detailPage() {
  const selected = state.detail, quote = state.quotes.get(selected?.symbol) || selected || {};
  const stock = quote.type === 'stock' || /^(sh|sz|bj)\d{6}$/.test(quote.symbol || '') && selected?.type === 'stock';
  const fallbackIndustry = quote.type === 'sector' && String(quote.symbol || '').startsWith('sector:sina:'), unit = securityUnit(quote.symbol);
  const watched = acct().watchlist.includes(quote.symbol);
  const metric = (label, value, cls = '') => `<div><span class="metric-label">${label}</span><span class="metric-value ${cls}">${value}</span></div>`;
  const leader = quote.leader?.symbol ? `<button class="stock-link" data-action="detail" data-symbol="${e(quote.leader.symbol)}">${e(quote.leader.name || quote.leader.symbol)}</button><span class="stock-code ${direction(quote.leader.percent)}">${signed(quote.leader.percent, 2, '%')}</span>` : '—';
  const metrics = fallbackIndustry ? [
    metric('行业平均股价（元）', n(quote.averagePrice)), metric('成分股数量', finite(quote.members) ? `${n(quote.members, 0)}只` : '—'), metric('领先股', leader), metric('行业成交量', compact(quote.volume)), metric('行业成交额', compact(quote.amount)),
  ] : [metric('今开', n(quote.open)), metric('昨收', n(quote.previous)), metric('最高', n(quote.high), direction(finite(quote.high) && finite(quote.previous) ? quote.high - quote.previous : null)), metric('最低', n(quote.low), direction(finite(quote.low) && finite(quote.previous) ? quote.low - quote.previous : null)), metric(`成交量（${unit}）`, compact(quote.volume)), metric('成交额（元）', compact(quote.amount)), ...(stock ? [metric('换手率', finite(quote.turnover) ? `${n(quote.turnover)}%` : '—'), metric('涨停价', n(quote.upper), 'up'), metric('跌停价', n(quote.lower), 'down')] : [])];
  const model = chartModel(state.detailHistory?.items, state.detailKind, quote.previous, false, unit);
  const chartLabel = state.detailBusy ? '正在获取走势' : state.detailKind === 'minute' ? `${stock ? `价格（元/${unit}）` : '指数点位'} / ${model.hasAverage ? '均价' : '均价未提供'} / ${model.hasVolume ? `成交量（${unit}）` : '成交量未提供'}` : `红涨绿跌 · ${model.hasVolume ? `成交量（${unit}）` : '成交量未提供'} · 数据以行情来源为准`;
  return `<div class="detail-heading"><button class="back-button" data-action="detail-back" aria-label="返回上一页">‹</button><div><h1>${e(quote.name || quote.symbol)}<span class="detail-code">${e(quote.code || '')}</span></h1><div class="detail-type">${e(quote.type === 'sector' ? '板块' : quote.type === 'index' ? '指数' : marketLabel(quote.market))}</div></div><div class="page-actions">${stock ? `${button(watched ? '移出自选' : '＋ 加入自选', watched ? 'watch-remove' : 'watch-add', `data-symbol="${e(quote.symbol)}"`)}${button('买入', 'trade-stock', `data-symbol="${e(quote.symbol)}" data-side="buy"`, 'buy')}${button('卖出', 'trade-stock', `data-symbol="${e(quote.symbol)}" data-side="sell"`, 'sell')}` : ''}${button('刷新', 'refresh-detail', '', 'small-button', state.detailBusy)}</div></div>
    ${quote.warning ? `<div class="data-warning">${e(quote.warning)}</div>` : ''}
    <section class="section-card detail-overview"><div><div class="detail-price ${direction(quote.percent)}">${n(quote.price)}</div><div class="detail-change ${direction(quote.percent)}">${fallbackIndustry ? '<span class="small">行业涨跌幅</span>' : `<span>${signed(quote.change)}</span>`}<span>${signed(quote.percent, 2, '%')}</span></div><p class="detail-last-note">${fallbackIndustry ? '备用行业汇总，无板块指数点位。平均股价单独列示。' : `${e(timeLabel(quote.time))} ${quote.tradeable === false ? '· 当前报价不可用于成交' : ''}`}</p></div><div class="quote-grid">${metrics.join('')}</div></section>
    <div class="detail-body${stock ? '' : ' no-book'}"><section class="section-card chart-card"><div class="chart-toolbar"><div class="tabs" aria-label="走势图周期">${[['minute','分时'],['day','日K'],['week','周K'],['month','月K']].map(([kind,label]) => `<button data-action="chart-kind" data-kind="${kind}" class="${kind === state.detailKind ? 'active' : ''}">${label}</button>`).join('')}</div><span class="small muted">${chartLabel}</span></div>${state.detailBusy ? '<div class="chart-empty"><span class="spinner"></span></div>' : detailChartHtml(quote)}${state.detailError ? `<p class="no-quote">${e(state.detailError)}</p>` : ''}<div class="chart-meta"><span>${e(state.detailHistory?.source || quote.source || '')}${state.detailHistory?.asOf ? ` · 图表数据时间 ${e(timeLabel(state.detailHistory.asOf))}` : ''}</span><span>${e(state.detailHistory?.warning || '')}</span></div></section>${stock ? `<section class="section-card book-card"><h2>五档盘口</h2>${bookHtml(quote)}<p class="order-price-note">盘口价格：元/${unit}；数量：${unit}。缺失档位不补造。</p></section>` : ''}</div>`;
}
function detailChartHtml(quote) {
  const points = state.detailHistory?.items, kind = state.detailKind;
  detailChartModel = chartModel(points, kind, quote.previous, false, securityUnit(quote.symbol));
  const svg = chartSvg(points, kind, quote.previous, false, securityUnit(quote.symbol));
  if (!detailChartModel.points.length) return svg;
  const overlay = '<g class="chart-crosshair" visibility="hidden" aria-hidden="true"><line class="chart-crosshair-line"/><circle class="chart-hover-dot" r="4"/><circle class="chart-hover-average" r="4"/></g>';
  const note = kind === 'minute' ? '量柱为本时段成交量；9:30可能包含开盘成交，缺失时段量不补造。' : '量柱为对应日 / 周 / 月的成交量，颜色按该根K线开收价区分。';
  return `<div class="detail-chart" data-interactive-chart tabindex="0" role="group" aria-label="${e(quote.name || '')}走势图，移动鼠标或按左右方向键查看对应数据">${svg.replace('</svg>', `${overlay}</svg>`)}<div class="chart-tooltip" role="status" aria-live="off" hidden></div></div><p class="chart-help">${note} 成交量单位：${detailChartModel.volumeUnit}。移动鼠标查看；左右方向键切换，Esc关闭提示。</p>`;
}
function hideChartHover(wrapper = content.querySelector('[data-interactive-chart]')) {
  chartHover = null;
  chartHoverIndex = -1;
  wrapper?.querySelector('.chart-crosshair')?.setAttribute('visibility', 'hidden');
  const tooltip = wrapper?.querySelector('.chart-tooltip'); if (tooltip) tooltip.hidden = true;
}
function showChartPoint(wrapper, point, clientY) {
  const svg = wrapper.querySelector('svg'), model = detailChartModel;
  if (!svg || !model || !point) return hideChartHover(wrapper);
  chartHoverIndex = point.index;
  chartHover = { symbol: state.detail?.symbol, kind: model.kind, time: point.time, clientY: finite(clientY) ? clientY : null };
  const crosshair = svg.querySelector('.chart-crosshair'), line = crosshair.querySelector('line');
  line.setAttribute('x1', point.x); line.setAttribute('x2', point.x);
  line.setAttribute('y1', model.priceTop); line.setAttribute('y2', model.volumeBottom);
  const dot = crosshair.querySelector('.chart-hover-dot'); dot.setAttribute('cx', point.x); dot.setAttribute('cy', point.y);
  const average = crosshair.querySelector('.chart-hover-average');
  average.setAttribute('visibility', finite(point.averageY) ? 'visible' : 'hidden');
  if (finite(point.averageY)) { average.setAttribute('cx', point.x); average.setAttribute('cy', point.averageY); }
  crosshair.setAttribute('visibility','visible');
  const tooltip = wrapper.querySelector('.chart-tooltip');
  const row = (label, value) => `<div><span>${label}</span><strong>${value}</strong></div>`;
  const when = model.kind === 'minute' ? `${String(point.time || '').slice(0, 10)} ${shortTime(point.time)}` : String(point.time || '').slice(0, 10);
  const stock = state.detail?.type === 'stock', price = value => stock ? securityPrice(value, state.detail.symbol) : n(value);
  tooltip.innerHTML = `<b>${e(when || '时间未提供')}</b>${model.kind === 'minute' ? row(stock ? '价格' : '点位', price(point.price)) + (model.hasAverage ? row('均价', price(point.average)) : '') : row('开盘', price(point.open)) + row('最高', price(point.high)) + row('最低', price(point.low)) + row('收盘', price(point.price))}${row(model.kind === 'minute' ? '本时段成交量' : '周期成交量', finite(point.volume) ? `${n(point.volume, 0)} ${model.volumeUnit}` : '—')}`;
  tooltip.hidden = false;
  const rect = wrapper.getBoundingClientRect(), screenPoint = svg.createSVGPoint();
  screenPoint.x = point.x; screenPoint.y = point.y;
  const matrix = svg.getScreenCTM(); if (!matrix) return hideChartHover(wrapper);
  const positioned = screenPoint.matrixTransform(matrix), tipWidth = tooltip.offsetWidth, tipHeight = tooltip.offsetHeight;
  const x = positioned.x - rect.left, y = (finite(clientY) ? clientY : positioned.y) - rect.top;
  tooltip.style.left = `${Math.max(4, Math.min(rect.width - tipWidth - 4, x + tipWidth + 18 < rect.width ? x + 14 : x - tipWidth - 14))}px`;
  tooltip.style.top = `${Math.max(4, Math.min(rect.height - tipHeight - 4, y + 12))}px`;
}
content.addEventListener('pointermove', event => {
  const wrapper = event.target.closest('[data-interactive-chart]');
  if (!wrapper || !detailChartModel) return;
  const svg = wrapper.querySelector('svg'), matrix = svg?.getScreenCTM();
  if (!matrix) return hideChartHover(wrapper);
  const position = svg.createSVGPoint(); position.x = event.clientX; position.y = event.clientY;
  const local = position.matrixTransform(matrix.inverse()), model = detailChartModel;
  if (local.x < model.plotLeft || local.x > model.plotRight || local.y < model.priceTop || local.y > model.volumeBottom) return hideChartHover(wrapper);
  showChartPoint(wrapper, chartPointAt(model, local.x), event.clientY);
});
content.addEventListener('pointerout', event => {
  const wrapper = event.target.closest('[data-interactive-chart]');
  if (wrapper && !wrapper.contains(event.relatedTarget)) hideChartHover(wrapper);
});
content.addEventListener('focusout', event => {
  const wrapper = event.target.closest('[data-interactive-chart]');
  if (wrapper && !wrapper.contains(event.relatedTarget)) hideChartHover(wrapper);
});
content.addEventListener('keydown', event => {
  const wrapper = event.target.closest('[data-interactive-chart]'), model = detailChartModel;
  if (!wrapper || !model || !model.points.length) return;
  if (event.key === 'Escape') { event.preventDefault(); return hideChartHover(wrapper); }
  if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
  event.preventDefault();
  const last = model.points.length - 1;
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? last : chartHoverIndex < 0 ? last : Math.max(0, Math.min(last, chartHoverIndex + (event.key === 'ArrowLeft' ? -1 : 1)));
  showChartPoint(wrapper, model.points[index]);
});
function bookHtml(quote, split = false) {
  const asks = (quote?.orderBook?.asks || []).slice(0, 5).sort((a,b) => b.level - a.level);
  const bids = (quote?.orderBook?.bids || []).slice(0, 5).sort((a,b) => a.level - b.level);
  const rows = (items, side) => items.length ? items.map(item => `<div class="book-row"><span class="muted">${side === 'sell' ? '卖' : '买'}${e(item.level)}</span><span class="${direction(finite(item.price) && finite(quote.previous) ? item.price - quote.previous : null)}" title="元/${securityUnit(quote.symbol)}">${n(item.price)}</span><span>${compact(item.size, securityUnit(quote.symbol))}</span></div>`).join('') : '<div class="empty-book">暂无盘口数据</div>';
  return split ? `<div class="book-columns"><div>${rows(bids, 'buy')}</div><div>${rows(asks, 'sell')}</div></div>` : `${rows(asks, 'sell')}<div class="book-separator"></div>${rows(bids, 'buy')}`;
}

function tradePage() {
  const tab = state.tradeTab;
  return `${pageTitle('模拟交易', '本机账户 · 限价委托', button('刷新账户', 'refresh-account', '', 'small-button'))}
    <div class="trade-nav" aria-label="交易功能">${[['buy','买入'],['sell','卖出'],['orders','委托 / 撤单'],['holdings','持仓'],['trades','成交记录']].map(([key,label]) => `<button data-action="trade-tab" data-tab="${key}" class="${key === tab ? 'active' : ''} ${key}">${label}</button>`).join('')}</div>
    ${!acct().initialized ? `<div class="section-card empty-state"><h2>先创建模拟账户</h2><p>设置昵称与初始模拟本金后即可交易。</p>${button('创建账户', 'setup', '', 'primary')}</div>` : ['buy','sell'].includes(tab) ? tradeFormPage() : tab === 'orders' ? ordersTable() : tab === 'holdings' ? holdingsTable() : tradesTable()}`;
}
function tradeFormPage() {
  const side = state.tradeTab, quote = state.selected ? state.quotes.get(state.selected.symbol) || state.selected : null;
  const holding = acct().holdings.find(item => item.symbol === quote?.symbol);
  const unit = securityUnit(quote?.symbol);
  const quantityPresets = starSecurity(quote) ? [200,500,1000,2000] : [100,200,500,1000];
  const quantityRule = starSecurity(quote) ? `科创板申报至少200${unit}，以上可按1${unit}递增；不足200${unit}可卖余额须一次卖清。` : quote?.board === 'bse' ? '北交所申报至少100股，以上可按1股递增；不足100股可卖余额须一次卖清。' : '主板、创业板买入须为100股整数倍；卖出碎股须随可卖余额一次卖清。';
  const qty = Number(state.form.qty), limit = Number(state.form.limit);
  const valid = quote?.type === 'stock' && Number.isInteger(qty) && qty > 0 && finite(limit) && limit > 0;
  return `<div class="trade-layout"><section class="section-card order-form"><h2>${side === 'buy' ? '买入股票' : '卖出股票'}</h2><p class="trade-help">限价委托按有效对手盘模拟成交；未成交部分保留委托，可在“委托 / 撤单”中取消。</p><form id="order-form" data-form="order"><div class="form-row"><label for="trade-search">股票名称 / 代码</label><input id="trade-search" type="search" data-input="trade-search" value="${e(state.form.symbolSearch)}" placeholder="搜索沪深京股票" autocomplete="off" required>${searchResultHtml('trade')}</div>
    ${quote ? `<div class="form-money-summary"><span>${e(quote.name)} <span class="muted">${e(quote.code)}</span></span><strong class="${direction(quote.percent)}">${n(quote.price)}</strong></div>` : ''}
    <div class="form-grid"><div class="form-row"><label for="order-limit">委托价格（元/${unit}）</label><input id="order-limit" type="number" data-input="order-limit" value="${e(state.form.limit)}" min="0.01" step="0.01" required><p class="help">${quote ? `涨停 ${n(quote.upper)} / 跌停 ${n(quote.lower)}` : '选择股票后读取有效报价'}</p></div><div class="form-row"><label for="order-qty">委托数量（${unit}）</label><input id="order-qty" type="number" data-input="order-qty" value="${e(state.form.qty)}" min="1" step="1" required><p class="help">${side === 'sell' ? `可卖 ${n(holding?.available || 0, 0)} ${unit}` : '数量须符合对应板块申报规则'}</p></div></div>
    <div class="quantity-presets">${quantityPresets.map(value => `<button type="button" data-action="qty-preset" data-qty="${value}">${value}${unit}</button>`).join('')}${side === 'sell' && holding ? `<button type="button" data-action="qty-preset" data-qty="${holding.available}"${disabled(holding.available <= 0)}>全部可卖</button>` : ''}</div><p class="small muted quantity-help">${quantityRule}</p>
    <div class="form-money-summary"><span>${side === 'buy' ? '可用资金' : '持有数量'}</span><strong>${side === 'buy' ? `${n(acct().cash)}元` : `${n(holding?.qty || 0, 0)}${unit}`}</strong></div><div class="form-money-summary"><span>委托金额（不含费用）</span><strong id="order-gross">${valid ? `${n(qty * limit)}元` : '—'}</strong></div>
    ${state.tradeError ? `<div class="form-error">${e(state.tradeError)}</div>` : ''}${state.pending ? '<div class="form-error">先核对尚未确认的委托结果，再提交新委托。</div>' : ''}
    <button type="submit" class="button submit ${side === 'buy' ? 'buy' : 'sell'}"${disabled(state.busy || !!state.pending || !valid || !!state.storageError)}>${state.busy ? '正在提交…' : side === 'buy' ? '提交买入委托' : '提交卖出委托'}</button>
    <p class="order-price-note">模拟费用：佣金万分之三，每笔委托累计最低 5 元；过户费十万分之一；卖出印花税万分之五。按整数分四舍五入。股票实行 T+1，可卖数量不包含当日买入及已冻结股票。断网、报价过期或休市时不能发起新的模拟成交。</p></form></section>
    <section class="section-card trade-quote">${quote ? `<h2>${e(quote.name)} <span class="detail-code">${e(quote.code)}</span></h2><div class="trade-price"><strong class="${direction(quote.percent)}">${n(quote.price)}</strong><span class="${direction(quote.percent)}">${signed(quote.percent, 2, '%')}</span></div><div class="quote-grid"><div><span class="metric-label">今开</span><span class="metric-value">${n(quote.open)}</span></div><div><span class="metric-label">最高</span><span class="metric-value">${n(quote.high)}</span></div><div><span class="metric-label">最低</span><span class="metric-value">${n(quote.low)}</span></div><div><span class="metric-label">成交量</span><span class="metric-value">${compact(quote.volume)}</span></div><div><span class="metric-label">换手率</span><span class="metric-value">${finite(quote.turnover) ? `${n(quote.turnover)}%` : '—'}</span></div><div><span class="metric-label">昨收</span><span class="metric-value">${n(quote.previous)}</span></div></div><div class="book-card"><h2>五档盘口</h2>${bookHtml(quote, true)}</div><p class="status-text">报价时间：${e(timeLabel(quote.time))}<br>${e(quote.source || '')} ${quote.tradeable === false ? '· 报价当前不可成交' : ''}</p><p class="detail-last-note"><button class="text-button" data-action="detail" data-symbol="${e(quote.symbol)}">查看完整行情 ›</button></p>` : '<div class="empty-state"><h2>选择要交易的股票</h2><p>搜索名称或代码，或从行情、自选、持仓进入交易。</p></div>'}</section></div>`;
}
function ordersTable() {
  const orders = acct().orders || [];
  return `<section class="section-card cancel-list"><div class="section-header"><h2>委托记录</h2><span class="muted small">${orders.length} 笔</span></div><div class="table-wrap"><table><thead><tr><th>时间</th><th class="align-left">股票</th><th>方向</th><th>价格</th><th>委托数量</th><th>已成交</th><th>未成交</th><th>状态</th><th>操作</th></tr></thead><tbody>${orders.length ? orders.map(order => `<tr><td>${e(timeLabel(order.time))}</td><td class="align-left">${order.identityOnly ? '待核对委托' : stockButton(order)}</td><td class="${order.identityOnly ? 'neutral' : order.side === 'buy' ? 'up' : 'down'}">${order.identityOnly ? '—' : order.side === 'buy' ? '买入' : '卖出'}</td><td>${securityPrice(order.limit, order.symbol)}</td><td>${order.identityOnly ? '—' : quantity(order.qty, order.symbol)}</td><td>${quantity(order.filledQty, order.symbol)}</td><td>${quantity(order.remainingQty, order.symbol)}</td><td><span class="status-badge ${e(order.status)}" title="${e(order.message || '')}">${e(orderStatus(order.status))}</span></td><td>${['pending','partial'].includes(order.status) ? button('撤单', 'cancel-order', `data-id="${e(order.id)}" data-generation="${e(order.generation)}"`, 'small-button') : '—'}</td></tr>`).join('') : tableEmpty(9, '暂无委托记录')}</tbody></table></div></section>`;
}
function holdingsTable() {
  const holdings = acct().holdings || [];
  return `<section class="section-card"><div class="section-header"><h2>当前持仓</h2><span class="muted small">${holdings.length} 只股票</span></div>${valuationWarning()}<div class="table-wrap"><table><thead><tr><th>股票</th><th>持有 / 可卖</th><th>冻结数量</th><th>成本均价</th><th>最新价</th><th>市值</th><th>持仓盈亏</th><th>盈亏比例</th><th>操作</th></tr></thead><tbody>${holdings.length ? holdings.map(holding => `<tr><td>${stockButton(holding)}</td><td>${quantity(holding.qty, holding.symbol)} / ${quantity(holding.available, holding.symbol)}</td><td>${quantity(holding.frozen, holding.symbol)}</td><td>${securityPrice(holding.avgCost, holding.symbol, 3)}</td><td>${securityPrice(holding.price, holding.symbol)}</td><td>${n(holding.marketValue)}</td><td class="${direction(holding.profit)}">${signed(holding.profit)}</td><td class="${direction(holding.profitPercent)}">${signed(holding.profitPercent, 2, '%')}</td><td><div class="table-action-group">${button('买入', 'trade-stock', `data-symbol="${e(holding.symbol)}" data-side="buy"`, 'small-button')}${button('卖出', 'trade-stock', `data-symbol="${e(holding.symbol)}" data-side="sell"`, 'small-button', holding.available <= 0)}</div></td></tr>`).join('') : tableEmpty(9, '暂无持仓')}</tbody></table></div></section>`;
}
function tradesTable() {
  const trades = acct().trades || [];
  return `<section class="section-card"><div class="section-header"><h2>模拟成交记录</h2><span class="muted small">${trades.length} 笔 · 累计费用 ${n(acct().fees)} 元</span></div><div class="table-wrap"><table><thead><tr><th>成交时间</th><th class="align-left">股票</th><th>方向</th><th>成交价格</th><th>数量</th><th>成交金额</th><th>费用</th><th>已实现盈亏</th></tr></thead><tbody>${trades.length ? trades.map(trade => `<tr><td>${e(timeLabel(trade.time))}</td><td class="align-left">${stockButton(trade)}</td><td class="${trade.side === 'buy' ? 'up' : 'down'}">${trade.side === 'buy' ? '买入' : '卖出'}</td><td>${securityPrice(trade.price, trade.symbol)}</td><td>${quantity(trade.qty, trade.symbol)}</td><td>${n(trade.gross)}</td><td title="${e(`佣金 ${n(trade.commission)} / 过户费 ${n(trade.transfer)} / 印花税 ${n(trade.stamp)}`)}">${n(trade.fees)}</td><td class="${direction(trade.realized)}">${trade.side === 'sell' ? signed(trade.realized) : '—'}</td></tr>`).join('') : tableEmpty(8, '暂无成交记录')}</tbody></table></div><div class="table-meta"><span>成交来源与报价时间随每笔记录保存。盈亏按 FIFO 成本法、扣除买卖费用计算。</span></div></section>`;
}
function valuationWarning() {
  const account = acct();
  if (account.valuationWarning) return `<div class="data-warning account-warning">${e(account.valuationWarning)}${account.valuationAsOf ? ` 行情时间：${e(timeLabel(account.valuationAsOf))}` : ''}</div>`;
  return account.valuationComplete === false ? `<div class="data-warning account-warning">部分持仓缺少有效行情，当前总资产、市值和收益不能作为完整估值。缺少报价：${e((account.missingQuotes || []).map(symbol => state.quotes.get(symbol)?.name || symbol).join('、'))}</div>` : '';
}
function accountPage() {
  const account = acct();
  if (!account.initialized) return `${pageTitle('个人账户')}<section class="section-card empty-state"><h2>创建你的模拟账户</h2><p>交易数据保存在这台电脑。初始本金由你设置。</p>${button('创建账户', 'setup', '', 'primary')}</section>`;
  return `${pageTitle('个人账户', '', `${button('充值账户资产', 'deposit', '', 'primary', !!state.capitalPending || !!state.capitalStorageError)}${button('修改虚拟资产', 'capital', '', '', !!state.capitalPending || !!state.capitalStorageError)}${button('刷新账户', 'refresh-account', '', 'small-button')}`)}<div class="account-identity page-title"><div class="avatar">${e(String(account.nickname || '我').slice(0,1))}</div><div><div class="profile-title user-name">${e(account.nickname)}</div><div class="identity-meta">本地模拟账户 · 创建于 ${e(timeLabel(account.createdAt))}</div></div></div>
    ${valuationWarning()}<div class="account-summary"><section class="summary-card total"><span class="metric-label">总资产（元）</span><div class="big-value">${n(account.totalAssets)}</div><p class="small detail-last-note">可用 + 冻结资金 + 持仓市值</p></section><section class="summary-card"><span class="metric-label">累计盈亏（元）</span><div class="big-value ${direction(account.totalProfit)}">${signed(account.totalProfit)}</div></section><section class="summary-card"><span class="metric-label">净投入收益率</span><div class="big-value ${direction(account.totalReturn)}">${signed(account.totalReturn, 2, '%')}</div></section><section class="summary-card"><span class="metric-label">当日盈亏（元）</span><div class="big-value ${direction(account.todayProfit)}">${signed(account.todayProfit)}</div><p class="small muted detail-last-note">${finite(account.todayProfit) ? '相对本日资产基准' : '尚无可用的当日资产基准'}</p></section></div>
    <section class="section-card account-secondary">${[['持仓市值',account.marketValue],['可用资金',account.cash],['冻结资金',account.frozenCash],['原始本金',account.initial],['净投入',account.netCapital],['已实现盈亏',account.realized]].map(([label,value]) => `<div><span class="metric-label">${label}（元）</span><span class="metric-value">${n(value)}</span></div>`).join('')}</section>
    <div class="trade-nav account-shortcuts" aria-label="账户交易操作">${[['buy','买入'],['sell','卖出'],['orders','委托 / 撤单'],['holdings','持仓'],['trades','成交记录']].map(([tab,label]) => `<button data-action="trade-tab" data-tab="${tab}" class="${tab}">${label} ›</button>`).join('')}</div>
    <div class="account-actions"><section class="section-card action-card"><h2>账户备份</h2><p>导出账户、委托、成交与自选数据。选择文件后可预览并恢复。</p>${button('导出备份', 'backup', '', 'primary')} ${button('恢复备份', 'preview-restore')} ${button('本地自动备份', 'list-backups')}</section><section class="section-card action-card"><h2>数据检查</h2><p>检查资金、持仓、费用与委托冻结是否一致，查看账户数据状态。</p>${button('检查账户', 'diagnostics')}</section><section class="section-card action-card"><h2>重新开始</h2><p>重设本金，清空持仓、委托、成交和资金流水。弹窗可选择保留或清空自选，重置前自动备份。</p>${button('重置账户', 'reset', '', 'danger')}</section></div>
    ${capitalFlowsTable()}<p class="account-data-notice">${account.valuationAsOf ? `持仓估值行情时间：${e(timeLabel(account.valuationAsOf))}。` : ''}资金调整不计入盈亏。净投入 = 原始本金 + 历次净增减资金；收益率以净投入为分母，净投入不为正时不计算。账户数据保存在本机，软件更新不会主动清空记录。累计盈亏已扣除成交费用；当日盈亏与累计收益分别计算。</p>`;
}
function capitalFlowsTable() {
  const flows = acct().capitalFlows || [];
  return `<section id="capital-records" class="section-card capital-records"><div class="section-header"><h2>资金流水</h2><span class="muted small">${flows.length} 笔 · 不计入交易盈亏</span></div><div class="table-wrap"><table><thead><tr><th>时间</th><th>类型</th><th>资金变动（元）</th><th>变动前现金</th><th>变动后现金</th><th>冻结现金</th><th class="align-left">备注</th></tr></thead><tbody>${flows.length ? flows.map(flow => `<tr><td>${e(timeLabel(flow.time))}</td><td>${flow.type === 'withdrawal' ? '减少虚拟资金' : '增加虚拟资金'}</td><td class="${direction(flow.amount)}">${signed(flow.amount)}</td><td>${n(flow.beforeCash)}</td><td>${n(flow.afterCash)}</td><td>${n(flow.frozenCash)}</td><td class="align-left">${e(flow.note || '修改虚拟资产')}</td></tr>`).join('') : tableEmpty(7, '暂无资金调整记录')}</tbody></table></div></section>`;
}

async function boot() {
  state.bootError = ''; state.busy = true; render();
  try {
    const result = await api.bootstrap();
    state.app = result.app || {}; rememberAccount(result.account); state.overview = result.market || null; state.status = result.status || null;
    storeQuotes([...(result.market?.indices || []), ...(result.market?.sectors || []), ...(result.market?.hot || [])]);
    state.booted = true; state.busy = false; loadPending(); loadCapitalPending(); render();
    if (!acct().initialized) openSetup();
    stopUpdates?.(); stopUpdates = api.onUpdate(() => {
      // Provider notifications may arrive 800ms after a poll. They must not
      // perpetually start a new poll; mutations already return their account.
      if (Date.now() - lastPollFinished > 1500) poller.request({ queue: false });
    });
    await Promise.allSettled([loadMarketList(), refreshWatch(), loadMiniCharts()]);
    poller.start({ immediate: false });
  } catch (error) { state.bootError = errorMessage(error); }
  finally { state.busy = false; render(); }
}
const poller = createPolling({
  run: backgroundRefresh,
  delay: () => refreshInterval({ hidden: document.hidden, sessionOpen: state.status?.session?.open, failures: state.refresh.failures }),
});
async function backgroundRefresh() {
  if (!state.booted || state.busy || (state.page === 'detail' && state.detailBusy) || (state.page === 'market-list' && state.listBusy) || (state.page === 'market' && state.marketBusy) || dialog.open) return;
  const page = state.page;
  state.refresh.running = true; renderStatus();
  let healthy = true;
  try {
    // Read watchlist/holdings before their quotes, so a service-side change is
    // fully reflected in this cycle instead of waiting for a second cycle.
    rememberAccount(await api.account());
    state.status = await api.status();
    if (state.page !== page) return;
    if (page === 'market') {
      const result = await api.marketOverview({ refresh: false });
      if (state.page === page) {
        state.overview = result;
        storeQuotes([...(result.indices || []), ...(result.sectors || []), ...(result.hot || [])]);
        healthy = (await loadMarketList(false, { background: true })) !== false;
        const symbols = [...new Set([...(result.indices || []).map(q => q.symbol), ...(result.hot || []).slice(0,5).map(q => q.symbol)])];
        if (symbols.length) healthy = quoteResult(await api.quotes({ symbols }), symbols) && healthy;
        if (Date.now() - lastMiniRefresh >= 30000) { await loadMiniCharts(true); lastMiniRefresh = Date.now(); }
      }
    } else if (page === 'market-list' && !marketTimer && composingInput?.dataset.input !== 'market-search') healthy = (await loadMarketList(true, { background: true })) !== false;
    else if (page === 'watch') healthy = (await refreshWatch(false)) !== false;
    else if (page === 'detail') healthy = (await refreshDetail({ background: true })) !== false;
    else if (page === 'trade' && state.selected) {
      const symbols = [state.selected.symbol];
      healthy = quoteResult(await api.quotes({ symbols }), symbols);
    }
    rememberAccount(await api.account());
    if (acct().valuationComplete === false) healthy = false;
    state.status = await api.status();
    if (!healthy || !state.status.online) throw new Error('本次部分行情未更新，正在保留上次数据并重试。');
    state.refresh.failures = 0; state.refresh.warning = '';
  } catch (error) {
    state.refresh.failures++; state.refresh.warning = errorMessage(error);
    // Keep the original source times and charts when a provider is unavailable.
    if (state.page === 'detail' && state.detailHistory) state.detailHistory = { ...state.detailHistory, cached: true, warning: state.refresh.warning };
  } finally {
    state.refresh.running = false; state.refresh.lastCheck = new Date().toISOString(); lastPollFinished = Date.now();
    if (!state.busy && !dialog.open) render(); else renderStatus();
  }
}
async function loadMarketList(full = state.page === 'market-list', { background = false, refresh = false } = {}) {
  const requestField = full ? 'listRequest' : 'marketRequest', busyField = full ? 'listBusy' : 'marketBusy', errorField = full ? 'listError' : 'marketError';
  if (background && state[busyField]) return;
  const token = ++state[requestField], params = { ...(full ? state.list : state.homeList) };
  if (!background) { state[busyField] = true; render(); }
  state[errorField] = '';
  try {
    const result = await api.marketList({ ...params, refresh });
    const symbols = result.items.filter(item => item.type !== 'sector' && !item.identityOnly).map(item => item.symbol);
    let healthy = !result.cached;
    if (symbols.length) {
      try { const quotes = await api.quotes({ symbols, refresh }); healthy = quoteResult(quotes, symbols) && healthy; result.quoteWarning = quotes.warning || ''; result.quoteAsOf = quotes.asOf; }
      catch (error) { healthy = false; if (token === state[requestField]) state[errorField] = `报价更新失败：${errorMessage(error)}`; }
    }
    if (token !== state[requestField]) return;
    if (JSON.stringify(params) !== JSON.stringify(full ? state.list : state.homeList)) return;
    if (full) { state.listItems = result; saveListState(); } else state.marketItems = result;
    storeQuotes(result.items);
    return healthy;
  } catch (error) { if (token === state[requestField]) state[errorField] = errorMessage(error); return false; }
  finally { if (token === state[requestField]) { if (!background) { state[busyField] = false; render(); } } }
}
function saveListState() { state.listStates.set(state.list.kind, { params: { ...state.list }, items: state.listItems, error: state.listError }); }
function openMarketList(kind) {
  if (!['stocks','indices','sectors','hot'].includes(kind)) return;
  if (state.page === 'market-list' && state.list.kind === kind) return;
  stopSearchEditing();
  if (state.page === 'market') state.homeScroll = window.scrollY;
  if (state.page === 'market-list') saveListState();
  const previous = state.listStates.get(kind);
  state.list = previous ? { ...previous.params } : listDefaults(kind);
  state.drafts.marketSearch = state.list.query;
  state.listItems = previous?.items || null; state.listError = previous?.error || '';
  state.detailRequest++; state.detailBusy = false; state.page = 'market-list'; render(); window.scrollTo(0,0);
  void loadMarketList(true);
}
async function refreshMarket() {
  state.overviewError = '';
  try { const overview = await api.marketOverview({ refresh: true }); state.overview = overview; state.status = await api.status(); storeQuotes([...(overview.indices || []), ...(overview.sectors || []), ...(overview.hot || [])]); }
  catch (error) { state.overviewError = errorMessage(error); }
  await loadMarketList(false); await loadMiniCharts(true); render();
}
async function loadMiniCharts(force = false) {
  if (miniInFlight) return miniInFlight;
  const items = [...(state.overview?.indices || []).slice(0,4), ...(state.overview?.sectors || []).slice(0,6)].filter(item => force || !state.histories.has(`${item.symbol}|minute`));
  miniInFlight = (async () => {
  // Real histories only. A missing series stays empty; no decorative synthetic chart is drawn.
  for (let i = 0; i < items.length; i += 3) await Promise.allSettled(items.slice(i, i + 3).map(async item => {
    try { const result = await api.history({ symbol: item.symbol, kind: 'minute' }); state.histories.set(`${item.symbol}|minute`, result.items); }
    catch { if (!state.histories.has(`${item.symbol}|minute`)) state.histories.set(`${item.symbol}|minute`, []); }
  }));
  if (state.page === 'market') render();
  })();
  try { await miniInFlight; } finally { miniInFlight = null; }
}
async function refreshWatch(shouldRender = true) {
  if ((acct().watchlist || []).length) {
    const symbols = [...acct().watchlist], generation = acct().generation;
    const result = await api.quotes({ symbols });
    if (generation !== acct().generation || symbols.join('|') !== acct().watchlist.join('|')) return false;
    const healthy = quoteResult(result, symbols); state.watchQuoteState = result;
    if (shouldRender) render();
    return healthy;
  }
  if (shouldRender) render();
  return true;
}
function stopSearchEditing() {
  clearTimeout(searchTimer); clearTimeout(marketTimer); searchTimer = marketTimer = null;
  state.searchRequest++; state.listRequest++; state.searchBusy = state.listBusy = false;
  composingInput = null; compositionContext = ''; deferredRender = false;
}
function invalidateSearch(input) {
  if (input.dataset.input === 'market-search') {
    clearTimeout(marketTimer); marketTimer = null; state.listRequest++; state.listBusy = false;
  } else {
    clearTimeout(searchTimer); searchTimer = null; state.searchRequest++; state.searchBusy = false;
    state.searchResults = []; state.searchContext = input.dataset.input === 'trade-search' ? 'trade' : 'watch';
    for (const button of content.querySelectorAll('.search-results button')) button.disabled = true;
  }
}
function saveSearchDraft(input) {
  if (input.dataset.input === 'market-search') state.drafts.marketSearch = input.value;
  else if (input.dataset.input === 'watch-search') state.drafts.watchSearch = input.value;
  else {
    state.form.symbolSearch = input.value; state.selected = null; state.form.limit = ''; state.tradeError = '';
    state.tradeRequest++;
    const limit = content.querySelector('#order-limit'); if (limit) limit.value = '';
    const submit = content.querySelector('#order-form button[type="submit"]'); if (submit) submit.disabled = true;
  }
}
function runSearch(input) {
  if (!activeSearch(input) || composingInput) return;
  if (input.dataset.input === 'market-search') {
    clearTimeout(marketTimer); marketTimer = null;
    state.list.query = state.drafts.marketSearch; state.list.page = 1; state.listItems = null;
    void loadMarketList(true);
  } else {
    clearTimeout(searchTimer); searchTimer = null;
    void searchStocks(input.value, input.dataset.input === 'watch-search' ? 'watch' : 'trade');
  }
}
function scheduleSearch(input) {
  if (!activeSearch(input) || composingInput) return;
  const context = pageContext(), query = input.value;
  const ready = () => activeSearch(input) && pageContext() === context && input.value === query && !composingInput;
  if (input.dataset.input === 'market-search') {
    clearTimeout(marketTimer);
    marketTimer = setTimeout(() => { marketTimer = null; if (ready()) runSearch(input); }, 350);
  } else {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { searchTimer = null; if (ready()) runSearch(input); }, 350);
  }
}
async function searchStocks(query, context) {
  const page = context === 'watch' ? 'watch' : 'trade', tab = state.tradeTab, requestedQuery = query.trim(), generation = acct().generation;
  const serviceQuery = context === 'trade' ? tradeSearchQuery(requestedQuery, state.selected) : requestedQuery;
  const draft = () => context === 'watch' ? state.drafts.watchSearch : state.form.symbolSearch;
  if (composingInput || state.page !== page || draft().trim() !== requestedQuery) return;
  const token = ++state.searchRequest;
  const current = () => token === state.searchRequest && state.page === page && (context !== 'trade' || state.tradeTab === tab)
    && !composingInput && draft().trim() === requestedQuery && generation === acct().generation;
  state.searchContext = context;
  if (!query.trim()) { state.searchResults = []; state.searchBusy = false; render(); return; }
  state.searchBusy = true; render();
  try {
    const result = await api.marketList({ kind: 'stocks', market: 'all', query: serviceQuery, page: 1, pageSize: 10, sort: 'amount', direction: 'desc' });
    if (!current()) return;
    state.searchResults = result.items; storeQuotes(result.items);
    if (!result.items.length) toast('未找到股票，请尝试名称或六位代码。');
  } catch (error) { if (current()) { state.searchResults = []; toast(errorMessage(error), true); } }
  finally { if (current()) { state.searchBusy = false; render(); } }
}
function itemForSymbol(symbol) {
  const stored = state.quotes.get(symbol);
  if (stored) return stored;
  const holding = acct().holdings.find(item => item.symbol === symbol);
  return { ...holding, symbol, code: symbol.replace(/^(sh|sz|bj)/, ''), market: symbol.slice(0,2), type: 'stock' };
}
async function openDetail(symbol) {
  stopSearchEditing();
  if (state.page !== 'detail') { state.previousPage = state.page; state.previousScroll = window.scrollY; }
  if (state.page === 'detail' && state.detail?.symbol === symbol && state.detailBusy) return;
  state.detail = itemForSymbol(symbol); state.page = 'detail'; state.detailKind = 'minute'; state.detailHistory = null;
  state.detailError = ''; render(); window.scrollTo(0,0);
  await refreshDetail();
}
async function refreshDetail({ background = false } = {}) {
  if (background && state.detailBusy) return;
  const token = ++state.detailRequest, symbol = state.detail?.symbol, kind = state.detailKind;
  if (!symbol) return;
  if (!background) { state.detailBusy = true; state.detailError = ''; render(); }
  const results = await Promise.allSettled([api.quotes({ symbols: [symbol], refresh: !background }), api.history({ symbol, kind, refresh: !background })]);
  if (token !== state.detailRequest || state.page !== 'detail' || symbol !== state.detail?.symbol || kind !== state.detailKind) return;
  let healthy = true; const errors = [];
  if (results[0].status === 'fulfilled') healthy = quoteResult(results[0].value, [symbol]);
  else { healthy = false; quoteResult({ items: [] }, [symbol]); errors.push(`报价：${errorMessage(results[0].reason)}`); }
  if (results[1].status === 'fulfilled' && results[1].value.items?.length) {
    state.detailHistory = results[1].value;
    if (results[1].value.cached) healthy = false;
  } else {
    const message = results[1].status === 'rejected' ? errorMessage(results[1].reason) : results[1].value.warning || '行情源暂未返回走势';
    healthy = false; errors.push(`走势：${message}`);
    if (state.detailHistory?.items?.length) state.detailHistory = { ...state.detailHistory, cached: true, warning: `暂未更新，保留上次走势。${message}` };
    else state.detailHistory = results[1].status === 'fulfilled' ? results[1].value : null;
  }
  state.detailError = errors.join('；');
  if (!background) { state.detailBusy = false; render(); }
  return healthy;
}
async function selectTrade(symbol, side = state.tradeTab) {
  stopSearchEditing();
  // Choosing a result replaces the search text intentionally, even when a
  // keyboard or programmatic click leaves the old search editor focused.
  if (document.activeElement === content.querySelector('#trade-search')) document.activeElement.blur();
  const token = ++state.tradeRequest;
  state.detailRequest++; state.detailBusy = false; state.page = 'trade'; state.tradeTab = ['buy','sell'].includes(side) ? side : 'buy'; state.selected = itemForSymbol(symbol);
  const selectedSide = state.tradeTab;
  state.searchResults = []; state.searchBusy = false; state.searchRequest++;
  state.form.symbolSearch = `${state.selected.name || ''} ${state.selected.code || symbol}`.trim(); state.tradeError = '';
  const quantityFor = quote => {
    const minimum = starSecurity(quote) ? 200 : 100;
    const available = acct().holdings.find(item => item.symbol === symbol)?.available;
    return String(selectedSide === 'sell' && finite(available) && available > 0 && available < minimum ? available : minimum);
  };
  const priceFor = quote => {
    const price = selectedSide === 'buy' ? quote.ask : quote.bid;
    return finite(price) && price > 0 ? price.toFixed(2) : finite(quote.price) && quote.price > 0 ? quote.price.toFixed(2) : '';
  };
  state.form.qty = quantityFor(state.selected); state.form.limit = priceFor(state.selected);
  const initialQty = state.form.qty, initialLimit = state.form.limit;
  render(); window.scrollTo(0,0);
  try { const response = await api.quotes({ symbols: [symbol] }); quoteResult(response, [symbol]); }
  catch (error) { if (token === state.tradeRequest) state.tradeError = `无法获取当前报价：${errorMessage(error)}`; }
  if (token !== state.tradeRequest || state.page !== 'trade' || state.selected?.symbol !== symbol || state.tradeTab !== selectedSide) return;
  const quote = state.quotes.get(symbol) || state.selected;
  // Only untouched defaults may follow the arriving quote; never replace a draft.
  if (state.form.qty === initialQty && document.activeElement !== content.querySelector('#order-qty')) state.form.qty = quantityFor(quote);
  if (state.form.limit === initialLimit && document.activeElement !== content.querySelector('#order-limit')) state.form.limit = priceFor(quote);
  render();
}
async function mutateWatch(symbol, remove) {
  const account = acct();
  rememberAccount(await api.watch({ symbol, remove, expectedVersion: account.version, generation: account.generation }));
  if (!remove) void refreshWatch().catch(() => { if (state.page === 'watch' && acct().generation === account.generation) toast('自选已保存，报价暂未更新。', true); });
  toast(remove ? '已移出自选' : '已加入自选');
}

function loadPending() {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return;
    const value = JSON.parse(raw);
    if (!validatePending(value)) throw new Error('保存的委托信息不完整');
    state.pending = value;
  } catch (error) { state.storageError = `无法读取上次待确认委托：${errorMessage(error)}。为避免重复下单，暂时禁止提交新委托。请先核对并导出委托记录；恢复或重置账户后可结束旧委托保护。`; }
}
function savePending(intent) {
  const value = { schema: 1, intent, createdAt: new Date().toISOString() };
  // Write and read before sending. A failed write must not leave an untracked order.
  const serialized = JSON.stringify(value);
  try { localStorage.setItem(PENDING_KEY, serialized); if (localStorage.getItem(PENDING_KEY) !== serialized) throw new Error('委托标识未保存'); }
  catch { throw new Error('本机无法保存委托标识，本次委托尚未发送。请检查磁盘与账户数据。'); }
  state.pending = value; state.pendingError = ''; render();
}
function clearPending() {
  try { localStorage.removeItem(PENDING_KEY); if (localStorage.getItem(PENDING_KEY)) throw new Error(); }
  catch { state.storageError = '委托已确认，但本机未能清除待确认提示。请重启后先查询结果，避免重复下单。'; return; }
  state.pending = null; state.pendingError = '';
}
async function submitOrder() {
  if (state.pending || state.storageError) return;
  const symbol = state.selected?.symbol, qty = Number(state.form.qty), limit = Number(state.form.limit);
  if (!symbol || state.selected.type !== 'stock' || !Number.isInteger(qty) || qty <= 0 || !finite(limit) || limit <= 0) throw new Error('请选择股票，并输入有效价格与整数数量。');
  const intent = { id: createOrderId(), generation: acct().generation, symbol, side: state.tradeTab, qty, limit };
  savePending(intent);
  await dispatchPending();
}
async function dispatchPending() {
  const intent = state.pending?.intent;
  if (!intent) return;
  if (intent.generation !== acct().generation) throw new Error('账户已更换，此委托不能在新账户重试。');
  state.tradeError = '';
  try {
    const result = await api.submit({ ...intent }); rememberAccount(result.account);
    if (result.order) { clearPending(); state.tradeTab = 'orders'; state.page = 'trade'; toast(`委托${orderStatus(result.order.status)}${result.replayed ? '（已核对原结果）' : ''}`); }
    else { state.pendingError = '服务未返回委托结果，请先查询。'; }
  } catch (error) {
    state.pendingError = errorMessage(error); state.tradeError = errorMessage(error);
    if (isDefinitiveRejection(error.code)) {
      try {
        const checked = await api.order({ id: intent.id, generation: intent.generation });
        rememberAccount(checked.account);
        clearPending();
        if (checked.order) { state.tradeTab = 'orders'; state.page = 'trade'; toast(`已核对：${orderStatus(checked.order.status)}`); }
        else toast(`委托未提交：${errorMessage(error)}`, true);
        return;
      } catch {
        // A business rejection is not enough to discard an identity when the
        // follow-up query itself cannot establish which account is active.
        try { rememberAccount(await api.account()); } catch { /* Keep pending. */ }
      }
    }
    // Unconfirmed transport failures retain the original identity and intent.
    toast(`委托尚未确认：${errorMessage(error)}`, true);
  }
}
async function queryPending() {
  const p = state.pending?.intent; if (!p) return;
  const result = await api.order({ id: p.id, generation: p.generation }); rememberAccount(result.account);
  if (result.order) { clearPending(); state.page = 'trade'; state.tradeTab = 'orders'; toast(`已核对：${orderStatus(result.order.status)}`); }
  else { state.pendingError = '目前未查到此委托。可同编号重试，或撤销此委托以结束核对。'; toast('目前未查到委托，请勿更换编号重复提交。'); }
}
async function cancelPending() {
  const p = state.pending?.intent; if (!p) return;
  const result = await api.cancel({ id: p.id, generation: p.generation }); rememberAccount(result.account);
  if (result.order) { clearPending(); state.page = 'trade'; state.tradeTab = 'orders'; toast(`已核对：${orderStatus(result.order.status)}`); }
  else state.pendingError = '尚未获得撤销结果，请查询委托。';
}

function openDialog(html, mandatory = false) {
  dialogRequest++;
  dialog.innerHTML = `<div class="dialog-content">${html}</div>`;
  dialog.dataset.mandatory = mandatory ? 'true' : 'false';
  if (!dialog.open) dialog.showModal();
}
function closeDialog() { if (dialog.dataset.mandatory !== 'true') { dialogRequest++; state.preview = null; dialog.close(); } }
function openSetup() {
  if (acct().initialized) return;
  openDialog(`<h2 id="dialog-title">创建模拟账户</h2><p>从你的初始本金开始。行情来自网络，委托和成交只保存在本机。</p><form data-form="setup"><div class="form-row"><label for="setup-name">账户昵称</label><input id="setup-name" name="nickname" maxlength="30" value="我的模拟账户" required></div><div class="form-row"><label for="setup-initial">初始模拟本金（元）</label><input id="setup-initial" name="initial" type="number" value="10000" min="100" max="100000000" step="0.01" required></div><div class="form-error" id="dialog-error" hidden></div><div class="dialog-actions"><button type="submit" class="button primary">创建账户</button></div></form>`, true);
}
function openReset() {
  state.resetPreview = { expectedVersion: acct().version, generation: acct().generation };
  openDialog(`<h2 id="dialog-title">重置账户</h2><p>重置会清空当前持仓、委托、成交和资金流水，并以新本金重新开始计算盈亏。重置前自动保存完整账户备份。</p><form data-form="reset"><div class="form-row"><label for="reset-name">新账户昵称</label><input id="reset-name" name="nickname" value="${e(acct().nickname)}" maxlength="30" required></div><div class="form-row"><label for="reset-initial">新初始本金（元）</label><input id="reset-initial" name="initial" type="number" value="${e(acct().initial)}" min="100" max="100000000" step="0.01" required></div><fieldset class="reset-watchlist"><legend>是否需要清空自选？</legend><label class="checkbox-option" for="reset-clear-watchlist"><input id="reset-clear-watchlist" name="clearWatchlist" type="checkbox" value="yes" aria-describedby="reset-watchlist-help">同时清空自选</label><p id="reset-watchlist-help" class="small muted">默认保留当前 ${n(acct().watchlist.length, 0)} 只自选；勾选后会一起清空。</p></fieldset><div class="form-row"><label for="reset-confirm">输入“重置账户”确认</label><input id="reset-confirm" name="confirm" autocomplete="off" required pattern="重置账户"></div><div class="form-error" id="dialog-error" hidden></div><div class="dialog-actions"><button type="button" class="button" data-action="close-dialog">取消</button><button type="submit" class="button danger">确认重置</button></div></form>`);
}
function loadCapitalPending() {
  try {
    const raw = localStorage.getItem(CAPITAL_KEY);
    if (!raw) return;
    const value = JSON.parse(raw);
    if (!validateCapitalPending(value)) throw new Error('资金调整提示不完整');
    state.capitalPending = value;
  } catch { state.capitalStorageError = '无法读取上次资金调整提示，暂时禁止调整资金。请查看资金流水；恢复或重置账户后可结束旧提示。'; }
}
function clearCapitalPending() {
  try {
    localStorage.removeItem(CAPITAL_KEY);
    if (localStorage.getItem(CAPITAL_KEY)) throw new Error();
    state.capitalPending = null; state.capitalStorageError = '';
  } catch { state.capitalStorageError = '无法清除资金调整提示，请先核对资金流水，避免重复调整。'; }
}
function openCapital(mode = 'target') {
  if (state.capitalPending || state.capitalStorageError) { toast('请先核对上次资金调整的账户和资金流水。', true); return; }
  const account = acct();
  state.capitalPreview = { expectedVersion: account.version, generation: account.generation };
  openDialog(`<h2 id="dialog-title">${mode === 'deposit' ? '充值账户资产' : '修改虚拟资产'}</h2><p>仅调整模拟账户资金，保留持仓、成交和自选。充值不计入盈亏，金额到账后可用于模拟交易。</p><div class="restore-summary"><div><span>当前总资产</span>${n(account.totalAssets)}元</div><div><span>当前可用现金</span>${n(account.cash)}元</div></div><form data-form="capital"><div class="form-row"><label for="capital-mode">调整方式</label><select id="capital-mode" name="mode" data-input="capital-mode"><option value="target"${mode === 'target' ? ' selected' : ''}>设置总资产</option><option value="deposit"${mode === 'deposit' ? ' selected' : ''}>增加虚拟资金（充值）</option><option value="withdraw">减少虚拟资金</option></select></div><div class="form-row"><label id="capital-value-label" for="capital-value">${mode === 'deposit' ? '充值金额（元）' : '目标总资产（元）'}</label><input id="capital-value" name="value" type="number" min="${mode === 'deposit' ? '0.01' : '0'}" max="1000000000" step="0.01" value="${mode === 'target' && finite(account.totalAssets) ? account.totalAssets.toFixed(2) : ''}" required><p class="help" id="capital-help">${mode === 'deposit' ? '增加可用现金，不改变原始本金、持仓和交易记录；充值记录保存在资金流水中。' : '设置总资产需要完整、有效的持仓估值。缺少行情时请使用增加或减少虚拟资金。'}</p></div><div class="form-error" id="dialog-error" hidden></div><div class="dialog-actions"><button type="button" class="button" data-action="close-dialog">取消</button><button type="submit" class="button primary">${mode === 'deposit' ? '确认充值' : '确认调整'}</button></div></form>`);
}
function confirmCapitalPending() {
  openDialog(`<h2 id="dialog-title">核对资金调整结果</h2><p>确认已查看当前总资产、可用现金及资金流水，知道上一次调整是否成功。结束提示不会再次执行资金调整。</p><form data-form="capital-confirmed"><div class="form-row"><label for="capital-confirm-text">输入“已核对”结束提示</label><input id="capital-confirm-text" name="confirm" pattern="已核对" required autocomplete="off"></div><div class="dialog-actions"><button type="button" class="button" data-action="close-dialog">返回查看</button><button type="submit" class="button primary">结束提示</button></div></form>`);
}
async function adjustCapital(values) {
  if (state.capitalPending || state.capitalStorageError || state.capitalPreview?.stale) throw new Error('请先核对资金记录，或关闭后重新打开资金设置。');
  const request = capitalPayload(values.mode, Number(values.value), state.capitalPreview);
  const pending = { schema: 1, request, createdAt: new Date().toISOString() }, serialized = JSON.stringify(pending);
  try { localStorage.setItem(CAPITAL_KEY, serialized); if (localStorage.getItem(CAPITAL_KEY) !== serialized) throw new Error(); }
  catch { throw new Error('本机无法保存资金调整标识，本次调整尚未发送。'); }
  state.capitalPending = pending;
  try { rememberAccount(await api.adjustCapital(request)); clearCapitalPending(); }
  catch (error) {
    if (['INVALID_AMOUNT','VALUATION_INCOMPLETE','INSUFFICIENT_AVAILABLE_CASH','VERSION_CONFLICT','GENERATION_CHANGED','ACCOUNT_NOT_INITIALIZED','STATE_CAPACITY','CLOCK_REVERSED'].includes(error.code)) {
      clearCapitalPending();
      if (['VERSION_CONFLICT','GENERATION_CHANGED'].includes(error.code)) state.capitalPreview.stale = true;
    } else error.message = `资金调整结果尚未确认。请查看账户与资金流水，勿重复调整。${errorMessage(error)}`;
    throw error;
  }
}
async function showBackups() {
  const request = ++dialogRequest, items = await api.listBackups();
  if (request !== dialogRequest) return;
  state.backups.items = items;
  state.backups.page = 1; state.backups.error = '';
  renderBackupDialog();
}
function renderBackupDialog() {
  const { items, page, error } = state.backups, pageSize = 8;
  // A dialog opened by perform() outlives its busy flag. Do not stamp that
  // temporary flag into its buttons; the click handler already blocks it.
  const button = (label, action, data = '', cls = '', blocked = false) => `<button type="button" class="button ${cls}" data-action="${action}" ${data}${disabled(blocked)}>${label}</button>`;
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const rows = items.slice((page - 1) * pageSize, page * pageSize);
  openDialog(`<h2 id="dialog-title">本地自动备份</h2><p>资金调整、重置及恢复前保存的完整账户。选择一份先预览，确认后才替换当前账户；备份与账户保存在同一数据库，仍可导出文件另存。</p>${error ? `<div class="form-error">${e(error)}</div>` : ''}<div class="backup-list">${rows.length ? rows.map(item => `<div class="backup-row"><div><strong>${e(timeLabel(item.createdAt))}</strong><span class="small muted">账户版本 ${n(item.version, 0)}</span></div>${button('预览', 'preview-backup', `data-id="${e(item.id)}"`, 'small-button')}</div>`).join('') : '<p class="muted">暂无自动备份。资金调整、重置或恢复前会自动保存。</p>'}</div><div class="pagination backup-pagination">${button('上一页', 'backups-page', `data-page="${page - 1}"`, 'small-button', page <= 1)}<span>第 ${page} / ${pages} 页 · ${items.length} 份</span>${button('下一页', 'backups-page', `data-page="${page + 1}"`, 'small-button', page >= pages)}</div><div class="dialog-actions">${button('关闭', 'close-dialog')}</div>`);
}
async function previewBackup(id) {
  const request = dialogRequest;
  try { const preview = await api.previewBackup({ id }); if (request === dialogRequest) showRestorePreview(preview); }
  catch (error) { if (request !== dialogRequest) return; state.backups.error = errorMessage(error); renderBackupDialog(); }
}
async function previewRestore() { const request = ++dialogRequest, preview = await api.previewRestore(); if (request === dialogRequest) showRestorePreview(preview); }
function showRestorePreview(preview) {
  if (preview.cancelled) return;
  state.preview = { ...preview };
  const summary = preview.summary || {};
  if (!preview.ok) {
    openDialog(`<h2 id="dialog-title">备份文件未通过检查</h2><p>账户尚未修改。请选择由本软件导出的完整账户备份。</p><div class="restore-problems">${(preview.problems || ['文件内容不符合当前账户格式。']).map(problem => `<p>${e(problem)}</p>`).join('')}</div><div class="dialog-actions">${button('关闭', 'close-dialog')}</div>`); return;
  }
  openDialog(`<h2 id="dialog-title">恢复账户备份</h2><p>将以这份备份替换当前账户。恢复前保存当前账户；预览后如账户发生变化，操作会中止。恢复包含旧持仓、自选、资金流水和委托；未完成委托可能继续撮合，跨日委托按规则到期。</p><div class="restore-summary">${[['昵称',summary.nickname],['原始本金',finite(summary.initial) ? `${n(summary.initial)}元` : '—'],['净投入',finite(summary.netCapital) ? `${n(summary.netCapital)}元` : '—'],['资金调整',finite(summary.capitalFlows) ? `${n(summary.capitalFlows, 0)}笔` : '—'],['现金',finite(summary.totalCash) ? `${n(summary.totalCash)}元` : '—'],['持仓',`${n(summary.holdingSymbols, 0)}只 / ${n(summary.holdings, 0)}单位（股/份）`],['成交',`${n(summary.trades, 0)}笔`],['未完成委托',`${n(summary.pending, 0)}笔`],['导出时间',summary.exportedAt ? timeLabel(summary.exportedAt) : '—']].map(([label,value]) => `<div><span>${label}</span>${e(value ?? '—')}</div>`).join('')}</div><form data-form="restore"><div class="form-row"><label for="restore-confirm">输入“恢复账户”确认</label><input id="restore-confirm" name="confirm" pattern="恢复账户" required autocomplete="off"></div><div class="form-error" id="dialog-error" hidden></div><div class="dialog-actions"><button type="button" class="button" data-action="close-dialog">取消</button><button type="submit" class="button primary">确认恢复</button></div></form>`);
}
async function showDiagnostics() {
  const result = await api.diagnostics();
  openDialog(`<h2 id="dialog-title">${result.ok ? '账户数据一致' : '账户数据需要核对'}</h2><p>${result.ok ? '本地账本检查通过。以下结果不代表行情来源或交易所撮合认证。' : '检查发现问题。请导出备份并保留当前账户资料。'}</p><div class="diagnostic-list">${(result.checks || []).map(check => `<div class="diagnostic-item ${check.ok ? '' : 'failed'}"><strong>${check.ok ? '✓' : '！'} ${e(check.label)}</strong><details><summary class="small muted">查看检查详情</summary><p>${e(check.detail)}</p></details></div>`).join('')}</div>${result.problems?.length ? `<div class="restore-problems">${result.problems.map(problem => `<p>${e(problem)}</p>`).join('')}</div>` : ''}<div class="dialog-actions">${button('关闭', 'close-dialog')}</div>`);
}
async function perform(task) {
  if (state.busy) return;
  state.busy = true; render();
  try { await task(); }
  catch (error) { toast(errorMessage(error), true); }
  finally {
    state.busy = false;
    for (const close of dialog.querySelectorAll('[data-action="close-dialog"]')) close.disabled = false;
    render();
  }
}
function navigate(page) {
  if (!['market','watch','trade','account'].includes(page)) return;
  if (state.page === 'market-list') saveListState();
  stopSearchEditing(); state.detailRequest++;
  state.detailBusy = false; state.page = page; state.searchResults = []; state.searchRequest++; state.searchBusy = false;
  render(); window.scrollTo(0,0);
  if (page === 'watch') perform(async () => { rememberAccount(await api.account()); await refreshWatch(false); });
  if (page === 'trade' && !acct().initialized) openSetup();
  if (page === 'account') perform(async () => rememberAccount(await api.account()));
}

document.addEventListener('click', event => {
  const node = event.target.closest('[data-action]'); if (!node) return;
  event.preventDefault(); if (node.disabled) return;
  const { action } = node.dataset;
  if (!api && action !== 'close-dialog') return;
  switch (action) {
    case 'navigate': navigate(node.dataset.page); break;
    case 'boot': boot(); break;
    case 'refresh-market': perform(refreshMarket); break;
    case 'reload-list': loadMarketList(undefined, { refresh: true }); break;
    case 'list-kind': openMarketList(node.dataset.kind); break;
    case 'list-back': stopSearchEditing(); saveListState(); state.page = 'market'; render(); window.scrollTo(0, state.homeScroll); break;
    case 'list-market': if (state.list.market === node.dataset.market) break; state.list.market = node.dataset.market; state.list.page = 1; state.listItems = null; loadMarketList(true); break;
    case 'list-page': if (state.listBusy) break; state.list.page = Number(node.dataset.page); state.listItems = null; loadMarketList(true); break;
    case 'sort': state.list.direction = state.list.sort === node.dataset.sort && state.list.direction === 'desc' ? 'asc' : 'desc'; state.list.sort = node.dataset.sort; state.list.page = 1; state.listItems = null; loadMarketList(true); break;
    case 'detail': openDetail(node.dataset.symbol); break;
    case 'detail-back': state.page = state.previousPage; state.detailRequest++; render(); window.scrollTo(0, state.previousScroll); break;
    case 'chart-kind': state.detailKind = node.dataset.kind; state.detailHistory = null; refreshDetail(); break;
    case 'refresh-detail': refreshDetail(); break;
    case 'search-watch': runSearch(content.querySelector('#watch-search')); break;
    case 'refresh-watch': perform(() => refreshWatch(false)); break;
    case 'watch-add': perform(() => mutateWatch(node.dataset.symbol, false)); break;
    case 'watch-remove': perform(() => mutateWatch(node.dataset.symbol, true)); break;
    case 'select-trade': perform(() => selectTrade(node.dataset.symbol)); break;
    case 'trade-stock': perform(() => selectTrade(node.dataset.symbol, node.dataset.side)); break;
    case 'trade-tab': stopSearchEditing(); state.page = 'trade'; state.tradeTab = node.dataset.tab; state.tradeError = ''; if (state.selected && ['buy','sell'].includes(state.tradeTab)) { const quote = state.quotes.get(state.selected.symbol) || state.selected; const price = state.tradeTab === 'buy' ? quote.ask : quote.bid; if (finite(price) && price > 0) state.form.limit = price.toFixed(2); } render(); window.scrollTo(0,0); break;
    case 'qty-preset': state.form.qty = node.dataset.qty; render(); break;
    case 'refresh-account': perform(async () => rememberAccount(await api.account())); break;
    case 'cancel-order': perform(async () => { const result = await api.cancel({ id: node.dataset.id, generation: node.dataset.generation }); rememberAccount(result.account); toast(`委托${orderStatus(result.order?.status)}`); }); break;
    case 'query-pending': perform(queryPending); break;
    case 'retry-pending': perform(dispatchPending); break;
    case 'cancel-pending': perform(cancelPending); break;
    case 'archive-pending': if (state.pending?.intent.generation !== acct().generation) { clearPending(); render(); toast('旧账户委托提示已结束，原记录保留在账户历史或备份中。'); } break;
    case 'setup': openSetup(); break;
    case 'reset': perform(async () => { rememberAccount(await api.account()); openReset(); }); break;
    case 'deposit': perform(async () => { rememberAccount(await api.account()); openCapital('deposit'); }); break;
    case 'capital': perform(async () => { rememberAccount(await api.account()); openCapital(); }); break;
    case 'capital-records': perform(async () => { rememberAccount(await api.account()); state.page = 'account'; render(); document.querySelector('#capital-records')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }); break;
    case 'capital-confirm': confirmCapitalPending(); break;
    case 'backup': perform(async () => { const result = await api.backup(); if (!result.cancelled) toast(result.ok ? '账户备份已导出' : '未能导出备份', !result.ok); }); break;
    case 'preview-restore': perform(previewRestore); break;
    case 'list-backups': perform(showBackups); break;
    case 'preview-backup': perform(() => previewBackup(node.dataset.id)); break;
    case 'backups-page': state.backups.page = Math.max(1, Math.min(Math.max(1, Math.ceil(state.backups.items.length / 8)), Number(node.dataset.page) || 1)); renderBackupDialog(); break;
    case 'diagnostics': perform(showDiagnostics); break;
    case 'close-dialog': closeDialog(); break;
  }
});
document.addEventListener('input', event => {
  const input = event.target, key = input.dataset.input;
  if (searchKeys.has(key)) {
    if (!activeSearch(input)) return;
    invalidateSearch(input); saveSearchDraft(input);
    if (event.isComposing && !composingInput) { composingInput = input; compositionContext = pageContext(); }
    if (composingInput === input || event.isComposing) return;
    scheduleSearch(input); render();
  } else if (key === 'order-limit' || key === 'order-qty') {
    state.form[key === 'order-limit' ? 'limit' : 'qty'] = input.value;
    const qty = Number(state.form.qty), limit = Number(state.form.limit), valid = state.selected?.type === 'stock' && Number.isInteger(qty) && qty > 0 && finite(limit) && limit > 0;
    const gross = document.querySelector('#order-gross'); if (gross) gross.textContent = valid ? `${n(qty * limit)}元` : '—';
    const submit = document.querySelector('#order-form button[type="submit"]'); if (submit) submit.disabled = state.busy || !!state.pending || !!state.storageError || !valid;
  }
});
document.addEventListener('compositionstart', event => {
  const input = event.target; if (!activeSearch(input)) return;
  composingInput = input; compositionContext = pageContext();
  invalidateSearch(input); saveSearchDraft(input);
});
document.addEventListener('compositionend', event => {
  const input = event.target;
  if (input !== composingInput || !activeSearch(input)) return;
  composingInput = null; compositionContext = '';
  invalidateSearch(input); saveSearchDraft(input); scheduleSearch(input);
  // The terminal input event and compositionend share one debounce.
  queueMicrotask(() => { if (activeSearch(input) && !composingInput) render(); });
});
document.addEventListener('focusout', event => {
  const input = event.target; if (!searchKeys.has(input.dataset?.input)) return;
  queueMicrotask(() => {
    if (!activeSearch(input) || document.activeElement === input) return;
    if (composingInput === input) {
      composingInput = null; compositionContext = '';
      invalidateSearch(input); saveSearchDraft(input); scheduleSearch(input);
    }
    if (deferredRender) render();
  });
});
document.addEventListener('keydown', event => {
  if (event.isComposing || event.keyCode === 229 || composingInput) return;
  if (['Enter', ' '].includes(event.key) && event.target.matches('tr[data-action="detail"]')) { event.preventDefault(); openDetail(event.target.dataset.symbol); }
  if (event.key === 'Enter' && searchKeys.has(event.target.dataset.input)) { event.preventDefault(); runSearch(event.target); }
});
document.addEventListener('change', event => {
  if (event.target.dataset.input !== 'capital-mode') return;
  const mode = event.target.value, input = document.querySelector('#capital-value');
  document.querySelector('#dialog-title').textContent = mode === 'deposit' ? '充值账户资产' : '修改虚拟资产';
  document.querySelector('#capital-value-label').textContent = mode === 'target' ? '目标总资产（元）' : mode === 'withdraw' ? '减少金额（元）' : '充值金额（元）';
  document.querySelector('[data-form="capital"] button[type="submit"]').textContent = mode === 'deposit' ? '确认充值' : '确认调整';
  input.min = mode === 'target' ? '0' : '0.01';
  input.value = mode === 'target' && finite(acct().totalAssets) ? acct().totalAssets.toFixed(2) : '';
  document.querySelector('#capital-help').textContent = mode === 'target' ? '设置总资产需要完整、有效的持仓估值。' : mode === 'withdraw' ? `最多减少可用现金 ${n(acct().cash)} 元；持仓和冻结资金保留。` : '只增加可用现金，不修改原始本金、持仓和成交记录。';
});
document.addEventListener('submit', async event => {
  const form = event.target; if (!form.dataset.form) return;
  event.preventDefault(); if (state.busy) return;
  if (form.dataset.form === 'order') {
    if (composingInput || document.activeElement?.dataset.input === 'trade-search') return;
    await perform(submitOrder); return;
  }
  const fields = new FormData(form), values = Object.fromEntries(fields.entries());
  const errorNode = dialog.querySelector('#dialog-error');
  state.busy = true; for (const button of form.querySelectorAll('button')) button.disabled = true;
  if (errorNode) errorNode.hidden = true;
  try {
    if (form.dataset.form === 'capital-confirmed') { if (values.confirm !== '已核对') throw new Error('请先核对账户与资金流水。'); clearCapitalPending(); }
    else if (form.dataset.form === 'capital') await adjustCapital(values);
    else if (form.dataset.form === 'setup') rememberAccount(await api.setup({ nickname: values.nickname.trim(), initial: Number(values.initial) }));
    else if (form.dataset.form === 'reset') rememberAccount(await api.reset({ nickname: values.nickname.trim(), initial: Number(values.initial), ...state.resetPreview, clearWatchlist: fields.has('clearWatchlist'), confirm: values.confirm }));
    else if (form.dataset.form === 'restore') {
      const preview = state.preview;
      if (!preview?.token) throw new Error('恢复预览已失效，请重新选择备份。');
      rememberAccount(await api.restore({ token: preview.token, expectedVersion: preview.expectedVersion, generation: preview.generation, confirm: values.confirm })); state.preview = null;
    }
    if (['reset', 'restore'].includes(form.dataset.form)) {
      state.storageError = ''; state.capitalStorageError = ''; clearPending(); clearCapitalPending(); state.resetPreview = null;
      state.capitalPreview = null; state.selected = null; state.tradeError = ''; state.pendingError = '';
      state.form = { symbolSearch: '', qty: '100', limit: '' }; state.drafts.watchSearch = '';
      state.backups = { items: [], page: 1, loading: false, error: '', previewId: null };
      state.tradeRequest++; state.detailRequest++;
    }
    dialog.dataset.mandatory = 'false'; dialog.close();
    toast(({ setup: '模拟账户已创建', reset: `账户已重置，自选已${fields.has('clearWatchlist') ? '清空' : '保留'}，重置前的数据已备份`, restore: '账户已恢复，恢复前的数据已备份', capital: values.mode === 'deposit' ? '虚拟充值已到账，资金变动不计入盈亏' : '虚拟资金已调整，持仓与交易记录保留', 'capital-confirmed': '资金调整提示已结束' })[form.dataset.form]);
    state.page = form.dataset.form === 'setup' ? 'market' : 'account';
    stopSearchEditing(); state.searchRequest++; state.searchBusy = false; state.searchResults = [];
    // Committed local results must be visible even while a quote request waits.
    // The next regular refresh or self-watch page entry updates the prices.
  } catch (error) {
    if (errorNode) { errorNode.hidden = false; errorNode.textContent = errorMessage(error); }
    else toast(errorMessage(error), true);
    if (['GENERATION_CHANGED', 'VERSION_CONFLICT'].includes(error.code)) try { rememberAccount(await api.account()); } catch { /* Retain the existing account until it can be reread. */ }
  } finally { state.busy = false; for (const button of form.querySelectorAll('button')) button.disabled = false; if (form.dataset.form === 'capital' && (state.capitalPending || state.capitalPreview?.stale)) form.querySelector('button[type="submit"]').disabled = true; render(); }
});
dialog.addEventListener('cancel', event => { if (dialog.dataset.mandatory === 'true') event.preventDefault(); else { dialogRequest++; state.preview = null; } });
document.addEventListener('visibilitychange', () => { if (state.booted) poller.request(); });
window.addEventListener('focus', () => { if (state.booted && Date.now() - lastPollFinished > 1500) poller.request(); });
window.addEventListener('beforeunload', () => { poller.stop(); stopUpdates?.(); });
if (api) boot(); else render();

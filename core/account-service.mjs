import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fail, chinaTime, getMarketSession, stockBoard, validateQuantity, cents, money, feesForIncrement, isTradingDay, priceCage } from './market-rules.mjs';

export const SNAPSHOT_KIND = 'investment-trading-room';
export const FEE_MODEL = 'order-cumulative-half-up-cents-v1';
const MAX_STATE_BYTES = 16 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024;
const STATE_FIELDS = ['schema','initialized','nickname','initialCents','cashCents','version','generation','createdAt','watchlist','lots','orders','trades','feesCents','realizedCents','quoteUsage'];
const ACTIVE = new Set(['pending','partial']);
const TERMINAL = new Set(['filled','cancelled','expired','rejected']);
const STATUSES = new Set([...ACTIVE,...TERMINAL]);
const clone = (v) => JSON.parse(JSON.stringify(v));
const canonical = (v) => v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
const digest = (v) => createHash('sha256').update(canonical(v)).digest('hex');
const same = (a,b) => canonical(a) === canonical(b);
const int = (v) => Number.isSafeInteger(v);
const safeProduct = (a,b) => { const n=a*b; if (!int(n) || n<0) fail('INVALID_AMOUNT','委托金额超出支持范围'); return n; };
const allocation = (cost,sold,qty) => Number((BigInt(cost)*BigInt(sold)+BigInt(qty)/2n)/BigInt(qty));
const cumulativeGross = (s,id) => s.trades.filter(t=>t.orderId===id).reduce((n,t)=>n+t.grossCents,0);
const timestamp = (v) => typeof v==='string' && Number.isFinite(new Date(v).getTime());
const nameValue = (value) => { if (typeof value!=='string' || !value.trim() || value.trim().length>32 || /[\x00-\x1f]/.test(value)) fail('INVALID_NICKNAME','昵称需为 1 至 32 个可显示字符'); return value.trim(); };
const initialValue = (v) => { const n=cents(v,'初始本金'); if (n<10000 || n>100_000_000_000) fail('INVALID_AMOUNT','初始本金范围为 100 至 10 亿人民币'); return n; };
function emptyState(time, initialized=false, nickname='', initialCents=0) {
  return { schema:2, initialized, nickname, initialCents, cashCents:initialCents, version:0, generation:randomUUID(), createdAt:time, watchlist:[], lots:[], orders:[], trades:[], feesCents:0, realizedCents:0, quoteUsage:{}, capitalFlows:[] };
}
function upgraded(s) {if(s.schema===1){s.schema=2;s.capitalFlows=[];}return s;}
function netDeposits(s) {return (s.capitalFlows||[]).reduce((n,f)=>n+f.amountCents,0);}
function signedCents(value,label) {
  if(typeof value!=='number'||!Number.isFinite(value)||value===0)fail('INVALID_AMOUNT',`${label}须为非零有效数字`);
  const result=cents(Math.abs(value),label);
  if(result>100_000_000_000)fail('INVALID_AMOUNT',`${label}单次不能超过 10 亿元`);
  return value<0?-result:result;
}
function capitalFlowView(f) {return {id:f.id,type:f.amountCents>0?'deposit':'withdrawal',amount:money(f.amountCents),beforeCash:money(f.beforeCashCents),afterCash:money(f.afterCashCents),frozenCash:money(f.frozenCashCents),time:f.time,note:f.note,accountVersion:f.accountVersion};}
function assertLedgerTime(s,stamp) {
  const lastTrade=s.trades.at(-1)?.time,lastCapital=s.capitalFlows?.at(-1)?.time;
  const latest=Math.max(new Date(s.createdAt).getTime(),lastTrade?new Date(lastTrade).getTime():0,lastCapital?new Date(lastCapital).getTime():0);
  if(new Date(stamp).getTime()<latest)fail('CLOCK_REVERSED','系统时间早于账户最后一笔记录，本次操作已中止；请恢复正确时间后重试');
}
function activeOrders(s) { return s.orders.filter(o=>ACTIVE.has(o.status)); }
function orderReserve(s,o) {
  if (!ACTIVE.has(o.status)) return 0;
  const gross=safeProduct(o.remainingQty,o.limitCents), previous=cumulativeGross(s,o.id);
  const extra=feesForIncrement(previous,gross,o.side).total;
  return o.side==='buy' ? gross+extra : Math.max(0,extra-gross);
}
function frozenCash(s) { return activeOrders(s).reduce((n,o)=>n+orderReserve(s,o),0); }
function held(s,symbol) { return s.lots.filter(l=>l.symbol===symbol).reduce((n,l)=>n+l.qty,0); }
function sellable(s,symbol,date,excludeId) {
  const settled=s.lots.filter(l=>l.symbol===symbol && l.boughtDate<date).reduce((n,l)=>n+l.qty,0);
  const frozen=activeOrders(s).filter(o=>o.id!==excludeId && o.symbol===symbol && o.side==='sell').reduce((n,o)=>n+o.remainingQty,0);
  return Math.max(0,settled-frozen);
}
function consumeLots(lots,symbol,qty,date) {
  let remaining=qty, cost=0;
  for (const l of lots) {
    if (l.symbol!==symbol || l.boughtDate>=date || !remaining) continue;
    const used=Math.min(remaining,l.qty), sold=l.originalQty-l.qty;
    const allocated=allocation(l.originalCostCents,sold+used,l.originalQty)-allocation(l.originalCostCents,sold,l.originalQty);
    cost+=allocated; l.qty-=used; l.costCents-=allocated; remaining-=used;
  }
    if (remaining) fail('T_PLUS_ONE','可卖持仓不足，当日买入须下一个交易日卖出');
  return {cost, lots:lots.filter(l=>l.qty>0)};
}
function identity(p) {
  if (!p || typeof p!=='object') fail('INVALID_ORDER','委托参数无效');
  if (typeof p.id!=='string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(p.id)) fail('INVALID_ORDER_ID','委托编号无效');
  if (typeof p.generation!=='string' || !p.generation) fail('GENERATION_REQUIRED','缺少账户世代，请刷新账户后操作');
  return {id:p.id,generation:p.generation};
}
function intent(p) {
  const i=identity(p), board=stockBoard(p.symbol);
  if (!['buy','sell'].includes(p.side)) fail('INVALID_SIDE','买卖方向无效');
  if (!int(p.qty) || p.qty<=0) fail('INVALID_QUANTITY','委托数量必须为正整数');
  const limitCents=cents(p.limit,'限价');
  if (limitCents>100_000_000) fail('INVALID_AMOUNT','限价超出支持范围');
  safeProduct(limitCents,p.qty);
  return {...i,symbol:p.symbol,side:p.side,qty:p.qty,limitCents,board};
}
function assertGeneration(s,p) {
  if (p.generation!==s.generation) fail('GENERATION_CHANGED','账户已恢复或重置，旧委托不能用于当前账户，请刷新并核对交易记录');
}
function assertVersion(s,p,required=false) {
  if ((required || p.expectedVersion!==undefined) && (!int(p.expectedVersion) || p.expectedVersion!==s.version)) fail('VERSION_CONFLICT','账户已发生变化，本次操作已中止，请刷新后重新确认');
}
function assertReady(s) { if (!s.initialized) fail('ACCOUNT_NOT_INITIALIZED','请先设置昵称和模拟本金'); }
function existing(s,i) {
  const o=s.orders.find(o=>o.id===i.id);
  if (!o) return null;
  if (o.identityOnly) fail('ORDER_CANCELLED','该编号已撤销，迟到委托已被阻止；请核对委托记录');
  if (!same(o.intent,i)) fail('ORDER_INTENT_CONFLICT','同一个委托编号不能对应不同证券、方向、数量或价格');
  return o;
}
function parseQuoteDate(value) {
  if (typeof value!=='string') return null;
  if (/^\d{14}$/.test(value)) return new Date(`${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}T${value.slice(8,10)}:${value.slice(10,12)}:${value.slice(12,14)}+08:00`);
  if (/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(?::\d\d)?$/.test(value)) return new Date(value.replace(' ','T') + (value.length===16 ? ':00' : '') + '+08:00');
  const d=new Date(value); return Number.isFinite(d.getTime()) ? d : null;
}
function currentValuationQuote(q, now) {
  const qt=parseQuoteDate(q?.time);if(!qt)return false;
  const current=chinaTime(now),quoted=chinaTime(qt),session=getMarketSession(now),delta=new Date(now)-qt;
  if(delta<-5000)return false;
  if(session.open)return quoted.date===current.date&&delta<=90_000;
  if(session.tradingDay&&current.minutes>=690&&current.minutes<780)return quoted.date===current.date&&quoted.minutes>=689;
  if(session.tradingDay&&current.minutes>=897&&current.minutes<900)return quoted.date===current.date&&quoted.minutes>=896;
  let expected=current.date;
  if(!session.tradingDay||current.minutes<570) {
    const d=new Date(current.date+'T04:00:00Z');
    for(let n=0;n<370;n++){d.setUTCDate(d.getUTCDate()-1);expected=d.toISOString().slice(0,10);if(isTradingDay(expected))break;}
  }
  return quoted.date===expected&&quoted.minutes>=897;
}
function previousTradingDate(date) {
  const d=new Date(date+'T04:00:00Z');
  for(let n=0;n<370;n++) {
    d.setUTCDate(d.getUTCDate()-1);
    const candidate=d.toISOString().slice(0,10);
    if(isTradingDay(candidate))return candidate;
  }
  return null;
}
function dayOpeningPrice(q,date,stamp,previousDate) {
  if(!q||q.type!=='stock')return null;
  const qt=parseQuoteDate(q.time);
  if(!qt||!Number.isFinite(qt.getTime())||qt.getTime()-new Date(stamp).getTime()>5000)return null;
  const quoted=chinaTime(qt);
  // The previous field on today's quote is the day's price baseline. An
  // older quote's previous field belongs to a different trading day. Only
  // the immediately preceding trading day's final close may replace it.
  const value=quoted.date===date?q.previous:quoted.date===previousDate&&quoted.minutes>=900?q.price:null;
  try{return Number.isFinite(value)&&value>0?cents(value,'前收盘价'):null;}catch{return null;}
}
function usableQuote(q,symbol,now,{execution=false}={}) {
  if (!q || q.symbol!==symbol || q.type!=='stock') fail('QUOTE_UNAVAILABLE','没有该证券的有效行情，请稍后再试');
  if (execution && q.tradeable!==true) fail('NOT_TRADEABLE','该证券暂不可交易或缺少可成交行情');
  if (execution) {
    const qt=parseQuoteDate(q.time), ft=parseQuoteDate(q.fetchedAt), t=new Date(now).getTime();
    if (!qt || !ft || t-qt.getTime()>90_000 || t-ft.getTime()>90_000 || qt.getTime()-t>5000 || ft.getTime()-t>5000 || chinaTime(qt).date!==chinaTime(now).date) fail('QUOTE_STALE','行情已过期，暂停模拟成交；请联网刷新');
  }
  return q;
}
function rangeCheck(q,i) {
  if (q.upper!==null && q.upper!==undefined && Number.isFinite(q.upper) && i.limitCents>cents(q.upper,'涨停价')) fail('PRICE_OUT_OF_RANGE','限价高于行情提供的当日价格上限');
  if (q.lower!==null && q.lower!==undefined && Number.isFinite(q.lower) && i.limitCents<cents(q.lower,'跌停价')) fail('PRICE_OUT_OF_RANGE','限价低于行情提供的当日价格下限');
  // Board-specific continuous-auction price cage.
  // Missing baseline is a refusal, rather than inventing an executable price.
  const candidates=i.side==='buy'?[q.ask,q.bid,q.price,q.previous]:[q.bid,q.ask,q.price,q.previous];
  const baseline=candidates.find(p=>Number.isFinite(p)&&p>0);
  if (baseline!==undefined) {
    const b=cents(baseline,'对手报价');
    const edge=priceCage(i.board,i.side,b);
    if (i.side==='buy' ? i.limitCents>edge : i.limitCents<edge) fail('PRICE_CAGE','限价超出连续竞价有效价格范围，请调整限价');
  } else fail('QUOTE_UNAVAILABLE','缺少有效申报基准行情，委托未登记');
}
function matchOrder(s,o,q,time) {
  if (!ACTIVE.has(o.status)) return false;
  const now=new Date(time), session=getMarketSession(now);
  if (!session.open) return false;
  try { usableQuote(q,o.symbol,now,{execution:true}); } catch { return false; }
  const px=o.side==='buy' ? q.ask : q.bid, sz=o.side==='buy' ? q.askSize : q.bidSize;
  if (!Number.isFinite(px) || px<=0 || !int(sz) || sz<=0) return false;
  let price;
  try { price=cents(px,'对手报价'); } catch { return false; }
  if (o.side==='buy' ? price>o.limitCents : price<o.limitCents) return false;
  if (Number.isFinite(q.upper) && price>cents(q.upper)) return false;
  if (Number.isFinite(q.lower) && price<cents(q.lower)) return false;
  const key=`${o.symbol}|${q.time}|${o.side}|${price}|${sz}`;
  const used=s.quoteUsage[key] || 0;
  let qty=Math.min(o.remainingQty,Math.max(0,sz-used));
  // Original orders obey board submission units. A match against an odd-lot
  // opposing order may fill fewer than a full lot; do not round those shares.
  if (!qty) return false;
  assertLedgerTime(s,time);
  if (o.side==='sell') qty=Math.min(qty,sellable(s,o.symbol,session.date,o.id));
  if (!qty) return false;
  const previous=cumulativeGross(s,o.id), gross=safeProduct(price,qty), f=feesForIncrement(previous,gross,o.side);
  const otherFrozen=frozenCash(s)-orderReserve(s,o);
  if (o.side==='buy' && s.cashCents-otherFrozen<gross+f.total) return false;
  if (o.side==='sell' && s.cashCents+gross-f.total<otherFrozen) return false;
  const id=randomUUID(); let realized=0;
  if (o.side==='buy') {
    s.cashCents-=gross+f.total;
    s.lots.push({id,buyTradeId:id,symbol:o.symbol,name:o.name,qty,originalQty:qty,originalCostCents:gross+f.total,costCents:gross+f.total,boughtDate:session.date,time});
  } else {
    const consumed=consumeLots(s.lots,o.symbol,qty,session.date); s.lots=consumed.lots;
    s.cashCents+=gross-f.total; realized=gross-f.total-consumed.cost; s.realizedCents+=realized;
  }
  s.feesCents+=f.total;
  s.trades.push({id,orderId:o.id,symbol:o.symbol,name:o.name,side:o.side,qty,priceCents:price,grossCents:gross,feesCents:f.total,commissionCents:f.commission,transferCents:f.transfer,stampCents:f.stamp,realizedCents:realized,time,quoteTime:q.time,source:typeof q.source==='string'?q.source:'行情源'});
  s.quoteUsage[key]=used+qty;
  o.filledQty+=qty; o.remainingQty-=qty; o.status=o.remainingQty?'partial':'filled'; o.updatedAt=time;
  o.message=o.remainingQty ? '部分成交，剩余委托继续等待有效对手盘' : '已按有效对手盘完成模拟成交';
  return true;
}
function orderView(s,o) {
  return {id:o.id,symbol:o.symbol,name:o.name,side:o.side,qty:o.qty,limit:money(o.limitCents),status:o.status,filledQty:o.filledQty,remainingQty:o.remainingQty,frozenCash:money(orderReserve(s,o)),time:o.time,updatedAt:o.updatedAt,message:o.message,generation:o.generation,...(o.identityOnly?{identityOnly:true}:{})};
}
function tradeView(t) {
  return {id:t.id,orderId:t.orderId,symbol:t.symbol,name:t.name,side:t.side,qty:t.qty,price:money(t.priceCents),gross:money(t.grossCents),fees:money(t.feesCents),commission:money(t.commissionCents),transfer:money(t.transferCents),stamp:money(t.stampCents),realized:money(t.realizedCents),time:t.time,quoteTime:t.quoteTime,source:t.source};
}
function exactKeys(v, keys, label) {
  if (!v || typeof v!=='object' || Array.isArray(v) || !same(Object.keys(v).sort(),keys.slice().sort())) fail('SNAPSHOT_INVALID',`${label}字段不完整或包含不支持字段`);
}

/** Independent economic reconstruction: no balances, lot cost, reported fees or
 * realized earnings are used as inputs. Trade quantities/prices/order intent
 * form the evidence; they do not prove the authenticity of an external feed.
 */
function diagnoseState(s) {
  const checks=[], problems=[];
  const check=(id,label,ok,detail)=>{checks.push({id,label,ok:!!ok,detail}); if(!ok) problems.push(`${label}：${detail}`);};
  try {
    exactKeys(s,s.schema===2?[...STATE_FIELDS,'capitalFlows']:STATE_FIELDS,'账户');
    if (![1,2].includes(s.schema) || typeof s.initialized!=='boolean' || !int(s.version) || s.version<0 || typeof s.generation!=='string' || !s.generation || !timestamp(s.createdAt)) fail('SNAPSHOT_INVALID','账户版本或时间无效');
    if (![s.initialCents,s.cashCents,s.feesCents,s.realizedCents].every(int) || s.initialCents<0 || s.cashCents<0 || s.feesCents<0) fail('SNAPSHOT_INVALID','账户金额须为整数分且非负本金、现金和费用');
    if (s.initialized) { nameValue(s.nickname); initialValue(money(s.initialCents)); }
    if (!Array.isArray(s.watchlist) || !Array.isArray(s.lots) || !Array.isArray(s.orders) || !Array.isArray(s.trades) || !s.quoteUsage || Array.isArray(s.quoteUsage) || typeof s.quoteUsage!=='object') fail('SNAPSHOT_INVALID','账户列表结构无效');
    if (s.watchlist.length>500 || new Set(s.watchlist).size!==s.watchlist.length) fail('SNAPSHOT_INVALID','自选重复或超过 500 只');
    for(const sym of s.watchlist) stockBoard(sym);
    for(const [key,val] of Object.entries(s.quoteUsage)) if(typeof key!=='string'|| !int(val)||val<0) fail('SNAPSHOT_INVALID','报价占用记录无效');
    const flows=s.schema===2?s.capitalFlows:[];
    if(!Array.isArray(flows))fail('SNAPSHOT_INVALID','资金变动流水结构无效');
    const flowIds=new Set();let previousFlowIndex=0,previousFlowTime=-Infinity;
    for(const f of flows) {
      exactKeys(f,['id','amountCents','beforeCashCents','afterCashCents','frozenCashCents','tradeIndex','time','note','accountVersion'],'资金变动');
      if(typeof f.id!=='string'||!f.id||flowIds.has(f.id)||![f.amountCents,f.beforeCashCents,f.afterCashCents,f.frozenCashCents,f.tradeIndex,f.accountVersion].every(int)||f.amountCents===0||Math.abs(f.amountCents)>100_000_000_000||f.beforeCashCents<0||f.afterCashCents<0||f.frozenCashCents<0||f.frozenCashCents>f.beforeCashCents||f.afterCashCents<f.frozenCashCents||f.afterCashCents!==f.beforeCashCents+f.amountCents||f.tradeIndex<previousFlowIndex||f.tradeIndex>s.trades.length||f.accountVersion<0||!timestamp(f.time)||new Date(f.time).getTime()<previousFlowTime||typeof f.note!=='string'||f.note.length>160)fail('SNAPSHOT_INVALID','资金变动金额、现金、占用、顺序或记录字段不一致');
      flowIds.add(f.id);previousFlowIndex=f.tradeIndex;previousFlowTime=new Date(f.time).getTime();
    }
    if (!s.initialized && (s.initialCents!==0||s.cashCents!==0||s.lots.length||s.orders.length||s.trades.length||flows.length||s.feesCents!==0||s.realizedCents!==0)) fail('SNAPSHOT_INVALID','未初始化账户不能包含资金或交易');
    check('schema','数据格式',true,'账户字段、金额分单位和基础类型有效');
    const om=new Map();
    for(const o of s.orders) {
      exactKeys(o,['id','generation','symbol','name','side','qty','limitCents','board','intent','identityOnly','status','filledQty','remainingQty','time','updatedAt','message'],'委托');
      identity(o); if(om.has(o.id)||o.generation!==s.generation || !STATUSES.has(o.status) || !timestamp(o.time)||!timestamp(o.updatedAt)||new Date(o.updatedAt)<new Date(o.time)) fail('SNAPSHOT_INVALID','委托编号、世代、状态或时间无效');
      if(typeof o.name!=='string'||typeof o.message!=='string'||typeof o.identityOnly!=='boolean') fail('SNAPSHOT_INVALID','委托文字字段无效');
      if (o.identityOnly) {
        if(o.status!=='cancelled'||o.symbol!==''||o.qty!==0||o.limitCents!==0||o.filledQty!==0||o.remainingQty!==0||o.intent!==null||o.board!==null||o.side!=='buy') fail('SNAPSHOT_INVALID','撤单编号屏障无效');
      } else {
        const i=intent({id:o.id,generation:o.generation,symbol:o.symbol,side:o.side,qty:o.qty,limit:money(o.limitCents)});
        if(!same(i,o.intent)||o.board!==i.board||!int(o.filledQty)||!int(o.remainingQty)||o.filledQty<0||o.remainingQty<0||o.filledQty+o.remainingQty!==o.qty) fail('SNAPSHOT_INVALID','委托意图或数量不一致');
        validateQuantity(i.board,i.side,i.qty,i.qty);
        if(o.status==='filled' && o.remainingQty!==0 || o.status==='pending'&&o.filledQty!==0 || o.status==='partial'&&(o.filledQty===0||o.remainingQty===0)) fail('SNAPSHOT_INVALID','委托成交状态不一致');
      }
      om.set(o.id,o);
    }
    let cash=s.initialCents, fees=0, realized=0, lots=[],flowIndex=0; const tradeIds=new Set(), grossByOrder=new Map(), qtyByOrder=new Map();
    let previousTime=new Date(s.createdAt).getTime();
    function applyFlows(index) {
      while(flowIndex<flows.length&&flows[flowIndex].tradeIndex===index) {
        const f=flows[flowIndex++],at=new Date(f.time).getTime();
        if(at<previousTime||cash!==f.beforeCashCents)fail('SNAPSHOT_INVALID','资金流水与逐笔现金回放或时间不一致');
        cash+=f.amountCents;
        if(!int(cash)||cash<0||cash!==f.afterCashCents)fail('SNAPSHOT_INVALID','资金流水造成现金透支或不一致');
        previousTime=at;
      }
    }
    for(const [tradeIndex,t]of s.trades.entries()) {
      applyFlows(tradeIndex);
      exactKeys(t,['id','orderId','symbol','name','side','qty','priceCents','grossCents','feesCents','commissionCents','transferCents','stampCents','realizedCents','time','quoteTime','source'],'成交');
      const o=om.get(t.orderId);
      if(!o||o.identityOnly||o.symbol!==t.symbol||o.side!==t.side||typeof t.id!=='string'||!t.id||tradeIds.has(t.id)||typeof t.name!=='string'||typeof t.source!=='string'||!timestamp(t.time)||!parseQuoteDate(t.quoteTime)) fail('SNAPSHOT_INVALID','成交关联、编号或时间无效');
      const time=new Date(t.time).getTime(), date=chinaTime(t.time).date;
      if(time<previousTime || !getMarketSession(t.time).open || time<new Date(o.time).getTime() || time>new Date(o.updatedAt).getTime()) fail('SNAPSHOT_INVALID','成交时间不是支持的连续竞价时段或与委托时间不一致');
      const qt=parseQuoteDate(t.quoteTime);
      if(time-qt.getTime()>90_000 || qt.getTime()-time>5000 || chinaTime(qt).date!==date) fail('SNAPSHOT_INVALID','成交引用的行情时间无效或过期');
      previousTime=time; tradeIds.add(t.id);
      if(![t.qty,t.priceCents,t.grossCents,t.feesCents,t.commissionCents,t.transferCents,t.stampCents,t.realizedCents].every(int)||t.qty<=0||t.priceCents<=0||safeProduct(t.qty,t.priceCents)!==t.grossCents) fail('SNAPSHOT_INVALID','成交价格、数量或金额不一致');
      if(t.side==='buy'?t.priceCents>o.limitCents:t.priceCents<o.limitCents) fail('SNAPSHOT_INVALID','成交价违反限价');
      const previous=grossByOrder.get(o.id)||0, f=feesForIncrement(previous,t.grossCents,t.side);
      if(f.total!==t.feesCents||f.commission!==t.commissionCents||f.transfer!==t.transferCents||f.stamp!==t.stampCents) fail('SNAPSHOT_INVALID','成交费用与整数分模型不一致');
      grossByOrder.set(o.id,previous+t.grossCents); qtyByOrder.set(o.id,(qtyByOrder.get(o.id)||0)+t.qty);
      let expectedRealized=0;
      if(t.side==='buy') {
        cash-=t.grossCents+f.total;
        lots.push({id:t.id,buyTradeId:t.id,symbol:t.symbol,name:t.name,qty:t.qty,originalQty:t.qty,originalCostCents:t.grossCents+f.total,costCents:t.grossCents+f.total,boughtDate:date,time:t.time});
      } else {
        const consumed=consumeLots(lots,t.symbol,t.qty,date); lots=consumed.lots;
        expectedRealized=t.grossCents-f.total-consumed.cost; cash+=t.grossCents-f.total; realized+=expectedRealized;
      }
      if(t.realizedCents!==expectedRealized) fail('SNAPSHOT_INVALID','成交已实现盈亏与独立 FIFO 回放不一致');
      if(cash<0) fail('SNAPSHOT_INVALID','历史成交曾透支现金');
      fees+=f.total;
    }
    applyFlows(s.trades.length);
    if(flowIndex!==flows.length||!int(netDeposits(s))||!int(s.initialCents+netDeposits(s)))fail('SNAPSHOT_INVALID','资金流水索引或净投入超出安全范围');
    check('capital','资金变动回放',true,`追加记录 ${flows.length} 笔，净入金 ${money(s.initialCents+netDeposits(s)).toFixed(2)} 元；充值、提取不计交易盈利`);
    check('cash','现金回放',cash===s.cashCents,`独立计算 ${money(cash).toFixed(2)} 元，账本 ${money(s.cashCents).toFixed(2)} 元`);
    check('fees','费用回放',fees===s.feesCents,`整数分累计费用 ${money(fees).toFixed(2)} 元`);
    check('realized','已实现盈亏',realized===s.realizedCents,`独立 FIFO 计算 ${money(realized).toFixed(2)} 元`);
    check('lots','持仓与成本',same(lots,s.lots),'逐笔 FIFO 数量、买入日期与剩余分币成本须完全一致');
    let fillsMatch=true, reserved=true;
    const reservations=new Map();
    for(const o of s.orders) {
      if((qtyByOrder.get(o.id)||0)!==o.filledQty) fillsMatch=false;
      if(ACTIVE.has(o.status)&&o.side==='sell') reservations.set(o.symbol,(reservations.get(o.symbol)||0)+o.remainingQty);
    }
    for(const [sym,n]of reservations) if(n>held(s,sym)) reserved=false;
    check('orders','委托成交数量',fillsMatch,'委托累计成交数量与成交记录一致，终态完整保留');
    check('frozen','资金与证券数量占用',reserved&&frozenCash(s)<=s.cashCents,'全部待成交委托的资金及证券数量占用不得超出账户');
    check('sqlite','整数分账本',true,'金额与成本分配采用整数分；快照校验不证明外部行情真实性');
  } catch(e) { check('integrity','数据完整性',false,e.message); }
  return {ok:checks.every(c=>c.ok),checks,problems,model:{cost:'FIFO',money:'整数分，四舍五入',fees:FEE_MODEL,scope:'逐笔成交回放 + 委托占用；不证明行情真实性，不模拟公司行为或完整交易所队列'}};
}

export function createAccountService({dbPath, quoteProvider=async()=>[], now=()=>new Date(), onChange=()=>{}}) {
  if(typeof dbPath!=='string'||!dbPath) fail('DATABASE_PATH','缺少本地数据库路径');
  if(dbPath!==':memory:') mkdirSync(dirname(dbPath),{recursive:true});
  const db=new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS account_state (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, generation TEXT NOT NULL, json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS account_backups (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, version INTEGER NOT NULL, generation TEXT NOT NULL, snapshot TEXT NOT NULL);');
  const time=()=>new Date(now()).toISOString();
  const quoteCache=new Map();
  let closed=false, pendingRun=null;
  if(!db.prepare('SELECT id FROM account_state WHERE id=1').get()) {
    const s=emptyState(time());
    db.prepare('INSERT OR IGNORE INTO account_state (id,version,generation,json) VALUES(1,?,?,?)').run(s.version,s.generation,JSON.stringify(s));
  }
  function load() {
    if(closed) fail('DATABASE_CLOSED','账户数据库已关闭');
    const row=db.prepare('SELECT version,generation,json FROM account_state WHERE id=1').get();
    if(!row) fail('DATABASE_CORRUPT','本地账户缺失，请保留数据并从有效备份恢复');
    let s; try{s=JSON.parse(row.json);}catch{fail('DATABASE_CORRUPT','本地账户数据无法解析，请保留数据库文件');}
    if(s.version!==row.version||s.generation!==row.generation) fail('DATABASE_CORRUPT','本地账户版本与数据库记录不一致');
    return s;
  }
  function emit() { try{onChange();}catch{} }
  function tx(fn) {
    db.exec('BEGIN IMMEDIATE'); let changed=false, result;
    try {
      const s=load(), oldVersion=s.version, oldGeneration=s.generation,legacyBefore=s.schema===1?clone(s):null;
      result=fn(s);
      changed=result.changed===true;
      if(changed) {
        if(s.schema===1){saveBackup(legacyBefore,time());upgraded(s);}
        if(![s.initialCents,s.cashCents,s.feesCents,s.realizedCents].every(int)||s.cashCents<0||s.feesCents<0)fail('INVALID_AMOUNT','账户金额超出整数分安全范围，本次事务未保存');
        s.version=oldVersion+1;
        const json=JSON.stringify(s);
        if(Buffer.byteLength(json,'utf8')>MAX_STATE_BYTES) fail('STATE_CAPACITY','本地账户已达 16 MiB 容量上限；终态记录不会被静默删除，请先导出备份后新建账户');
        const written=db.prepare('UPDATE account_state SET version=?,generation=?,json=? WHERE id=1 AND version=? AND generation=?').run(s.version,s.generation,json,oldVersion,oldGeneration);
        if(written.changes!==1) fail('VERSION_CONFLICT','账户已变化，本次事务未保存');
      }
      db.exec('COMMIT');
    } catch(e){try{db.exec('ROLLBACK');}catch{} throw e;}
    if(changed) emit();
    return result.value;
  }
  function expire() {
    const stamp=time(), today=chinaTime(stamp), current=load();
    if(!activeOrders(current).some(o=>chinaTime(o.time).date<today.date || chinaTime(o.time).date===today.date&&today.minutes>=900)) return;
    tx(s=>{
      let changed=false;
      for(const o of activeOrders(s)) {
        if(chinaTime(o.time).date<today.date || chinaTime(o.time).date===today.date&&today.minutes>=900) {o.status='expired';o.updatedAt=stamp;o.message='当日委托已到期，剩余资金和证券数量占用已释放';changed=true;}
      }
      // Execution book budgets are not terminal order records and can expire.
      for(const key of Object.keys(s.quoteUsage)) if(!key.includes(today.date)&&!key.includes(today.date.replaceAll('-',''))) delete s.quoteUsage[key];
      return {changed};
    });
  }
  function cacheQuotes(quotes) {
    if(!Array.isArray(quotes)) return;
    for(const q of quotes) if(q&&typeof q.symbol==='string') quoteCache.set(q.symbol,q);
  }
  function view(s) {
    const stamp=time(),date=chinaTime(stamp).date, symbols=[...new Set(s.lots.map(l=>l.symbol))];
    const missingQuotes=[], holdings=[]; let marketCents=0;
    for(const symbol of symbols) {
      const lots=s.lots.filter(l=>l.symbol===symbol), qty=lots.reduce((n,l)=>n+l.qty,0), costCents=lots.reduce((n,l)=>n+l.costCents,0);
      const q=quoteCache.get(symbol); let priceCents=null;
      try{if(q&&q.type==='stock'&&q.price>0)priceCents=cents(q.price);}catch{}
      if(priceCents===null||!currentValuationQuote(q,stamp))missingQuotes.push(symbol);
      const value=priceCents===null?null:safeProduct(qty,priceCents);
      if(value!==null)marketCents+=value;
      const frozen=activeOrders(s).filter(o=>o.side==='sell'&&o.symbol===symbol).reduce((n,o)=>n+o.remainingQty,0);
      holdings.push({symbol,name:q?.name||lots[0].name,qty,available:sellable(s,symbol,date),frozen,cost:money(costCents),avgCost:qty?money(costCents)/qty:0,price:priceCents===null?null:money(priceCents),marketValue:value===null?null:money(value),profit:value===null?null:money(value-costCents),profitPercent:value===null||!costCents?null:(value-costCents)/costCents*100,quoteTime:q?.time||null});
    }
    const complete=missingQuotes.length===0, assets=s.cashCents+marketCents, fc=frozenCash(s),deposits=netDeposits(s),capital=s.initialCents+deposits;
    let todayProfit=null;const todayMissingQuotes=[];
    if(!isTradingDay(date)) {if(complete)todayProfit=0;}
    else {
        const todayTrades=s.trades.filter(t=>chinaTime(t.time).date===date);
        let startCash=s.cashCents;
        const todayCapital=(s.capitalFlows||[]).filter(f=>chinaTime(f.time).date===date).reduce((n,f)=>n+f.amountCents,0);
        startCash-=todayCapital;
        const quantities=new Map(holdings.map(h=>[h.symbol,h.qty]));
        for(const t of todayTrades) {startCash-=t.side==='buy'?-t.grossCents-t.feesCents:t.grossCents-t.feesCents;quantities.set(t.symbol,(quantities.get(t.symbol)||0)+(t.side==='buy'?-t.qty:t.qty));}
        let startMarket=0;const previousDate=previousTradingDate(date);
        for(const [symbol,qty]of quantities) {
          if(!qty)continue;
          const opening=dayOpeningPrice(quoteCache.get(symbol),date,stamp,previousDate);
          if(opening===null){todayMissingQuotes.push(symbol);continue;}
          startMarket+=safeProduct(qty,opening);
        }
        if(complete&&!todayMissingQuotes.length)todayProfit=money(assets-startCash-startMarket-todayCapital);
    }
    return {initialized:s.initialized,nickname:s.nickname,initial:money(s.initialCents),netDeposits:money(deposits),netCapital:money(capital),capitalFlows:(s.capitalFlows||[]).map(capitalFlowView).reverse(),returnBasis:'净投入为分母，非时间加权收益率；净投入不为正时不计算收益率',cash:money(s.cashCents-fc),frozenCash:money(fc),totalCash:money(s.cashCents),totalAssets:complete?money(assets):null,marketValue:complete?money(marketCents):null,knownMarketValue:money(marketCents),totalProfit:complete?money(assets-capital):null,totalReturn:complete&&capital>0?(assets-capital)/capital*100:null,todayProfit,todayMissingQuotes,valuationComplete:complete,missingQuotes,valuationAsOf:holdings.map(h=>h.quoteTime).filter(Boolean).sort()[0]||null,valuationWarning:complete?null:'持仓行情缺失或时间不符合当前估值要求；仅列示最后已知价格，完整资产与收益暂不计算',version:s.version,generation:s.generation,createdAt:s.createdAt,watchlist:s.watchlist.slice(),holdings,orders:s.orders.map(o=>orderView(s,o)).reverse(),trades:s.trades.map(tradeView).reverse(),fees:money(s.feesCents),realized:money(s.realizedCents),feeModel:{commissionRate:0.0003,minimumCommission:5,transferRate:0.00001,sellStampRate:0.0005,basis:'按委托累计成交金额，以整数分四舍五入；模拟费率'} };
  }
  function getAccount(quotes) { cacheQuotes(quotes);expire();return view(load()); }
  function setup(p) {
    const nickname=nameValue(p?.nickname), initial=initialValue(p?.initial);
    return tx(s=>{if(s.initialized)fail('ALREADY_INITIALIZED','账户已经初始化，调整本金请使用重置账户');s.initialized=true;s.nickname=nickname;s.initialCents=initial;s.cashCents=initial;s.createdAt=time();return {changed:true,value:null};}),getAccount();
  }
  function watch(p) {
    stockBoard(p?.symbol);
    expire();
    tx(s=>{assertReady(s);assertGeneration(s,p);assertVersion(s,p);const found=s.watchlist.includes(p.symbol);if(p.remove){s.watchlist=s.watchlist.filter(x=>x!==p.symbol);}else if(!found){if(s.watchlist.length>=500)fail('WATCHLIST_CAPACITY','自选最多 500 只证券');s.watchlist.push(p.symbol);}return {changed:p.remove?found:!found};});
    return getAccount();
  }
  function adjustCapital(p) {
    if(!p||typeof p!=='object')fail('INVALID_AMOUNT','资金调整参数无效');
    const hasAmount=p.amount!==undefined,hasTarget=p.targetAssets!==undefined;
    if(hasAmount===hasTarget)fail('INVALID_AMOUNT','请选择变动金额或目标总资产其中一种方式');
    const requested=hasAmount?signedCents(p.amount,'变动金额'):cents(p.targetAssets,'目标总资产',true);
    if(hasTarget&&requested>100_000_000_000)fail('INVALID_AMOUNT','目标总资产不能超过 10 亿元');
    if(p.note!==undefined&&(typeof p.note!=='string'||p.note.length>160||/[\x00-\x1f]/.test(p.note)))fail('INVALID_AMOUNT','资金变动备注最多 160 个可显示字符');
    expire();
    tx(s=>{
      assertReady(s);assertGeneration(s,p);assertVersion(s,p,true);const stamp=time();assertLedgerTime(s,stamp);
      let amount=requested;
      if(hasTarget){const current=view(s);if(!current.valuationComplete||current.totalAssets===null)fail('VALUATION_INCOMPLETE','持仓行情缺失或过期，不能设置总资产；可以直接增加或减少可用资金');amount=requested-cents(current.totalAssets,'当前总资产',true);}
      if(!amount)return {changed:false};
      if(Math.abs(amount)>100_000_000_000)fail('INVALID_AMOUNT','单次虚拟资金变动不能超过 10 亿元，请分次调整');
      const frozen=frozenCash(s),after=s.cashCents+amount;
      if(amount<0&&-amount>s.cashCents-frozen)fail('INSUFFICIENT_AVAILABLE_CASH','提取金额超过可用现金，不能提取持仓价值或已冻结资金；请先成交或撤销委托');
      if(!int(after)||after<0||!int(s.initialCents+netDeposits(s)+amount))fail('INVALID_AMOUNT','调整后的账户金额超出安全范围');
      // Backup, append the flow and change cash are one indivisible write.
      saveBackup(s,stamp);upgraded(s);
      s.capitalFlows.push({id:randomUUID(),amountCents:amount,beforeCashCents:s.cashCents,afterCashCents:after,frozenCashCents:frozen,tradeIndex:s.trades.length,time:stamp,note:p.note||'修改虚拟资产',accountVersion:s.version+1});
      s.cashCents=after;return {changed:true};
    });
    return getAccount();
  }
  async function submit(p) {
    const i=intent(p);expire();
    let s=load();assertReady(s);assertGeneration(s,i);const prior=existing(s,i);
    if(prior)return {account:view(s),order:orderView(s,prior),replayed:true};
    assertVersion(s,p);
    const stamp=time(), session=getMarketSession(stamp);
    if(!session.open)fail('MARKET_CLOSED',session.label+'，当前仅接受连续竞价时段的模拟限价委托');
    const available=sellable(s,i.symbol,session.date);
    validateQuantity(i.board,i.side,i.qty,available);
    let fetched, quoteError;
    try {fetched=await quoteProvider([i.symbol]);cacheQuotes(fetched);}catch(e){quoteError=e;}
    const q=Array.isArray(fetched)?fetched.find(q=>q.symbol===i.symbol):null;
    // Check any terminal result created while network was in flight before
    // interpreting the network response (a cancellation must win this race).
    const result=tx(state=>{
      assertReady(state);assertGeneration(state,i);const duplicate=existing(state,i);
      if(duplicate)return {changed:false,value:{orderId:duplicate.id,replayed:true}};
      assertVersion(state,p);
      const nowStamp=time(), current=getMarketSession(nowStamp);
      if(!current.open)fail('MARKET_CLOSED',current.label+'，本次委托未提交');
      if(quoteError)fail('QUOTE_UNAVAILABLE','联网获取行情失败，本次委托未登记；请联网后重试同一编号');
      usableQuote(q,i.symbol,nowStamp,{execution:true});rangeCheck(q,i);
      const availableNow=sellable(state,i.symbol,current.date);
      validateQuantity(i.board,i.side,i.qty,availableNow);
      if(i.side==='sell' && i.qty>availableNow)fail('T_PLUS_ONE','可卖持仓不足，可能受 T+1 或其他卖出委托占用影响');
      const o={id:i.id,generation:i.generation,symbol:i.symbol,name:typeof q.name==='string'?q.name:i.symbol,side:i.side,qty:i.qty,limitCents:i.limitCents,board:i.board,intent:i,identityOnly:false,status:'pending',filledQty:0,remainingQty:i.qty,time:nowStamp,updatedAt:nowStamp,message:'限价委托已登记，等待有效对手盘'};
      const reserve=orderReserve(state,o);
      if(state.cashCents-frozenCash(state)<reserve)fail('INSUFFICIENT_CASH','可用资金不足，限价委托须覆盖待成交金额及模拟费用');
      state.orders.push(o);matchOrder(state,o,q,nowStamp);
      return {changed:true,value:{orderId:o.id,replayed:false}};
    });
    s=load();return {account:view(s),order:orderView(s,s.orders.find(o=>o.id===result.orderId)),replayed:result.replayed};
  }
  function cancel(p) {
    identity(p);expire();
    tx(s=>{
      assertReady(s);assertGeneration(s,p);assertVersion(s,p);
      const o=s.orders.find(o=>o.id===p.id),stamp=time();
      if(!o) {
        s.orders.push({id:p.id,generation:p.generation,symbol:'',name:'待核对委托编号',side:'buy',qty:0,limitCents:0,board:null,intent:null,identityOnly:true,status:'cancelled',filledQty:0,remainingQty:0,time:stamp,updatedAt:stamp,message:'已设置撤单编号屏障；迟到的同编号提交将被拒绝'});
        return {changed:true};
      }
      if(!ACTIVE.has(o.status))return {changed:false};
      if(!getMarketSession(stamp).open)fail('CANCEL_CLOSED',getMarketSession(stamp).label+'，当前不接受已登记委托的撤销，请在连续竞价时段重试');
      o.status='cancelled';o.updatedAt=stamp;o.message=o.filledQty?'已撤销未成交部分，已成交部分保留':'已撤单，资金和证券数量占用已释放';
      return {changed:true};
    });
    const s=load();return {account:view(s),order:orderView(s,s.orders.find(o=>o.id===p.id))};
  }
  function getOrder(p) {
    identity(p);expire();const s=load();assertGeneration(s,p);
    const o=s.orders.find(o=>o.id===p.id);
    return {order:o?orderView(s,o):null,account:view(s)};
  }
  async function processPending() {
    if(pendingRun)return pendingRun;
    pendingRun=(async()=>{
      expire();const s=load(), orders=activeOrders(s);
      if(!orders.length||!getMarketSession(time()).open)return getAccount();
      const generation=s.generation;
      let qs;try{qs=await quoteProvider([...new Set(orders.map(o=>o.symbol))]);}catch{return getAccount();}
      cacheQuotes(qs);
      tx(current=>{
        if(current.generation!==generation)return {changed:false};
        let changed=false;const stamp=time();
        for(const o of activeOrders(current))if(matchOrder(current,o,Array.isArray(qs)?qs.find(q=>q.symbol===o.symbol):null,stamp))changed=true;
        return {changed};
      });
      return getAccount();
    })();
    try{return await pendingRun;}finally{pendingRun=null;}
  }
  function diagnostics() { expire();const d=diagnoseState(load());const integrity=db.prepare('PRAGMA quick_check').get();const ok=Object.values(integrity)[0]==='ok';d.checks.push({id:'database',label:'本地 SQLite',ok,detail:ok?'SQLite quick_check 通过，事务采用 WAL 与 FULL 同步':'SQLite 完整性检查失败'});if(!ok)d.problems.push('SQLite 完整性检查失败');d.ok=d.ok&&ok;return d; }
  function envelope(s) { const body={kind:SNAPSHOT_KIND,formatVersion:s.schema,costMethod:'FIFO',feeModel:FEE_MODEL,exportedAt:time(),accountVersion:s.version,generation:s.generation,account:clone(s)};return {...body,checksum:digest(body)}; }
  function exportSnapshot() {expire();const s=load(), d=diagnoseState(s);if(!d.ok)fail('ACCOUNT_INTEGRITY','账户诊断未通过，拒绝导出可能无法恢复的快照：'+d.problems.join('；'));return envelope(s);}
  function inspectSnapshot(snapshot) {
    try {
      if(Buffer.byteLength(JSON.stringify(snapshot),'utf8')>MAX_SNAPSHOT_BYTES)fail('SNAPSHOT_INVALID','快照超过 20 MiB 上限');
      exactKeys(snapshot,['kind','formatVersion','costMethod','feeModel','exportedAt','accountVersion','generation','account','checksum'],'快照');
      if(snapshot.kind!==SNAPSHOT_KIND||![1,2].includes(snapshot.formatVersion)||snapshot.formatVersion!==snapshot.account?.schema||snapshot.costMethod!=='FIFO'||snapshot.feeModel!==FEE_MODEL||!timestamp(snapshot.exportedAt)||!int(snapshot.accountVersion)||snapshot.accountVersion!==snapshot.account?.version||snapshot.generation!==snapshot.account?.generation)fail('SNAPSHOT_INVALID','快照格式、费用模型或账户版本不匹配');
      const {checksum,...body}=snapshot;
      if(typeof checksum!=='string'||!/^[a-f0-9]{64}$/.test(checksum)||!timingSafeEqual(Buffer.from(checksum,'hex'),Buffer.from(digest(body),'hex')))fail('SNAPSHOT_INVALID','快照校验和不匹配，文件可能损坏或被修改');
      const d=diagnoseState(snapshot.account), s=snapshot.account;
      return {ok:d.ok,problems:d.problems,diagnostics:d,summary:{nickname:s.nickname,initial:money(s.initialCents),netDeposits:money(netDeposits(s)),netCapital:money(s.initialCents+netDeposits(s)),capitalFlows:(s.capitalFlows||[]).length,totalCash:money(s.cashCents),holdings:s.lots.reduce((n,l)=>n+l.qty,0),holdingSymbols:new Set(s.lots.map(l=>l.symbol)).size,orders:s.orders.length,trades:s.trades.length,watchlist:s.watchlist.length,exportedAt:snapshot.exportedAt,version:s.version,generation:s.generation,costMethod:'FIFO',pending:activeOrders(s).length}};
    } catch(e) {return {ok:false,problems:[e.message],summary:null};}
  }
  function saveBackup(s,stamp) {
    const b=envelope(s);
    db.prepare('INSERT INTO account_backups(id,created_at,version,generation,snapshot) VALUES(?,?,?,?,?)').run(randomUUID(),stamp,s.version,s.generation,JSON.stringify(b));
  }
  function restore(snapshot,p) {
    if(p?.confirm!=='恢复账户')fail('CONFIRMATION_REQUIRED','请输入“恢复账户”确认覆盖当前账户');
    identity({id:'restore',generation:p?.generation});
    const inspected=inspectSnapshot(snapshot);if(!inspected.ok)fail('SNAPSHOT_INVALID','快照不能恢复：'+inspected.problems.join('；'));
    const incoming=upgraded(clone(snapshot.account));
    tx(s=>{
      assertGeneration(s,p);assertVersion(s,p,true);
      saveBackup(s,time());
      const newGeneration=randomUUID(); incoming.generation=newGeneration;
      for(const o of incoming.orders){o.generation=newGeneration;if(o.intent)o.intent.generation=newGeneration;}
      Object.assign(s,incoming);s.version=p.expectedVersion; // tx increments the current DB version, not the imported version.
      return {changed:true};
    });
    quoteCache.clear();return getAccount();
  }
  function reset(p) {
    if(p?.confirm!=='重置账户')fail('CONFIRMATION_REQUIRED','请输入“重置账户”确认清空交易账户');
    const clearWatchlist=Object.hasOwn(p,'clearWatchlist')?p.clearWatchlist:false;
    if(typeof clearWatchlist!=='boolean')fail('INVALID_RESET_OPTIONS','是否清空自选必须为布尔值');
    const nickname=nameValue(p.nickname),initial=initialValue(p.initial);
    identity({id:'reset',generation:p.generation});
    tx(s=>{
      assertGeneration(s,p);assertVersion(s,p,true);saveBackup(s,time());
      const fresh=emptyState(time(),true,nickname,initial);
      if(!clearWatchlist)fresh.watchlist=[...s.watchlist];
      Object.assign(s,fresh);s.version=p.expectedVersion;return {changed:true};
    });
    quoteCache.clear();return getAccount();
  }
  function listBackups() { return db.prepare('SELECT id,created_at AS createdAt,version,generation FROM account_backups ORDER BY rowid DESC').all(); }
  function getBackup(id) { const row=db.prepare('SELECT snapshot FROM account_backups WHERE id=?').get(id);return row?JSON.parse(row.snapshot):null; }
  function close() {if(closed)return;closed=true;db.close();}
  // Refuse silent recovery from corrupted state. Initialization is only for a
  // new empty database; existing data remains available for forensic backup.
  const initialDiagnostic=diagnoseState(load());
  if(!initialDiagnostic.ok){db.close();closed=true;fail('DATABASE_CORRUPT','本地账户校验失败，请保留数据库：'+initialDiagnostic.problems.join('；'));}
  return {getAccount,setup,watch,adjustCapital,submit,cancel,getOrder,processPending,diagnostics,exportSnapshot,inspectSnapshot,restore,reset,listBackups,getBackup,close};
}

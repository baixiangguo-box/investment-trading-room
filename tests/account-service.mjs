import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createAccountService } from '../core/account-service.mjs';
import { cumulativeFees, cents, getMarketSession, stockBoard, validateQuantity, priceCage } from '../core/market-rules.mjs';

const clone=v=>JSON.parse(JSON.stringify(v));
const canonical=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?`[${v.map(canonical).join(',')}]`:`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
function reseal(snapshot) {const{checksum,...body}=snapshot;return{...body,checksum:createHash('sha256').update(canonical(body)).digest('hex')};}
function fixture(t, {initial=100000, symbol='sh600000', provider}={}) {
  const directory=mkdtempSync(join(tmpdir(),'trading-account-test-')), dbPath=join(directory,'account.sqlite');
  let clock=new Date('2026-10-08T02:00:00Z'), fields={};
  const quote=(sym=symbol)=>({symbol:sym,type:'stock',name:'测试行情',board:stockBoard(sym),price:10,previous:9.8,ask:10,bid:10,askSize:1_000_000,bidSize:1_000_000,upper:11,lower:9,time:clock.toISOString(),fetchedAt:clock.toISOString(),tradeable:true,source:'isolated-test-fixture',...fields});
  const options={dbPath,now:()=>clock,quoteProvider:provider|| (async syms=>syms.map(quote))};
  const service=createAccountService(options);const siblings=[];
  const account=service.setup({nickname:'隔离测试账户',initial});
  t.after(()=>{for(const s of siblings)try{s.close();}catch{}try{service.close();}catch{}rmSync(directory,{recursive:true,force:true});});
  return {service,dbPath,directory,quote,fields:(p)=>{fields={...fields,...p};},clock:(v)=>{clock=new Date(v)},tick:(ms=1000)=>{clock=new Date(clock.getTime()+ms)},generation:account.generation,submit:(p)=>service.submit({id:'order-1',generation:service.getAccount().generation,symbol,side:'buy',qty:100,limit:10,...p}),sibling:()=>{const s=createAccountService(options);siblings.push(s);return s;}};
}
const rejectsCode=(p,code)=>assert.rejects(p,e=>e.code===code);
const throwsCode=(fn,code)=>assert.throws(fn,e=>e.code===code);

test('initialization persists in a real SQLite file and cannot be repeated',t=>{
  const f=fixture(t),b=f.sibling();assert.equal(b.getAccount().nickname,'隔离测试账户');assert.equal(b.getAccount().cash,100000);
  throwsCode(()=>b.setup({nickname:'覆盖',initial:500}),'ALREADY_INITIALIZED');assert.equal(b.diagnostics().ok,true);
});
test('all money conversion and exact half-cent fee boundaries',()=>{
  assert.equal(cents(16750),1675000);assert.equal(cumulativeFees(1675000,'buy').commission,503);
  assert.equal(cumulativeFees(29000,'sell').stamp,15);assert.equal(cumulativeFees(1005000,'buy').transfer,10);
  throwsCode(()=>cents(1.005),'INVALID_AMOUNT');throwsCode(()=>cents(NaN),'INVALID_AMOUNT');
});
test('known calendar observes weekend, holidays, lunch and closing auction; unknown years close',()=>{
  assert.equal(getMarketSession('2026-10-10T02:00:00Z').open,false);
  assert.equal(getMarketSession('2026-10-01T02:00:00Z').open,false);
  assert.equal(getMarketSession('2026-10-08T04:00:00Z').open,false);
  assert.equal(getMarketSession('2026-10-08T06:58:00Z').open,false);
  assert.equal(getMarketSession('2027-01-04T02:00:00Z').knownCalendar,false);
});
test('board quantity rules reject indices and support STAR/BSE increments and odd-lot sellout',()=>{
  assert.equal(stockBoard('sh688001'),'star');assert.equal(stockBoard('bj920001'),'bse');
  throwsCode(()=>stockBoard('sh000001'),'INVALID_SYMBOL');throwsCode(()=>stockBoard('sz399001'),'INVALID_SYMBOL');
  validateQuantity('star','buy',201);validateQuantity('bse','buy',101);validateQuantity('star','sell',1,1);validateQuantity('main','sell',101,101);
  throwsCode(()=>validateQuantity('star','buy',199),'INVALID_QUANTITY');throwsCode(()=>validateQuantity('main','buy',101),'INVALID_QUANTITY');throwsCode(()=>validateQuantity('main','sell',25,201),'INVALID_QUANTITY');
});
test('immediate fill records complete fees, quote evidence, equity and T+1',async t=>{
  const f=fixture(t),r=await f.submit();assert.equal(r.order.status,'filled');assert.equal(r.account.totalCash,98994.99);assert.equal(r.account.fees,5.01);
  assert.equal(r.account.holdings[0].available,0);assert.equal(r.account.trades[0].source,'isolated-test-fixture');
  await rejectsCode(f.submit({id:'sell-day0',side:'sell'}),'T_PLUS_ONE');assert.equal(f.service.diagnostics().ok,true);
});
test('a low limit registers a pending order and freezes worst-case cash, then cancellation releases it',async t=>{
  const f=fixture(t),r=await f.submit({limit:9.9});assert.equal(r.order.status,'pending');assert.equal(r.account.frozenCash,995.01);assert.equal(r.account.cash,99004.99);
  const c=f.service.cancel({id:'order-1',generation:f.generation});assert.equal(c.order.status,'cancelled');assert.equal(c.account.frozenCash,0);assert.equal(c.account.cash,100000);
  const v=c.account.version;assert.equal(f.service.cancel({id:'order-1',generation:f.generation}).account.version,v);
});
test('pending order fills after fresh opposing price crosses its limit',async t=>{
  const f=fixture(t);await f.submit({limit:9.9});f.tick();f.fields({ask:9.88,price:9.88});const a=await f.service.processPending();
  assert.equal(a.orders[0].status,'filled');assert.equal(a.trades[0].price,9.88);assert.equal(a.frozenCash,0);assert.equal(f.service.diagnostics().ok,true);
});
test('partial fill is limited by book shares, reserves remainder and charges minimum commission once',async t=>{
  const f=fixture(t);f.fields({askSize:100});let r=await f.submit({qty:200});assert.equal(r.order.status,'partial');assert.equal(r.order.filledQty,100);assert.equal(r.account.frozenCash,1000.01);
  const version=r.account.version;let a=await f.service.processPending();assert.equal(a.version,version);assert.equal(a.trades.length,1);
  f.tick();a=await f.service.processPending();assert.equal(a.orders[0].status,'filled');assert.equal(a.trades.length,2);assert.equal(a.fees,5.02);assert.equal(f.service.diagnostics().ok,true);
});
test('the same timestamped book is not consumed again by another new order',async t=>{
  const f=fixture(t);f.fields({askSize:100});await f.submit();const r=await f.submit({id:'order-2'});
  assert.equal(r.order.status,'pending');assert.equal(r.account.trades.length,1);f.tick();const a=await f.service.processPending();assert.equal(a.trades.length,2);
});
test('replaying a final full intent needs neither a new quote nor a version increment',async t=>{
  let calls=0, offline=false;const f=fixture(t,{provider:async syms=>{calls++;if(offline)throw Error('offline');return syms.map(s=>f.quote(s));}});
  const first=await f.submit();offline=true;const retry=await f.submit();assert.equal(retry.replayed,true);assert.equal(calls,1);assert.equal(retry.account.version,first.account.version);assert.equal(retry.account.trades.length,1);
  await rejectsCode(f.submit({qty:200}),'ORDER_INTENT_CONFLICT');
});
test('unknown cancellation persists an ID-only barrier and prevents a late submit',async t=>{
  const f=fixture(t),c=f.service.cancel({id:'late-order',generation:f.generation});assert.equal(c.order.identityOnly,true);assert.equal(c.order.symbol,'');
  await rejectsCode(f.submit({id:'late-order'}),'ORDER_CANCELLED');assert.equal(f.sibling().getOrder({id:'late-order',generation:f.generation}).order.status,'cancelled');
});
test('a cancel racing an in-flight quote wins, with no economic mutation',async t=>{
  let resolve;const f=fixture(t,{provider:()=>new Promise(r=>{resolve=r;})});const request=f.submit();f.service.cancel({id:'order-1',generation:f.generation});resolve([f.quote()]);
  await rejectsCode(request,'ORDER_CANCELLED');assert.equal(f.service.getAccount().trades.length,0);assert.equal(f.service.getAccount().cash,100000);
});
test('two concurrent same-ID submissions produce one fill and one replay',async t=>{
  const pending=[];const f=fixture(t,{provider:()=>new Promise(r=>pending.push(r))});const a=f.submit(),b=f.submit();pending[0]([f.quote()]);pending[1]([f.quote()]);
  const results=await Promise.all([a,b]);assert.equal(results.filter(x=>x.replayed).length,1);assert.equal(f.service.getAccount().trades.length,1);
});
test('another SQLite connection updating version stops a baseline-sensitive submission',async t=>{
  let resolve;const f=fixture(t,{provider:()=>new Promise(r=>resolve=r)}),version=f.service.getAccount().version;
  const request=f.submit({expectedVersion:version});f.sibling().watch({symbol:'sz000001',generation:f.generation,expectedVersion:version});resolve([f.quote()]);
  await rejectsCode(request,'VERSION_CONFLICT');assert.deepEqual(f.service.getAccount().watchlist,['sz000001']);assert.equal(f.service.getAccount().trades.length,0);
});
test('stale, future, missing or untradeable quotes cannot create a pending order',async t=>{
  const f=fixture(t);f.fields({time:'2026-10-08T01:58:00Z'});await rejectsCode(f.submit(),'QUOTE_STALE');
  f.fields({time:'2026-10-08T02:01:00Z'});await rejectsCode(f.submit(),'QUOTE_STALE');
  f.fields({time:'2026-10-08T02:00:00Z',tradeable:false});await rejectsCode(f.submit(),'NOT_TRADEABLE');assert.equal(f.service.getAccount().orders.length,0);
});
test('out of daily bounds, price cage and unsupported instrument are clear refusals',async t=>{
  const f=fixture(t);await rejectsCode(f.submit({limit:12}),'PRICE_OUT_OF_RANGE');await rejectsCode(f.submit({limit:10.3}),'PRICE_CAGE');await rejectsCode(f.submit({symbol:'sh000001'}),'INVALID_SYMBOL');
});
test('frozen funds prevent spending twice, including pending commission',async t=>{
  const f=fixture(t,{initial:1000});await f.submit({limit:9.9});await rejectsCode(f.submit({id:'order-2',limit:9.9}),'INSUFFICIENT_CASH');assert.equal(f.service.getAccount().orders.length,1);
});
test('at the close the pending remainder expires and releases its funds',async t=>{
  const f=fixture(t);await f.submit({limit:9.9});f.clock('2026-10-08T07:00:00Z');const a=f.service.getAccount();assert.equal(a.orders[0].status,'expired');assert.equal(a.frozenCash,0);
  await rejectsCode(f.submit({id:'closed'}),'MARKET_CLOSED');assert.equal(f.service.diagnostics().ok,true);
});
test('selling consumes exact FIFO lot cost and freezes shares for pending sales',async t=>{
  const f=fixture(t);await f.submit({qty:200});f.tick();f.fields({ask:10.1,price:10.1});await f.submit({id:'second-lot',limit:10.1});
  f.clock('2026-10-09T02:00:00Z');f.fields({bid:10.2,price:10.2});let r=await f.submit({id:'sell-pending',side:'sell',qty:200,limit:10.3});assert.equal(r.order.status,'pending');assert.equal(r.account.holdings[0].available,100);assert.equal(r.account.holdings[0].frozen,200);
  await rejectsCode(f.submit({id:'oversell',side:'sell',qty:200,limit:10.3}),'T_PLUS_ONE');f.service.cancel({id:'sell-pending',generation:f.generation});
  r=await f.submit({id:'sell-actual',side:'sell',qty:200,limit:10.2});assert.equal(r.order.status,'filled');assert.equal(r.account.holdings[0].qty,100);assert.equal(r.account.holdings[0].cost,1015.01);assert.equal(r.account.realized,28.94);assert.equal(f.service.diagnostics().ok,true);
});
test('STAR 201-share lot permits later sale of 200 then odd one share, with exact cost allocation',async t=>{
  const f=fixture(t,{symbol:'sh688001'});await f.submit({qty:201});f.clock('2026-10-09T02:00:00Z');await f.submit({id:'sell-200',side:'sell',qty:200});const r=await f.submit({id:'sell-odd',side:'sell',qty:1});assert.equal(r.account.holdings.length,0);assert.equal(f.service.diagnostics().ok,true);assert.equal(f.service.inspectSnapshot(f.service.exportSnapshot()).ok,true);
});
test('strict exported snapshot can restore fee-boundary trades without a cent drift',async t=>{
  const f=fixture(t,{initial:1000000});f.fields({ask:167.5,bid:167.5,price:167.5,upper:200,lower:100});await f.submit({qty:100,limit:167.5});
  const snap=f.service.exportSnapshot();assert.equal(snap.account.trades[0].commissionCents,503);assert.equal(f.service.inspectSnapshot(snap).ok,true);
  const baseline=f.service.getAccount();f.service.watch({symbol:'sz000001',generation:baseline.generation,expectedVersion:baseline.version});
  const before=f.service.getAccount(),restored=f.service.restore(snap,{confirm:'恢复账户',expectedVersion:before.version,generation:before.generation});assert.equal(restored.totalCash,983244.8);assert.notEqual(restored.generation,before.generation);assert.equal(restored.version,before.version+1);assert.equal(f.service.diagnostics().ok,true);
  const backup=f.service.getBackup(f.service.listBackups()[0].id);assert.deepEqual(backup.account.watchlist,['sz000001']);assert.equal(backup.account.version,before.version);
});
test('restore refuses stale version and old-generation delayed submit/cancel/query',async t=>{
  const f=fixture(t),snap=f.service.exportSnapshot(),old=f.service.getAccount();f.service.watch({symbol:'sz000001',generation:old.generation});
  throwsCode(()=>f.service.restore(snap,{confirm:'恢复账户',expectedVersion:old.version,generation:old.generation}),'VERSION_CONFLICT');assert.equal(f.service.listBackups().length,0);
  const current=f.service.getAccount();f.service.restore(snap,{confirm:'恢复账户',expectedVersion:current.version,generation:current.generation});
  await rejectsCode(f.submit({generation:old.generation}),'GENERATION_CHANGED');throwsCode(()=>f.service.cancel({id:'order-1',generation:old.generation}),'GENERATION_CHANGED');throwsCode(()=>f.service.getOrder({id:'order-1',generation:old.generation}),'GENERATION_CHANGED');
});
test('restoring while quote request waits rejects its old generation without writing a trade',async t=>{
  let resolve;const f=fixture(t,{provider:()=>new Promise(r=>resolve=r)}),snap=f.service.exportSnapshot(),a=f.service.getAccount();const request=f.submit();
  f.service.restore(snap,{confirm:'恢复账户',expectedVersion:a.version,generation:a.generation});resolve([f.quote()]);await rejectsCode(request,'GENERATION_CHANGED');assert.equal(f.service.getAccount().trades.length,0);
});
test('failed account update rolls back the pre-restore backup in the same SQLite transaction',t=>{
  const f=fixture(t),snap=f.service.exportSnapshot(),a=f.service.getAccount(),db=new DatabaseSync(f.dbPath);
  db.exec("CREATE TRIGGER test_refuse_update BEFORE UPDATE ON account_state BEGIN SELECT RAISE(ABORT, 'isolated failure injection'); END;");
  assert.throws(()=>f.service.restore(snap,{confirm:'恢复账户',expectedVersion:a.version,generation:a.generation}),/isolated failure injection/);
  assert.equal(f.service.listBackups().length,0);assert.equal(f.service.getAccount().generation,a.generation);assert.equal(f.service.getAccount().version,a.version);db.close();
});
test('tampered envelope, extra fields and rehashed economic inconsistencies are rejected',async t=>{
  const f=fixture(t);await f.submit();const snap=f.service.exportSnapshot();
  let bad=clone(snap);bad.account.cashCents++;assert.equal(f.service.inspectSnapshot(bad).ok,false);
  bad=reseal(bad);assert.equal(f.service.inspectSnapshot(bad).ok,false);
  bad=clone(snap);bad.account.lots[0].costCents++;assert.equal(f.service.inspectSnapshot(reseal(bad)).ok,false);
  bad=clone(snap);bad.account.trades[0].feesCents++;assert.equal(f.service.inspectSnapshot(reseal(bad)).ok,false);
  bad=clone(snap);bad.unexpected=true;assert.equal(f.service.inspectSnapshot(reseal(bad)).ok,false);
});
test('pending partial snapshot restores occupied balance, exact intent and new generation consistently',async t=>{
  const f=fixture(t);f.fields({askSize:100});await f.submit({qty:200});const snap=f.service.exportSnapshot(),a=f.service.getAccount();
  const b=f.service.restore(snap,{confirm:'恢复账户',expectedVersion:a.version,generation:a.generation});assert.equal(b.frozenCash,a.frozenCash);assert.equal(b.orders[0].status,'partial');assert.equal(b.orders[0].generation,b.generation);assert.equal(f.service.inspectSnapshot(f.service.exportSnapshot()).ok,true);
  const retry=await f.submit({qty:200,generation:b.generation});assert.equal(retry.replayed,true);assert.equal(retry.account.trades.length,1);
});
test('500 cancellation tombstones are retained and never trimmed by later fills',async t=>{
  const f=fixture(t);for(let i=0;i<500;i++)f.service.cancel({id:`cancel-${i}`,generation:f.generation});await f.submit();assert.equal(f.service.getAccount().orders.length,501);
  await rejectsCode(f.submit({id:'cancel-0'}),'ORDER_CANCELLED');assert.equal(f.service.exportSnapshot().account.orders.length,501);
});
test('missing holdings quotes show incomplete assets; same-day and next-day profits use proper baselines',async t=>{
  const f=fixture(t);await f.submit();let a=f.service.getAccount();assert.equal(a.totalProfit,-5.01);assert.equal(a.todayProfit,-5.01);
  f.clock('2026-10-09T02:00:00Z');f.fields({price:10.2,previous:10});a=f.service.getAccount([f.quote()]);assert.equal(a.todayProfit,20);assert.equal(a.totalProfit,14.99);
  a=f.service.getAccount([{...f.quote(),price:null}]);assert.equal(a.valuationComplete,false);assert.equal(a.totalAssets,null);assert.equal(a.marketValue,null);assert.deepEqual(a.missingQuotes,['sh600000']);assert.equal(a.todayProfit,null);
});
test('reset defaults to preserving watchlists while clearing trades, holdings, reservations and funding flows',async t=>{
  const f=fixture(t);await f.submit();f.service.watch({symbol:'sz000001',generation:f.generation});f.service.watch({symbol:'bj920001',generation:f.generation});
  let a=f.service.getAccount();f.service.adjustCapital({amount:5000,expectedVersion:a.version,generation:a.generation});await f.submit({id:'reset-pending',limit:9.9});
  a=f.service.getAccount();const original=f.service.exportSnapshot(),backupCount=f.service.listBackups().length;
  assert(a.frozenCash>0);assert.equal(a.capitalFlows.length,1);assert.equal(a.trades.length,1);assert.equal(a.holdings.length,1);
  const b=f.service.reset({nickname:'新账户',initial:50000,confirm:'重置账户',expectedVersion:a.version,generation:a.generation});
  assert.deepEqual(b.watchlist,['sz000001','bj920001']);assert.equal(b.trades.length,0);assert.equal(b.holdings.length,0);assert.equal(b.orders.length,0);assert.equal(b.capitalFlows.length,0);
  assert.equal(b.frozenCash,0);assert.equal(b.cash,50000);assert.equal(b.totalCash,50000);assert.equal(b.initial,50000);assert.equal(b.netCapital,50000);assert.equal(b.netDeposits,0);assert.equal(b.fees,0);assert.equal(b.realized,0);assert.equal(b.totalProfit,0);
  assert.notEqual(b.generation,a.generation);assert.equal(b.version,a.version+1);assert.equal(f.service.listBackups().length,backupCount+1);
  assert.deepEqual(f.service.getBackup(f.service.listBackups()[0].id).account,original.account);assert.deepEqual(f.sibling().getAccount().watchlist,b.watchlist);assert.equal(f.service.diagnostics().ok,true);
});
test('an explicit boolean reset option preserves or clears watchlists without changing the reset balance',t=>{
  for(const clearWatchlist of [false,true]) {
    const f=fixture(t);f.service.watch({symbol:'sz000001',generation:f.generation});const a=f.service.getAccount();
    const b=f.service.reset({nickname:'选择重置账户',initial:20000,clearWatchlist,confirm:'重置账户',expectedVersion:a.version,generation:a.generation});
    assert.deepEqual(b.watchlist,clearWatchlist?[]:['sz000001']);assert.equal(b.totalAssets,20000);assert.equal(b.totalProfit,0);assert.equal(b.capitalFlows.length,0);assert.notEqual(b.generation,a.generation);
    assert.deepEqual(f.sibling().getAccount().watchlist,b.watchlist);assert.equal(f.service.diagnostics().ok,true);
  }
});
test('the pre-reset backup restores original watchlists, funding, trades and pending reservations together',async t=>{
  const f=fixture(t);f.service.watch({symbol:'sz000001',generation:f.generation});await f.submit();let a=f.service.getAccount();
  f.service.adjustCapital({amount:1234.56,expectedVersion:a.version,generation:a.generation});await f.submit({id:'backup-pending',limit:9.9});
  const original=f.service.exportSnapshot();a=f.service.getAccount();
  const reset=f.service.reset({nickname:'清空后的账户',initial:50000,clearWatchlist:true,confirm:'重置账户',expectedVersion:a.version,generation:a.generation});
  assert.deepEqual(reset.watchlist,[]);assert.equal(reset.orders.length,0);assert.equal(reset.capitalFlows.length,0);
  const backup=f.service.getBackup(f.service.listBackups()[0].id);assert.deepEqual(backup.account,original.account);assert.equal(f.service.inspectSnapshot(backup).ok,true);
  const restored=f.service.restore(backup,{confirm:'恢复账户',expectedVersion:reset.version,generation:reset.generation});
  const expected=clone(original.account);expected.generation=restored.generation;expected.version=restored.version;
  for(const order of expected.orders){order.generation=restored.generation;if(order.intent)order.intent.generation=restored.generation;}
  assert.deepEqual(f.service.exportSnapshot().account,expected);assert.deepEqual(restored.watchlist,a.watchlist);assert.equal(restored.totalCash,a.totalCash);assert.equal(restored.frozenCash,a.frozenCash);
  assert.deepEqual(restored.capitalFlows,a.capitalFlows);assert.equal(restored.holdings[0].qty,a.holdings[0].qty);assert.equal(f.sibling().diagnostics().ok,true);
});
test('invalid reset option types and stale identity or version never change account data or backups',async t=>{
  const f=fixture(t);await f.submit();f.service.watch({symbol:'sz000001',generation:f.generation});let a=f.service.getAccount();
  f.service.adjustCapital({amount:500,expectedVersion:a.version,generation:a.generation});a=f.service.getAccount();
  const before=f.service.exportSnapshot(),backups=f.service.listBackups(),base={nickname:'失败重置',initial:50000,confirm:'重置账户',expectedVersion:a.version,generation:a.generation};
  const unchanged=()=>{assert.deepEqual(f.service.exportSnapshot(),before);assert.deepEqual(f.service.listBackups(),backups);};
  for(const clearWatchlist of [undefined,null,0,1,'false','true',[],{},new Boolean(false)]) {
    throwsCode(()=>f.service.reset({...base,clearWatchlist}),'INVALID_RESET_OPTIONS');unchanged();
  }
  for(const [changes,code] of [[{expectedVersion:a.version-1},'VERSION_CONFLICT'],[{expectedVersion:undefined},'VERSION_CONFLICT'],[{generation:'old-generation'},'GENERATION_CHANGED'],[{generation:undefined},'GENERATION_REQUIRED'],[{confirm:''},'CONFIRMATION_REQUIRED'],[{initial:NaN},'INVALID_AMOUNT'],[{nickname:''},'INVALID_NICKNAME']]) {
    throwsCode(()=>f.service.reset({...base,clearWatchlist:true,...changes}),code);unchanged();
  }
});
test('a reset update failure rolls back both its backup and watchlist decision in the same SQLite transaction',t=>{
  const f=fixture(t);f.service.watch({symbol:'sz000001',generation:f.generation});const a=f.service.getAccount(),before=f.service.exportSnapshot(),db=new DatabaseSync(f.dbPath);
  try {
    db.exec("CREATE TRIGGER test_refuse_reset BEFORE UPDATE ON account_state BEGIN SELECT RAISE(ABORT, 'reset failure injection'); END;");
    assert.throws(()=>f.service.reset({nickname:'未保存账户',initial:20000,clearWatchlist:true,confirm:'重置账户',expectedVersion:a.version,generation:a.generation}),/reset failure injection/);
    assert.deepEqual(f.service.exportSnapshot(),before);assert.equal(f.service.listBackups().length,0);assert.deepEqual(f.sibling().getAccount().watchlist,['sz000001']);
  } finally {db.close();}
});
test('resetting during an in-flight submission preserves chosen watchlists and rejects its old generation',async t=>{
  let resolve;const f=fixture(t,{provider:()=>new Promise(r=>resolve=r)});f.service.watch({symbol:'sz000001',generation:f.generation});
  const a=f.service.getAccount(),request=f.submit();const reset=f.service.reset({nickname:'等待报价时重置',initial:20000,clearWatchlist:false,confirm:'重置账户',expectedVersion:a.version,generation:a.generation});
  resolve([f.quote()]);await rejectsCode(request,'GENERATION_CHANGED');const after=f.service.getAccount();
  assert.equal(after.version,reset.version);assert.equal(after.cash,20000);assert.equal(after.trades.length,0);assert.equal(after.orders.length,0);assert.deepEqual(after.watchlist,['sz000001']);assert.equal(f.service.diagnostics().ok,true);
});
test('2026 board maximums and price-cage differences are enforced precisely',()=>{
  validateQuantity('chinext','buy',300000);throwsCode(()=>validateQuantity('chinext','buy',300100),'INVALID_QUANTITY');
  validateQuantity('star','buy',100000);throwsCode(()=>validateQuantity('star','buy',100001),'INVALID_QUANTITY');
  assert.equal(priceCage('star','buy',100),102);assert.equal(priceCage('main','buy',100),110);assert.equal(priceCage('chinext','buy',100),110);
  assert.equal(priceCage('bse','buy',1000),1050);assert.equal(priceCage('bse','sell',1000),950);
});
test('lunch and closing-auction active cancellation are refused; expiration remains final',async t=>{
  const f=fixture(t);await f.submit({limit:9.9});f.clock('2026-10-08T04:00:00Z');throwsCode(()=>f.service.cancel({id:'order-1',generation:f.generation}),'CANCEL_CLOSED');
  f.clock('2026-10-08T06:58:00Z');throwsCode(()=>f.service.cancel({id:'order-1',generation:f.generation}),'CANCEL_CLOSED');
  assert.equal(f.service.getAccount().orders[0].status,'pending');f.clock('2026-10-08T07:00:00Z');assert.equal(f.service.cancel({id:'order-1',generation:f.generation}).order.status,'expired');
});
test('failed quote retrieval checks an intervening generation change before reporting offline',async t=>{
  let reject;const f=fixture(t,{provider:()=>new Promise((resolve,r)=>reject=r)}),snap=f.service.exportSnapshot(),a=f.service.getAccount();const request=f.submit();
  f.service.restore(snap,{confirm:'恢复账户',expectedVersion:a.version,generation:a.generation});reject(Error('test offline'));
  await rejectsCode(request,'GENERATION_CHANGED');assert.equal(f.service.getAccount().trades.length,0);
});
test('offline and malformed quote response reject without freezing cash or creating an order',async t=>{
  const f=fixture(t,{provider:async()=>{throw Error('test offline');}});await rejectsCode(f.submit(),'QUOTE_UNAVAILABLE');assert.equal(f.service.getAccount().orders.length,0);assert.equal(f.service.getAccount().frozenCash,0);
  const directory=mkdtempSync(join(tmpdir(),'trading-account-test-malformed-'));
  const s=createAccountService({dbPath:join(directory,'account.sqlite'),now:()=>new Date('2026-10-08T02:00:00Z'),quoteProvider:async()=>({bad:true})});
  t.after(()=>{s.close();rmSync(directory,{recursive:true,force:true});});const a=s.setup({initial:10000,nickname:'响应测试'});
  await rejectsCode(s.submit({id:'malformed',symbol:'sh600000',generation:a.generation,side:'buy',qty:100,limit:10}),'QUOTE_UNAVAILABLE');assert.equal(s.getAccount().cash,10000);
});
test('rehashed non-lot quantity and inconsistent trade quote timestamps cannot restore',async t=>{
  const f=fixture(t);await f.submit();const snap=f.service.exportSnapshot();
  let bad=clone(snap);bad.account.orders[0].intent.qty=50;bad.account.orders[0].qty=50;bad.account.orders[0].filledQty=50;assert.equal(f.service.inspectSnapshot(reseal(bad)).ok,false);
  bad=clone(snap);bad.account.trades[0].quoteTime='2026-10-08T01:58:00Z';assert.equal(f.service.inspectSnapshot(reseal(bad)).ok,false);
});
test('state capacity refuses writes explicitly without trimming or changing the version',t=>{
  const f=fixture(t),db=new DatabaseSync(f.dbPath),row=db.prepare('SELECT json FROM account_state WHERE id=1').get(),s=JSON.parse(row.json);
  s.quoteUsage['capacity-test-'+ 'x'.repeat(16*1024*1024)]=0;db.prepare('UPDATE account_state SET json=? WHERE id=1').run(JSON.stringify(s));
  const version=f.service.getAccount().version;throwsCode(()=>f.service.watch({symbol:'sz000001',generation:f.generation}),'STATE_CAPACITY');assert.equal(f.service.getAccount().version,version);assert.deepEqual(f.service.getAccount().watchlist,[]);db.close();
});
test('corrupted existing SQLite account fails closed and never silently creates a fresh balance',t=>{
  const f=fixture(t),db=new DatabaseSync(f.dbPath),row=db.prepare('SELECT json FROM account_state WHERE id=1').get(),s=JSON.parse(row.json);s.cashCents++;
  db.prepare('UPDATE account_state SET json=? WHERE id=1').run(JSON.stringify(s));throwsCode(()=>f.sibling(),'DATABASE_CORRUPT');assert.equal(JSON.parse(db.prepare('SELECT json FROM account_state WHERE id=1').get().json).cashCents,s.cashCents);db.close();
});
test('cached intraday holdings do not pretend to be a current portfolio on the next day or after expiry',async t=>{
  const f=fixture(t);await f.submit();f.tick(91_000);let a=f.service.getAccount();assert.equal(a.valuationComplete,false);assert.equal(a.totalAssets,null);assert.equal(a.holdings[0].price,10);
  f.clock('2026-10-09T02:00:00Z');a=f.service.getAccount();assert.equal(a.valuationComplete,false);
  f.clock('2026-10-09T07:00:00Z');a=f.service.getAccount([f.quote()]);assert.equal(a.valuationComplete,true);
  f.clock('2026-10-10T02:00:00Z');a=f.service.getAccount();assert.equal(a.valuationComplete,true);assert.equal(a.todayProfit,0);
});
test('an actual CNY 290 sell records 15-cent stamp and its exported snapshot restores exactly',async t=>{
  const f=fixture(t);f.fields({price:2.9,ask:2.9,bid:2.9,previous:2.8,lower:2,upper:4});await f.submit({limit:2.9});f.clock('2026-10-09T02:00:00Z');
  const r=await f.submit({id:'stamp-half-cent',side:'sell',limit:2.9});assert.equal(r.account.trades[0].gross,290);assert.equal(r.account.trades[0].stamp,0.15);assert.equal(r.account.trades[0].fees,5.15);
  const snapshot=f.service.exportSnapshot();assert.equal(f.service.inspectSnapshot(snapshot).ok,true);const a=f.service.getAccount();
  const restored=f.service.restore(snapshot,{generation:a.generation,expectedVersion:a.version,confirm:'恢复账户'});assert.equal(restored.totalCash,a.totalCash);assert.equal(restored.realized,a.realized);assert.equal(f.service.diagnostics().ok,true);
});
test('reopen and restore after selling every share report missing daily-baseline symbols and recover exact daily profit',async t=>{
  const f=fixture(t);await f.submit({qty:300});f.clock('2026-10-09T02:00:00Z');await f.submit({id:'sell-all',side:'sell',qty:300});
  const snapshot=f.service.exportSnapshot(),reopened=f.sibling();let a=reopened.getAccount();
  assert.equal(a.holdings.length,0);assert.equal(a.valuationComplete,true);assert.deepEqual(a.missingQuotes,[]);assert.equal(a.todayProfit,null);assert.deepEqual(a.todayMissingQuotes,['sh600000']);
  const version=a.version;a=reopened.getAccount([f.quote()]);assert.equal(a.todayProfit,53.47);assert.deepEqual(a.todayMissingQuotes,[]);assert.equal(a.version,version);
  const before=f.service.getAccount();a=f.service.restore(snapshot,{generation:before.generation,expectedVersion:before.version,confirm:'恢复账户'});
  assert.equal(a.todayProfit,null);assert.deepEqual(a.todayMissingQuotes,['sh600000']);assert.deepEqual(a.missingQuotes,[]);
  a=f.service.getAccount([f.quote()]);assert.equal(a.todayProfit,53.47);assert.deepEqual(a.todayMissingQuotes,[]);assert.equal(f.service.diagnostics().ok,true);
});
test('daily opening valuation accepts only today previous or the immediate prior trading day final close',async t=>{
  const f=fixture(t);await f.submit({qty:300});f.clock('2026-10-09T02:00:00Z');await f.submit({id:'sell-all',side:'sell',qty:300});
  const s=f.sibling();
  const prior={...f.quote(),time:'2026-10-08T07:00:00Z',price:9.8,previous:9.7};let a=s.getAccount([prior]);assert.equal(a.todayProfit,53.47);assert.deepEqual(a.todayMissingQuotes,[]);
  for(const bad of [
    {...prior,time:'2026-10-08T02:00:00Z'}, // Previous day's intraday price is not the final close.
    {...prior,time:'2026-10-08T06:59:00Z'}, // Closing auction has not finished.
    {...prior,time:'2026-09-30T07:00:00Z'}, // Older closing day does not set Oct 9's baseline.
    {...f.quote(),time:'2026-10-10T02:00:00Z'}, // Future day cannot establish the baseline.
    {...f.quote(),previous:null},
  ]){a=s.getAccount([bad]);assert.equal(a.todayProfit,null);assert.deepEqual(a.todayMissingQuotes,['sh600000']);assert.equal(a.valuationComplete,true);}
  a=s.getAccount([f.quote()]);assert.equal(a.todayProfit,53.47);assert.deepEqual(a.todayMissingQuotes,[]);
});
test('capital deposit and withdrawal preserve holdings/trades and exclude flows from total and day profit',async t=>{
  const f=fixture(t);await f.submit({qty:300});let a=f.service.getAccount();const holdings=clone(a.holdings),trades=clone(a.trades),profit=a.totalProfit,day=a.todayProfit;
  a=f.service.adjustCapital({amount:5000,generation:a.generation,expectedVersion:a.version,note:'测试充值'});
  assert.equal(a.initial,100000);assert.equal(a.netDeposits,5000);assert.equal(a.netCapital,105000);assert.equal(a.totalProfit,profit);assert.equal(a.todayProfit,day);assert.deepEqual(a.holdings,holdings);assert.deepEqual(a.trades,trades);
  assert.equal(a.capitalFlows[0].type,'deposit');assert.equal(a.capitalFlows[0].amount,5000);assert.equal(a.capitalFlows[0].note,'测试充值');assert.equal(f.service.listBackups().length,1);
  a=f.service.adjustCapital({amount:-2000,generation:a.generation,expectedVersion:a.version});assert.equal(a.netDeposits,3000);assert.equal(a.netCapital,103000);assert.equal(a.totalProfit,profit);assert.equal(a.todayProfit,day);assert.equal(a.capitalFlows[0].type,'withdrawal');assert.equal(f.service.diagnostics().ok,true);
});
test('capital targets only change cash and an equal target is a no-op',async t=>{
  const f=fixture(t);await f.submit();let a=f.service.getAccount();const qty=a.holdings[0].qty,initial=a.initial,profit=a.totalProfit;
  a=f.service.adjustCapital({targetAssets:200000,generation:a.generation,expectedVersion:a.version});assert.equal(a.totalAssets,200000);assert.equal(a.holdings[0].qty,qty);assert.equal(a.initial,initial);assert.equal(a.totalProfit,profit);assert.equal(a.netCapital,200005.01);
  const version=a.version,flows=a.capitalFlows.length,backups=f.service.listBackups().length;a=f.service.adjustCapital({targetAssets:200000,generation:a.generation,expectedVersion:a.version});assert.equal(a.version,version);assert.equal(a.capitalFlows.length,flows);assert.equal(f.service.listBackups().length,backups);assert.equal(f.service.diagnostics().ok,true);
});
test('capital withdrawals never consume frozen buy cash and allow exactly the available balance',async t=>{
  const f=fixture(t);await f.submit({limit:9.9});let a=f.service.getAccount();const frozen=a.frozenCash;
  throwsCode(()=>f.service.adjustCapital({amount:-(a.cash+0.01),generation:a.generation,expectedVersion:a.version}),'INSUFFICIENT_AVAILABLE_CASH');assert.equal(f.service.getAccount().capitalFlows.length,0);
  a=f.service.adjustCapital({amount:-a.cash,generation:a.generation,expectedVersion:a.version});assert.equal(a.cash,0);assert.equal(a.frozenCash,frozen);assert.equal(a.totalCash,frozen);assert.equal(a.orders[0].status,'pending');
  f.tick();f.fields({price:9.88,ask:9.88});a=await f.service.processPending();assert.equal(a.orders[0].status,'filled');assert.equal(f.service.diagnostics().ok,true);
});
test('capital amount mode works offline; target refuses incomplete valuation and does not silently assume zero holdings value',async t=>{
  const f=fixture(t);await f.submit();f.tick(91_000);let a=f.service.getAccount();assert.equal(a.valuationComplete,false);
  throwsCode(()=>f.service.adjustCapital({targetAssets:200000,generation:a.generation,expectedVersion:a.version}),'VALUATION_INCOMPLETE');
  a=f.service.adjustCapital({amount:500,generation:a.generation,expectedVersion:a.version});assert.equal(a.netDeposits,500);assert.equal(a.totalAssets,null);assert.equal(f.service.diagnostics().ok,true);
});
test('capital retry on the old version cannot deposit twice, and an old generation cannot adjust a restored account',t=>{
  const f=fixture(t),a=f.service.getAccount(),p={amount:1000,generation:a.generation,expectedVersion:a.version};const after=f.service.adjustCapital(p);
  throwsCode(()=>f.service.adjustCapital(p),'VERSION_CONFLICT');assert.equal(f.service.getAccount().totalCash,101000);assert.equal(f.service.getAccount().capitalFlows.length,1);
  const snapshot=f.service.exportSnapshot();f.service.restore(snapshot,{generation:after.generation,expectedVersion:after.version,confirm:'恢复账户'});throwsCode(()=>f.service.adjustCapital({...p,expectedVersion:f.service.getAccount().version}),'GENERATION_CHANGED');
});
test('capital flows before/between/after trades are reconstructed independently and survive restore/reopen',async t=>{
  const f=fixture(t);let a=f.service.getAccount();f.service.adjustCapital({amount:5000,generation:a.generation,expectedVersion:a.version});await f.submit({qty:300});
  a=f.service.getAccount();f.service.adjustCapital({amount:-1000,generation:a.generation,expectedVersion:a.version});f.clock('2026-10-09T02:00:00Z');await f.submit({id:'sell-all',side:'sell',qty:300});
  a=f.service.getAccount();f.service.adjustCapital({amount:2000,generation:a.generation,expectedVersion:a.version});const original=f.service.getAccount(),snapshot=f.service.exportSnapshot();
  assert.equal(snapshot.formatVersion,2);assert.equal(snapshot.account.schema,2);assert.equal(f.service.inspectSnapshot(snapshot).ok,true);assert.equal(original.todayProfit,53.47);
  const restored=f.service.restore(snapshot,{generation:original.generation,expectedVersion:original.version,confirm:'恢复账户'});assert.equal(restored.netDeposits,6000);assert.equal(restored.netCapital,106000);assert.deepEqual(restored.capitalFlows,original.capitalFlows);assert.equal(restored.totalProfit,original.totalProfit);
  const reopened=f.sibling().getAccount([f.quote()]);assert.equal(reopened.todayProfit,53.47);assert.equal(reopened.netCapital,106000);assert.equal(f.service.diagnostics().ok,true);
});
test('zero or negative net capital produces no infinite/NaN return and withdrawals do not erase earned profit',async t=>{
  const f=fixture(t);await f.submit({qty:300});f.clock('2026-10-09T02:00:00Z');f.fields({price:11,bid:11,previous:10});await f.submit({id:'sell-profit',side:'sell',qty:300,limit:11});let a=f.service.getAccount(),profit=a.totalProfit;
  assert.ok(profit>0);a=f.service.adjustCapital({amount:-100000,generation:a.generation,expectedVersion:a.version});assert.equal(a.netCapital,0);assert.equal(a.totalReturn,null);assert.equal(a.totalProfit,profit);
  a=f.service.adjustCapital({amount:-1,generation:a.generation,expectedVersion:a.version});assert.equal(a.netCapital,-1);assert.equal(a.totalReturn,null);assert.equal(a.totalProfit,profit);assert.equal(f.service.diagnostics().ok,true);
});
test('legacy 1.0 SQLite loads without writes and its first mutation backs up the exact old state before upgrade',async t=>{
  const f=fixture(t);await f.submit();const snapshot=f.service.exportSnapshot(),legacy=clone(snapshot.account);legacy.schema=1;delete legacy.capitalFlows;
  const db=new DatabaseSync(f.dbPath);db.prepare('UPDATE account_state SET json=? WHERE id=1').run(JSON.stringify(legacy));const originalJson=db.prepare('SELECT json FROM account_state WHERE id=1').get().json;
  const s=f.sibling();assert.equal(db.prepare('SELECT json FROM account_state WHERE id=1').get().json,originalJson);assert.equal(s.getAccount([f.quote()]).netDeposits,0);assert.equal(s.diagnostics().ok,true);
  s.watch({symbol:'sz000001',generation:legacy.generation,expectedVersion:legacy.version});const b=s.getBackup(s.listBackups()[0].id);assert.equal(b.formatVersion,1);assert.deepEqual(b.account,legacy);assert.equal(s.exportSnapshot().formatVersion,2);assert.equal(s.getAccount().holdings[0].qty,100);assert.equal(s.diagnostics().ok,true);db.close();
});
test('strict legacy snapshots restore into a funded schema2 account without leaking newer flows',async t=>{
  const f=fixture(t);await f.submit();const v2=f.service.exportSnapshot(),legacy=clone(v2);legacy.formatVersion=1;legacy.account.schema=1;delete legacy.account.capitalFlows;const snap=reseal(legacy);
  assert.equal(f.service.inspectSnapshot(snap).ok,true);let a=f.service.getAccount();a=f.service.adjustCapital({amount:5000,generation:a.generation,expectedVersion:a.version});
  const b=f.service.restore(snap,{generation:a.generation,expectedVersion:a.version,confirm:'恢复账户'});assert.equal(b.netDeposits,0);assert.equal(b.capitalFlows.length,0);assert.equal(b.holdings[0].qty,100);assert.equal(b.totalCash,98994.99);assert.equal(f.service.exportSnapshot().account.schema,2);assert.equal(f.service.diagnostics().ok,true);
  const bad=clone(v2);bad.formatVersion=1;assert.equal(f.service.inspectSnapshot(reseal(bad)).ok,false);
});
test('capital backup insertion and balance update roll back together on SQLite failure',t=>{
  const f=fixture(t),a=f.service.getAccount(),db=new DatabaseSync(f.dbPath);db.exec("CREATE TRIGGER capital_refuse_update BEFORE UPDATE ON account_state BEGIN SELECT RAISE(ABORT, 'capital failure injection'); END;");
  assert.throws(()=>f.service.adjustCapital({amount:1000,generation:a.generation,expectedVersion:a.version}),/capital failure injection/);assert.equal(f.service.getAccount().totalCash,a.totalCash);assert.equal(f.service.getAccount().capitalFlows.length,0);assert.equal(f.service.listBackups().length,0);db.close();
});
test('rehashed capital cash, order index, timestamp and amount corruption fail strict snapshot diagnostics',async t=>{
  const f=fixture(t);let a=f.service.getAccount();f.service.adjustCapital({amount:1000,generation:a.generation,expectedVersion:a.version});await f.submit();const snapshot=f.service.exportSnapshot();
  for(const change of [flow=>{flow.beforeCashCents++;},flow=>{flow.afterCashCents++;},flow=>{flow.amountCents++;},flow=>{flow.tradeIndex=2;},flow=>{flow.time='2026-10-08T03:00:00Z';}]){
    const bad=clone(snapshot);change(bad.account.capitalFlows[0]);assert.equal(f.service.inspectSnapshot(reseal(bad)).ok,false);
  }
});
test('capital input requires one mode, baseline and finite cent-precision values',t=>{
  const f=fixture(t),a=f.service.getAccount(),base={generation:a.generation,expectedVersion:a.version};
  for(const amount of [0,NaN,Infinity,0.001,-0.001,'100'])throwsCode(()=>f.service.adjustCapital({...base,amount}),'INVALID_AMOUNT');
  throwsCode(()=>f.service.adjustCapital({...base,amount:1,targetAssets:1000}),'INVALID_AMOUNT');throwsCode(()=>f.service.adjustCapital(base),'INVALID_AMOUNT');
  throwsCode(()=>f.service.adjustCapital({generation:a.generation,amount:1}),'VERSION_CONFLICT');assert.equal(f.service.getAccount().capitalFlows.length,0);
});
test('backward clock cannot create a financially invalid post-funding trade or another capital event',async t=>{
  const f=fixture(t);f.tick(1000);let a=f.service.getAccount();f.service.adjustCapital({amount:1000,generation:a.generation,expectedVersion:a.version});f.clock('2026-10-08T02:00:00Z');
  await rejectsCode(f.submit(),'CLOCK_REVERSED');a=f.service.getAccount();throwsCode(()=>f.service.adjustCapital({amount:1,generation:a.generation,expectedVersion:a.version}),'CLOCK_REVERSED');assert.equal(a.trades.length,0);assert.equal(f.service.diagnostics().ok,true);
});
test('lunch targetAssets rejects an old morning quote and accepts the pause-near 11:29 quote',async t=>{
  const f=fixture(t);f.clock('2026-10-08T03:00:00Z');await f.submit();f.clock('2026-10-08T04:30:00Z');let a=f.service.getAccount();assert.equal(a.valuationComplete,false);
  throwsCode(()=>f.service.adjustCapital({targetAssets:200000,generation:a.generation,expectedVersion:a.version}),'VALUATION_INCOMPLETE');assert.equal(f.service.getAccount().capitalFlows.length,0);
  a=f.service.getAccount([{...f.quote(),time:'2026-10-08T03:29:00Z',fetchedAt:'2026-10-08T03:29:00Z'}]);assert.equal(a.valuationComplete,true);
  a=f.service.adjustCapital({targetAssets:200000,generation:a.generation,expectedVersion:a.version});assert.equal(a.totalAssets,200000);assert.equal(a.capitalFlows.length,1);assert.equal(f.service.diagnostics().ok,true);
});
test('closing-auction targetAssets rejects an old morning quote and accepts a 14:56 quote',async t=>{
  const f=fixture(t);await f.submit();f.clock('2026-10-08T06:58:00Z');let a=f.service.getAccount();assert.equal(a.valuationComplete,false);
  throwsCode(()=>f.service.adjustCapital({targetAssets:200000,generation:a.generation,expectedVersion:a.version}),'VALUATION_INCOMPLETE');assert.equal(f.service.getAccount().capitalFlows.length,0);
  a=f.service.getAccount([{...f.quote(),time:'2026-10-08T06:56:00Z',fetchedAt:'2026-10-08T06:56:00Z'}]);assert.equal(a.valuationComplete,true);
  a=f.service.adjustCapital({targetAssets:200000,generation:a.generation,expectedVersion:a.version});assert.equal(a.totalAssets,200000);assert.equal(f.service.diagnostics().ok,true);
});
test('a legal 100-share main order partially fills 50 shares and the rest can be cancelled with an exact snapshot',async t=>{
  const f=fixture(t);f.fields({askSize:50});let r=await f.submit();assert.equal(r.order.status,'partial');assert.equal(r.order.filledQty,50);assert.equal(r.order.remainingQty,50);assert.equal(r.account.holdings[0].qty,50);assert.equal(r.account.holdings[0].available,0);assert.equal(r.account.fees,5.01);assert.equal(r.account.frozenCash,500);
  r=f.service.cancel({id:'order-1',generation:f.generation});assert.equal(r.order.status,'cancelled');assert.equal(r.order.remainingQty,50);assert.equal(r.account.frozenCash,0);assert.equal(r.account.holdings[0].qty,50);
  const snapshot=f.service.exportSnapshot();assert.equal(f.service.inspectSnapshot(snapshot).ok,true);const a=f.service.getAccount();f.service.restore(snapshot,{generation:a.generation,expectedVersion:a.version,confirm:'恢复账户'});assert.equal(f.service.diagnostics().ok,true);
  f.clock('2026-10-09T02:00:00Z');r=await f.submit({id:'sell-odd-50',generation:f.service.getAccount().generation,side:'sell',qty:50});assert.equal(r.order.status,'filled');assert.equal(r.account.holdings.length,0);assert.equal(f.service.diagnostics().ok,true);
});
test('a legal 100-share ChiNext order fills 50 plus 50 and charges the minimum commission only once',async t=>{
  const f=fixture(t,{symbol:'sz300001'});f.fields({askSize:50});let r=await f.submit();assert.equal(r.order.status,'partial');assert.equal(r.order.filledQty,50);assert.equal(r.account.trades[0].qty,50);
  await rejectsCode(f.submit({id:'invalid-buy',qty:50}),'INVALID_QUANTITY');f.tick();let a=await f.service.processPending();assert.equal(a.orders[0].status,'filled');assert.equal(a.trades.length,2);assert.equal(a.fees,5.01);assert.equal(a.holdings[0].qty,100);assert.equal(a.holdings[0].available,0);
  await rejectsCode(f.submit({id:'same-day-sell',side:'sell',qty:100}),'T_PLUS_ONE');assert.equal(f.service.inspectSnapshot(f.service.exportSnapshot()).ok,true);
  f.clock('2026-10-09T02:00:00Z');r=await f.submit({id:'next-day-sell',side:'sell',qty:100});assert.equal(r.account.holdings.length,0);assert.equal(f.service.diagnostics().ok,true);
});
test('a 250-share main holding can sell its complete 50 odd shares with an integer lot and cannot split the odd residue',async t=>{
  const f=fixture(t);f.fields({askSize:250});let r=await f.submit({qty:300});assert.equal(r.order.filledQty,250);f.service.cancel({id:'order-1',generation:f.generation});
  f.clock('2026-10-09T02:00:00Z');await rejectsCode(f.submit({id:'split-residue',side:'sell',qty:25}),'INVALID_QUANTITY');
  r=await f.submit({id:'sell-150',side:'sell',qty:150});assert.equal(r.order.status,'filled');assert.equal(r.account.holdings[0].qty,100);assert.equal(r.account.holdings[0].available,100);assert.equal(f.service.diagnostics().ok,true);assert.equal(f.service.inspectSnapshot(f.service.exportSnapshot()).ok,true);
});
test('a 250-share ChiNext holding can sell exactly its 50 odd residue and leaves 200 shares',async t=>{
  const f=fixture(t,{symbol:'sz300001'});f.fields({askSize:250});await f.submit({qty:300});f.service.cancel({id:'order-1',generation:f.generation});f.clock('2026-10-09T02:00:00Z');
  await rejectsCode(f.submit({id:'oversell',side:'sell',qty:350}),'T_PLUS_ONE');await rejectsCode(f.submit({id:'split-residue',side:'sell',qty:25}),'INVALID_QUANTITY');
  const r=await f.submit({id:'sell-50',side:'sell',qty:50});assert.equal(r.order.status,'filled');assert.equal(r.account.holdings[0].qty,200);assert.equal(f.service.diagnostics().ok,true);assert.equal(f.service.inspectSnapshot(f.service.exportSnapshot()).ok,true);
});

test('STAR depositary receipts can be watched, persisted and removed without accepting an index or malformed code',t=>{
  const f=fixture(t,{symbol:'sh689009'});assert.equal(stockBoard('sh689009'),'star');let a=f.service.getAccount();
  a=f.service.watch({symbol:'sh689009',expectedVersion:a.version,generation:a.generation});assert.deepEqual(a.watchlist,['sh689009']);assert.deepEqual(f.sibling().getAccount().watchlist,a.watchlist);
  const version=a.version;a=f.service.watch({symbol:'sh689009',expectedVersion:version,generation:a.generation});assert.equal(a.version,version);assert.deepEqual(a.watchlist,['sh689009']);
  for(const symbol of ['sh68900','sh687001','sh000001','sector:bank'])throwsCode(()=>f.service.watch({symbol,generation:a.generation}),'INVALID_SYMBOL');
  assert.deepEqual(f.service.getAccount().watchlist,['sh689009']);a=f.service.watch({symbol:'sh689009',remove:true,expectedVersion:a.version,generation:a.generation});assert.deepEqual(a.watchlist,[]);assert.equal(f.service.diagnostics().ok,true);
});

test('STAR CDR limit orders accept 200, 201 and the 100000-unit boundary with unchanged simulator fees',async t=>{
  const f=fixture(t,{symbol:'sh689009',initial:2000000});
  for(const qty of [200,201,100000]) {
    const r=await f.submit({id:`cdr-valid-${qty}`,qty});assert.equal(r.order.status,'filled');assert.equal(r.order.qty,qty);assert.equal(r.order.filledQty,qty);assert.equal(r.account.trades[0].qty,qty);
    const fee=cumulativeFees(qty*1000,'buy');assert.equal(r.account.trades[0].commission,fee.commission/100);assert.equal(r.account.trades[0].transfer,fee.transfer/100);assert.equal(r.account.trades[0].stamp,0);
  }
  const before=f.service.getAccount();
  for(const qty of [100,199,100001,200.5,0,NaN])await assert.rejects(f.submit({id:`cdr-invalid-${qty}`,qty}),error=>{assert.equal(error.code,'INVALID_QUANTITY');assert.doesNotMatch(error.message,/股/);return true;});
  const a=f.service.getAccount();assert.equal(a.version,before.version);assert.equal(a.totalCash,before.totalCash);assert.equal(a.orders.length,3);assert.equal(a.holdings[0].qty,100401);assert.equal(a.holdings[0].available,0);
  const snapshot=f.service.exportSnapshot();assert.equal(f.service.inspectSnapshot(snapshot).ok,true);const b=f.service.restore(snapshot,{expectedVersion:a.version,generation:a.generation,confirm:'恢复账户'});assert.equal(b.holdings[0].qty,100401);assert.equal(b.fees,a.fees);assert.equal(f.service.diagnostics().ok,true);
});

test('STAR CDR respects source daily limits and the buy and sell price cages',async t=>{
  const f=fixture(t,{symbol:'sh689009'});f.fields({upper:10.1,lower:9.9});
  await rejectsCode(f.submit({id:'cdr-source-upper',qty:200,limit:10.11}),'PRICE_OUT_OF_RANGE');assert.equal(f.service.getAccount().orders.length,0);
  f.fields({upper:11,lower:9});await rejectsCode(f.submit({id:'cdr-buy-cage',qty:200,limit:10.21}),'PRICE_CAGE');
  let r=await f.submit({id:'cdr-buy-cage-edge',qty:200,limit:10.2});assert.equal(r.order.status,'filled');assert.equal(r.account.trades[0].price,10);
  f.clock('2026-10-09T02:00:00Z');f.fields({lower:9.9});await rejectsCode(f.submit({id:'cdr-source-lower',side:'sell',qty:200,limit:9.89}),'PRICE_OUT_OF_RANGE');
  f.fields({lower:9});await rejectsCode(f.submit({id:'cdr-sell-cage',side:'sell',qty:200,limit:9.79}),'PRICE_CAGE');
  r=await f.submit({id:'cdr-sell-cage-edge',side:'sell',qty:200,limit:9.8});assert.equal(r.order.status,'filled');assert.equal(r.account.trades[0].price,10);assert.equal(r.account.holdings.length,0);assert.equal(r.account.orders.length,2);assert.equal(f.service.diagnostics().ok,true);
});

test('STAR CDR T+1 and an odd one-unit balance survive reopen and sell out exactly',async t=>{
  const f=fixture(t,{symbol:'sh689009'});await f.submit({id:'cdr-t1-buy',qty:201});await rejectsCode(f.submit({id:'cdr-t1-sell',side:'sell',qty:201}),'T_PLUS_ONE');
  assert.equal(f.sibling().getAccount().holdings[0].available,0);f.clock('2026-10-09T02:00:00Z');await rejectsCode(f.submit({id:'cdr-invalid-small-sell',side:'sell',qty:100}),'INVALID_QUANTITY');
  let r=await f.submit({id:'cdr-sell-200',side:'sell',qty:200});assert.equal(r.account.holdings[0].qty,1);assert.equal(r.account.holdings[0].available,1);assert.equal(f.sibling().getAccount().holdings[0].qty,1);
  r=await f.submit({id:'cdr-sell-last-unit',side:'sell',qty:1});assert.equal(r.order.status,'filled');assert.equal(r.account.holdings.length,0);assert.equal(r.account.trades[0].qty,1);assert.equal(f.service.diagnostics().ok,true);assert.equal(f.service.inspectSnapshot(f.service.exportSnapshot()).ok,true);
});

test('a partially filled CDR holding below 200 units must sell its whole available balance',async t=>{
  const f=fixture(t,{symbol:'sh689009'});f.fields({askSize:150});let r=await f.submit({id:'cdr-partial-buy',qty:200});assert.equal(r.order.status,'partial');assert.equal(r.order.filledQty,150);assert.equal(r.order.remainingQty,50);
  f.service.cancel({id:r.order.id,generation:f.generation});f.clock('2026-10-09T02:00:00Z');const before=f.service.getAccount();assert.equal(before.holdings[0].available,150);
  await rejectsCode(f.submit({id:'cdr-split-small-balance',side:'sell',qty:100}),'INVALID_QUANTITY');assert.equal(f.service.getAccount().totalCash,before.totalCash);assert.equal(f.service.getAccount().holdings[0].qty,150);
  r=await f.submit({id:'cdr-all-small-balance',side:'sell',qty:150});assert.equal(r.order.status,'filled');assert.equal(r.account.holdings.length,0);assert.equal(f.service.diagnostics().ok,true);
});

test('688 STAR stocks and BSE stocks retain their original limits and unit increments',async t=>{
  for(const [symbol,min,extra,max] of [['sh688001',200,201,100000],['bj920001',100,101,1000000]]) {
    const f=fixture(t,{symbol});let r=await f.submit({id:`${symbol}-minimum`,qty:min});assert.equal(r.order.status,'filled');f.tick();r=await f.submit({id:`${symbol}-extra`,qty:extra});assert.equal(r.order.status,'filled');
    await rejectsCode(f.submit({id:`${symbol}-too-small`,qty:min-1}),'INVALID_QUANTITY');await rejectsCode(f.submit({id:`${symbol}-too-large`,qty:max+1}),'INVALID_QUANTITY');
    f.clock('2026-10-09T02:00:00Z');await f.submit({id:`${symbol}-sell-all`,side:'sell',qty:min+extra});assert.equal(f.service.getAccount().holdings.length,0);assert.equal(f.service.diagnostics().ok,true);
  }
});

test('a reset without manual export can restore its automatic backup and then recover the reset account again',async t=>{
  const f=fixture(t,{symbol:'sh689009'});let a=f.service.getAccount();a=f.service.watch({symbol:'sh689009',generation:a.generation,expectedVersion:a.version});a=f.service.watch({symbol:'bj920001',generation:a.generation,expectedVersion:a.version});
  await f.submit({id:'automatic-backup-filled',qty:201});a=f.service.getAccount();f.service.adjustCapital({amount:1234.56,expectedVersion:a.version,generation:a.generation});f.tick();f.fields({askSize:50});await f.submit({id:'automatic-backup-partial',qty:200});
  const original=f.service.getAccount(),count=f.service.listBackups().length;assert.equal(original.holdings[0].qty,251);assert(original.frozenCash>0);assert.equal(original.capitalFlows.length,1);
  const reset=f.service.reset({nickname:'自动备份验收重置',initial:33333,clearWatchlist:true,expectedVersion:original.version,generation:original.generation,confirm:'重置账户'});assert.equal(reset.totalAssets,33333);assert.deepEqual(reset.watchlist,[]);assert.equal(reset.orders.length,0);assert.equal(reset.capitalFlows.length,0);
  const metadata=f.service.listBackups();assert.equal(metadata.length,count+1);assert.equal(metadata[0].version,original.version);assert.equal(metadata[0].generation,original.generation);const backup=f.service.getBackup(metadata[0].id);assert.equal(f.service.inspectSnapshot(backup).ok,true);assert.deepEqual(backup.account.watchlist,original.watchlist);
  throwsCode(()=>f.service.restore(backup,{expectedVersion:reset.version,generation:reset.generation,confirm:'取消'}),'CONFIRMATION_REQUIRED');throwsCode(()=>f.service.restore(backup,{expectedVersion:reset.version-1,generation:reset.generation,confirm:'恢复账户'}),'VERSION_CONFLICT');assert.equal(f.service.listBackups().length,count+1);assert.equal(f.service.getAccount().version,reset.version);assert.equal(f.service.getAccount().cash,33333);
  const restored=f.service.restore(backup,{expectedVersion:reset.version,generation:reset.generation,confirm:'恢复账户'});assert.notEqual(restored.generation,reset.generation);assert.notEqual(restored.generation,original.generation);assert.equal(restored.version,reset.version+1);assert.equal(restored.totalCash,original.totalCash);assert.equal(restored.frozenCash,original.frozenCash);assert.equal(restored.holdings[0].qty,original.holdings[0].qty);assert.equal(restored.holdings[0].cost,original.holdings[0].cost);assert.deepEqual(restored.watchlist,original.watchlist);assert.deepEqual(restored.capitalFlows,original.capitalFlows);assert.equal(restored.fees,original.fees);
  assert.deepEqual(restored.trades,original.trades);assert.deepEqual(restored.orders.map(({generation,...order})=>order),original.orders.map(({generation,...order})=>order));assert(restored.orders.every(order=>order.generation===restored.generation));throwsCode(()=>f.service.cancel({id:'automatic-backup-partial',generation:original.generation}),'GENERATION_CHANGED');
  const resetBackupMeta=f.service.listBackups()[0];assert.equal(f.service.listBackups().length,count+2);assert.equal(resetBackupMeta.generation,reset.generation);const resetBackup=f.service.getBackup(resetBackupMeta.id);assert.equal(f.service.inspectSnapshot(resetBackup).ok,true);assert.equal(resetBackup.account.cashCents,3333300);
  const roundtrip=f.service.restore(resetBackup,{expectedVersion:restored.version,generation:restored.generation,confirm:'恢复账户'});assert.notEqual(roundtrip.generation,restored.generation);assert.equal(roundtrip.totalAssets,33333);assert.equal(roundtrip.orders.length,0);assert.equal(roundtrip.holdings.length,0);assert.equal(roundtrip.trades.length,0);assert.equal(roundtrip.capitalFlows.length,0);assert.deepEqual(roundtrip.watchlist,[]);assert.equal(f.sibling().getAccount().cash,33333);assert.equal(f.service.diagnostics().ok,true);
});

test('processPending expires identified prior-day pending and partial orders before a new crossing quote can fill them',async t=>{
  let calls=0;const f=fixture(t,{provider:async symbols=>{calls++;return symbols.map(symbol=>f.quote(symbol));}});
  const pendingId='expiry-original-pending',partialId='expiry-original-partial';await f.submit({id:pendingId,limit:9.9});f.tick();f.fields({askSize:50});await f.submit({id:partialId});const before=f.service.getAccount();assert(before.frozenCash>0);assert.equal(before.trades.length,1);assert.equal(calls,2);
  f.clock('2026-10-09T02:00:00Z');f.fields({ask:9.8,price:9.8,askSize:1000000});const expired=await f.service.processPending();assert.equal(calls,2);assert.equal(expired.orders.find(order=>order.id===pendingId).status,'expired');const partial=expired.orders.find(order=>order.id===partialId);assert.equal(partial.status,'expired');assert.equal(partial.filledQty,50);assert.equal(partial.remainingQty,50);
  assert.equal(expired.frozenCash,0);assert.equal(expired.totalCash,before.totalCash);assert.equal(expired.cash,before.totalCash);assert.equal(expired.trades.length,1);assert.equal(expired.holdings[0].qty,50);assert.equal(expired.holdings[0].available,50);
  const replay=await f.submit({id:pendingId,limit:9.9});assert.equal(replay.replayed,true);assert.equal(replay.order.status,'expired');assert.equal(calls,2);assert.equal(replay.account.version,expired.version);
  const fresh=await f.submit({id:'expiry-new-day-order',limit:9.9});assert.equal(fresh.order.status,'filled');assert.equal(fresh.account.orders.length,3);assert.equal(fresh.account.trades.length,2);assert.equal(calls,3);assert.equal(f.sibling().getOrder({id:pendingId,generation:f.generation}).order.status,'expired');assert.equal(f.service.diagnostics().ok,true);
});

test('processPending across the weekend releases both sell-share and buy-cash reservations while retaining terminal IDs',async t=>{
  const f=fixture(t);await f.submit({id:'expiry-settled-position',qty:200});f.clock('2026-10-09T02:00:00Z');await f.submit({id:'expiry-friday-sell',side:'sell',limit:10.1});await f.submit({id:'expiry-friday-buy',limit:9.9});let a=f.service.getAccount();assert.equal(a.holdings[0].frozen,100);assert.equal(a.holdings[0].available,100);assert(a.frozenCash>0);const beforeCash=a.totalCash;
  f.clock('2026-10-12T02:00:00Z');a=await f.service.processPending();assert.equal(a.orders.find(order=>order.id==='expiry-friday-sell').status,'expired');assert.equal(a.orders.find(order=>order.id==='expiry-friday-buy').status,'expired');assert.equal(a.orders.find(order=>order.id==='expiry-settled-position').status,'filled');assert.equal(a.totalCash,beforeCash);assert.equal(a.frozenCash,0);assert.equal(a.holdings[0].frozen,0);assert.equal(a.holdings[0].available,200);assert.equal(a.trades.length,1);assert.equal(a.orders.length,3);assert.equal(f.service.diagnostics().ok,true);
});

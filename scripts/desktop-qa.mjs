// Electron integration tests: the actual production main/preload/protocol and renderer.
// Run using the Electron binary; this script is not shipped in the application.
import { app, BrowserWindow, dialog } from 'electron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { packagedPaths } from './package-paths.mjs';
import { DatabaseSync } from 'node:sqlite';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const directory=path.join(root,'.qa',`electron-integration-${Date.now()}`);
// Production startup must create the fresh profile itself.
await mkdir(path.dirname(directory),{recursive:true});
process.argv.push(`--data-dir=${directory}`);
const backupFile=path.join(directory,'backup.json');
dialog.showSaveDialog=async()=>({canceled:false,filePath:backupFile});
dialog.showOpenDialog=async()=>({canceled:false,filePaths:[backupFile]});
dialog.showErrorBox=(title,content)=>console.error(title,content);
const checks=[], begun=Date.now();let window, originalAccountSnapshot;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(fn,timeout=45000){const start=Date.now();while(Date.now()-start<timeout){const v=await fn();if(v)return v;await pause(150);}throw Error('Timed out waiting for application');}
async function evaluate(code){return window.webContents.executeJavaScript(code,true);}
async function call(method,payload){return evaluate(`(async()=>{const {createDesktopApi}=await import('trading://app/helpers.js');return createDesktopApi(window.trading)[${JSON.stringify(method)}](${JSON.stringify(payload??null)})})()`);}
async function check(label,fn){await fn();checks.push({label,ok:true});console.log(`PASS ${label}`);}
async function click(selector){await evaluate(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node)throw Error('Missing click target: '+${JSON.stringify(selector)});node.click()})()`);}
async function pageText(){return evaluate(`document.querySelector('#content').innerText`);}
async function screenshot(name){
 window.show();window.focus();
 await pause(300);
 await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())))`);
 await writeFile(path.join(directory,name),(await window.webContents.capturePage()).toPNG());
}
const installedRoot=process.argv.find(a=>a.startsWith('--installed-root='))?.slice(17);
await import(installedRoot?pathToFileURL(path.join(packagedPaths(installedRoot).archive,'desktop','main.mjs')).href:'../desktop/main.mjs');
async function exportAccountSnapshot() {
 assert.equal((await call('backup')).ok,true);
 return JSON.parse(await readFile(backupFile,'utf8'));
}
function resetBackup(snapshot) {
 // Only inspect the disposable profile selected by this script, never user data.
 assert(directory.startsWith(path.join(root,'.qa')+path.sep));
 const database=new DatabaseSync(path.join(directory,'account.sqlite'),{readOnly:true});
 try {
  const row=database.prepare('SELECT snapshot FROM account_backups WHERE version=? AND generation=? ORDER BY rowid DESC LIMIT 1').get(snapshot.account.version,snapshot.account.generation);
  assert(row,'Reset must save the complete previous account automatically.');
  const backup=JSON.parse(row.snapshot);
  assert.deepEqual(backup.account,snapshot.account);
  return backup;
 } finally { database.close(); }
}
async function restoreThroughUi(snapshot) {
 await writeFile(backupFile,JSON.stringify(snapshot));
 await click('.main-nav [data-page="account"]');
 await waitFor(()=>evaluate(`!!document.querySelector('[data-action="preview-restore"]:not(:disabled)')`));
 await click('[data-action="preview-restore"]');
 await waitFor(()=>evaluate(`document.querySelector('#app-dialog').open && !!document.querySelector('[data-form="restore"]')`));
 await evaluate(`document.querySelector('#restore-confirm').value='恢复账户';document.querySelector('[data-form="restore"]').requestSubmit()`);
 await waitFor(async()=>await evaluate(`!document.querySelector('#app-dialog').open`) && (await call('account')).nickname===snapshot.account.nickname);
}
async function openReset(clearWatchlist=false) {
 await click('.main-nav [data-page="account"]');
 await waitFor(()=>evaluate(`!!document.querySelector('[data-action="reset"]:not(:disabled)')`));
 await click('[data-action="reset"]');
 await waitFor(()=>evaluate(`document.querySelector('#app-dialog').open && !!document.querySelector('[data-form="reset"] #reset-clear-watchlist')`));
 const option=await evaluate(`(()=>{const input=document.querySelector('#reset-clear-watchlist');return {type:input.type,name:input.name,checked:input.checked}})()`);
 assert.deepEqual(option,{type:'checkbox',name:'clearWatchlist',checked:false});
 if(clearWatchlist) await click('#reset-clear-watchlist');
 await evaluate(`document.querySelector('#reset-name').value='隔离新账户';document.querySelector('#reset-initial').value='20000';document.querySelector('#reset-confirm').value='重置账户'`);
}
async function submitReset(before) {
 await evaluate(`document.querySelector('[data-form="reset"]').requestSubmit()`);
 const reset=await waitFor(async()=>{const a=await call('account');return a.generation!==before.generation && await evaluate(`!document.querySelector('#app-dialog').open`)?a:null;});
 assert.equal(reset.cash,20000);assert.equal(reset.initial,20000);assert.equal(reset.netCapital,20000);
 assert.equal(reset.netDeposits,0);assert.equal(reset.capitalFlows.length,0);
 assert.equal(reset.holdings.length,0);assert.equal(reset.trades.length,0);assert.equal(reset.orders.length,0);
 assert.equal(reset.fees,0);assert.equal(reset.realized,0);assert.notEqual(reset.generation,before.generation);
 return reset;
}
async function resetFixtureSnapshot() {
 // A separately labelled in-memory fixture makes clearing non-empty trades and
 // holdings meaningful on a weekend. Market pages still use production sources.
 const {createAccountService}=await import(installedRoot?pathToFileURL(path.join(packagedPaths(installedRoot).archive,'core','account-service.mjs')).href:'../core/account-service.mjs');
 const time=new Date('2026-10-08T02:00:00Z');
 const service=createAccountService({dbPath:':memory:',now:()=>time,quoteProvider:async symbols=>symbols.map(symbol=>({symbol,type:'stock',name:'平安银行',board:'main',price:10,previous:9.8,ask:10,bid:10,askSize:100000,bidSize:100000,upper:11,lower:9,time:time.toISOString(),fetchedAt:time.toISOString(),tradeable:true,source:'isolated-desktop-reset-fixture'}))});
 try {
  let a=service.setup({nickname:'隔离桌面验收账户',initial:10000});
  a=service.watch({symbol:'sz000001',generation:a.generation,expectedVersion:a.version});
  a=service.adjustCapital({amount:777.77,generation:a.generation,expectedVersion:a.version});
  await service.submit({id:'isolated-desktop-reset-trade',generation:a.generation,symbol:'sz000001',side:'buy',qty:100,limit:10});
  const snapshot=service.exportSnapshot();
  assert.equal(snapshot.account.trades.length,1);assert.equal(snapshot.account.lots.length,1);assert.equal(snapshot.account.capitalFlows.length,1);
  return snapshot;
 } finally { service.close(); }
}
async function run(){try{
 await app.whenReady();
 window=await waitFor(()=>BrowserWindow.getAllWindows().find(w=>!w.isDestroyed()));
 await waitFor(()=>evaluate(`!!window.trading && !!document.querySelector('#content h1') && document.querySelector('#content h1').textContent==='市场行情'`).catch(()=>false));
 await check('真实 Electron 自定义协议、受限 preload 与隔离渲染器',async()=>{assert.equal(window.webContents.getURL(),'trading://app/index.html');assert.equal(await evaluate(`typeof require`),'undefined');assert.equal(await evaluate(`typeof process`),'undefined');const prefs=window.webContents.getLastWebPreferences();assert.equal(prefs.contextIsolation,true);assert.equal(prefs.sandbox,true);assert.equal(prefs.nodeIntegration,false);assert.equal(await evaluate(`typeof window.trading.account`),'function');});
 await check('首启空账户与创建账户持久化接口',async()=>{assert.equal((await call('account')).initialized,false);await call('setup',{nickname:'隔离桌面验收账户',initial:10000});const a=await call('account');assert.equal(a.cash,10000);assert.equal(a.holdings.length,0);assert.equal(a.trades.length,0);await evaluate(`const d=document.querySelector('#app-dialog'); d.dataset.mandatory='false'; d.close()`);await click('.main-nav [data-page="market"]');});
 await check('实际联网完整沪深京目录及首页自动加载',async()=>{const result=await waitFor(async()=>{const r=await call('marketList',{kind:'stocks',pageSize:100,sort:'code'});return r.total>5000?r:null;},60000);assert(result.items.length===100);for(const market of ['sh','sz','bj'])assert((await call('marketList',{market})).total>0);await waitFor(async()=>{const t=await pageText();return t.includes('条行情')&&!t.includes('0 条行情')&&t.includes('热门股票');});const a=await evaluate(`Array.from(document.querySelectorAll('#content h1')).map(x=>x.textContent)`);assert.deepEqual(a,['市场行情']);assert(!(await pageText()).includes('个人账户'));});
 await check('首页加减自选不误跳详情，更多进入独立列表且详情可返回',async()=>{
  await waitFor(()=>evaluate(`!!document.querySelector('.hot-table [data-action="watch-add"]')`));
  const symbol=await evaluate(`document.querySelector('.hot-table [data-action="watch-add"]').dataset.symbol`);
  await click(`.hot-table [data-action="watch-add"][data-symbol="${symbol}"]`);
  await waitFor(async()=>(await call('account')).watchlist.includes(symbol));
  await waitFor(()=>evaluate(`!!document.querySelector('.hot-table [data-action="watch-remove"]')`));
  assert((await pageText()).startsWith('市场行情'));
  await click(`.hot-table [data-action="watch-remove"][data-symbol="${symbol}"]`);
  await waitFor(async()=>!(await call('account')).watchlist.includes(symbol));
  await click('[data-action="list-kind"][data-kind="hot"]');
  await waitFor(()=>evaluate(`document.querySelector('#content h1')?.textContent==='热门股票' && !!document.querySelector('tbody .stock-link')`));
  assert(!(await pageText()).includes('市场涨跌概况'));
  await click('tbody .stock-link');await waitFor(async()=>(await pageText()).includes('五档盘口'));
  await click('[data-action="detail-back"]');assert.equal(await evaluate(`document.querySelector('#content h1').textContent`),'热门股票');
  await click('[data-action="list-back"]');assert.equal(await evaluate(`document.querySelector('#content h1').textContent`),'市场行情');
 });
 await check('独立全A列表搜索筛选、翻页与股票详情返回保持页码',async()=>{
  await click('[data-action="list-kind"][data-kind="stocks"]');
  await waitFor(()=>evaluate(`document.querySelector('#content h1')?.textContent==='全部A股' && !!document.querySelector('[data-action="list-page"][data-page="2"]:not(:disabled)')`));
  await click('[data-action="list-page"][data-page="2"]');await waitFor(async()=>/第 2 \/ /.test(await pageText()) && await evaluate(`!!document.querySelector('tbody .stock-link') && !document.querySelector('[data-action="reload-list"]').disabled`));
  await click('tbody .stock-link');await waitFor(async()=>(await pageText()).includes('五档盘口'));await click('[data-action="detail-back"]');assert(/第 2 \/ /.test(await pageText()));
  await click('[data-action="list-market"][data-market="bj"]');await waitFor(async()=>(await pageText()).includes('北交所')&&/第 1 \/ /.test(await pageText())&&await evaluate(`!!document.querySelector('tbody .stock-link') && !document.querySelector('[data-action="reload-list"]').disabled`));
  const markets=await evaluate(`Array.from(document.querySelectorAll('tbody .stock-code')).map(n=>n.innerText)`);assert(markets.length>0&&markets.every(n=>n.includes('北交所')));
  await click('[data-action="list-market"][data-market="all"]');
  await evaluate(`const q=document.querySelector('#market-search');q.value='贵州茅台';q.dispatchEvent(new Event('input',{bubbles:true}))`);
  await waitFor(()=>evaluate(`document.querySelectorAll('tbody .stock-link').length===1 && document.querySelector('tbody .stock-link').innerText.includes('贵州茅台')`));
  await click('[data-action="list-back"]');assert.equal(await evaluate(`document.querySelector('#content h1').textContent`),'市场行情');
 });
 await check('超过300项的报价请求分批返回且股票与指数可区分',async()=>{const symbols=[];for(let page=1;page<=4;page++)symbols.push(...(await call('marketList',{kind:'stocks',page,pageSize:100,sort:'code'})).items.map(q=>q.symbol));assert.equal(symbols.length,400);const result=await call('quotes',{symbols});assert(result.items.length>300);assert(result.items.every(q=>q.type==='stock'));const collision=await call('quotes',{symbols:['sh000001','sz000001']});assert.equal(collision.items.find(q=>q.symbol==='sh000001').type,'index');assert.equal(collision.items.find(q=>q.symbol==='sz000001').type,'stock');});
 await check('自选增加、独立页面与详情四周期接口',async()=>{const a=await call('account');await call('watch',{symbol:'sz000001',generation:a.generation,expectedVersion:a.version});await click('.main-nav [data-page="watch"]');await waitFor(async()=>(await pageText()).includes('平安银行'));assert(!(await pageText()).includes('市场行情'));await click('[data-action="detail"][data-symbol="sz000001"]');await waitFor(async()=>(await pageText()).includes('五档盘口'));for(const [kind,label] of [['minute','分时'],['day','日K'],['week','周K'],['month','月K']]){await click(`[data-action="chart-kind"][data-kind="${kind}"]`);const h=await call('history',{symbol:'sz000001',kind});assert(h.items.length>0,label);} });
 await check('四周期价格与量柱联动鼠标竖线、真实数值、键盘和离开清除',async()=>{
  for(const kind of ['minute','day','week','month']){
   await click(`[data-action="chart-kind"][data-kind="${kind}"]`);
   await waitFor(()=>evaluate(`!!document.querySelector('[data-interactive-chart] svg[data-chart-kind="${kind}"] .chart-volume-bar')`));
   window.show();window.focus();await pause(250);
   const history=await call('history',{symbol:'sz000001',kind});
   const target=await evaluate(`(()=>{const svg=document.querySelector('[data-interactive-chart] svg'),bars=svg.querySelectorAll('.chart-volume-bar'),bar=bars[Math.floor(bars.length/2)],p=svg.createSVGPoint(),m=svg.getScreenCTM();p.x=Number(bar.dataset.chartX);p.y=Number(svg.dataset.priceTop)+70;const price=p.matrixTransform(m);p.y=(Number(svg.dataset.volumeTop)+Number(svg.dataset.volumeBottom))/2;const volume=p.matrixTransform(m);return{x:Number(bar.dataset.chartX),index:Number(bar.dataset.chartIndex),volume:Number(bar.dataset.volume),price:{x:price.x,y:price.y},volumePosition:{x:volume.x,y:volume.y}}})()`);
   window.webContents.sendInputEvent({type:'mouseMove',x:Math.round(target.price.x),y:Math.round(target.price.y)});
   await waitFor(()=>evaluate(`document.querySelector('.chart-crosshair')?.getAttribute('visibility')==='visible' && Number(document.querySelector('.chart-crosshair-line').getAttribute('x1'))===${JSON.stringify(target.x)} && !document.querySelector('.chart-tooltip').hidden`));
   const tooltip=await evaluate(`document.querySelector('.chart-tooltip').innerText`);
   const expected=history.items[target.index];assert(expected);assert.equal(target.volume,expected.volume);
   assert(tooltip.includes(expected.price.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})));
   assert(tooltip.includes(expected.volume.toLocaleString('zh-CN',{maximumFractionDigits:0})+' 股'));
   if(kind!=='minute')for(const label of ['开盘','最高','最低','收盘'])assert(tooltip.includes(label));
   const line=await evaluate(`(()=>{const svg=document.querySelector('[data-interactive-chart] svg'),l=svg.querySelector('.chart-crosshair-line');return{x1:l.getAttribute('x1'),x2:l.getAttribute('x2'),y1:Number(l.getAttribute('y1')),y2:Number(l.getAttribute('y2')),bottom:Number(svg.dataset.volumeBottom)}})()`);
   assert.equal(line.x1,line.x2);assert.equal(line.y2,line.bottom);assert(line.y1<line.y2);
   window.webContents.sendInputEvent({type:'mouseMove',x:Math.round(target.volumePosition.x),y:Math.round(target.volumePosition.y)});
   await pause(100);assert.equal(await evaluate(`document.querySelector('.chart-tooltip').innerText`),tooltip);
   let current=await call('account');await call('watch',{symbol:'sh600000',generation:current.generation,expectedVersion:current.version});
   await pause(250);assert.equal(await evaluate(`document.querySelector('.chart-tooltip').innerText`),tooltip);assert.equal(await evaluate(`document.querySelector('.chart-tooltip').hidden`),false);
   current=await call('account');await call('watch',{symbol:'sh600000',remove:true,generation:current.generation,expectedVersion:current.version});
   await pause(250);assert.equal(await evaluate(`document.querySelector('.chart-tooltip').innerText`),tooltip);
   await screenshot(`chart-${kind}.png`);
   window.webContents.sendInputEvent({type:'mouseMove',x:2,y:2});
   await waitFor(()=>evaluate(`document.querySelector('.chart-tooltip').hidden`));
   await evaluate(`document.querySelector('[data-interactive-chart]').focus()`);
   window.webContents.sendInputEvent({type:'keyDown',keyCode:'End'});window.webContents.sendInputEvent({type:'keyUp',keyCode:'End'});
   await waitFor(()=>evaluate(`!document.querySelector('.chart-tooltip').hidden`));
   window.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});window.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
   await waitFor(()=>evaluate(`document.querySelector('.chart-tooltip').hidden`));
  }
 });
 await check('休市下单拒绝通过 IPC 保留业务错误且不改变资金',async()=>{const before=await call('account');const result=await evaluate(`(async()=>{const {createDesktopApi}=await import('trading://app/helpers.js');try{await createDesktopApi(window.trading).submit(${JSON.stringify({id:'desktop-weekend-order',generation:before.generation,symbol:'sz000001',side:'buy',qty:100,limit:10})});return null;}catch(e){return{message:e.message,code:e.code};}})()`);assert(result);assert.equal(result.code,'MARKET_CLOSED');assert(String(result.message).includes('休市'));const after=await call('account');assert.equal(after.version,before.version);assert.equal(after.cash,before.cash);assert.equal(after.trades.length,0);});
 await check('交易五子页面、账户指标及账户快捷入口可实际切换',async()=>{await click('.main-nav [data-page="trade"]');const tabs=[['buy','买入股票'],['sell','卖出股票'],['orders','委托记录'],['holdings','当前持仓'],['trades','成交记录']];for(const [tab,title] of tabs){await click(`[data-action="trade-tab"][data-tab="${tab}"]`);assert((await pageText()).includes(title));}await click('.main-nav [data-page="account"]');await waitFor(async()=>(await pageText()).includes('隔离桌面验收账户'));assert((await pageText()).includes('总资产'));assert((await pageText()).includes('净投入收益率'));assert.equal((await call('diagnostics')).ok,true);for(const [tab,title] of tabs){await click('.main-nav [data-page="account"]');await waitFor(()=>evaluate(`!!document.querySelector('#content [data-action="trade-tab"]') && !document.querySelector('#content [data-action="trade-tab"]').disabled`));await click(`#content [data-action="trade-tab"][data-tab="${tab}"]`);assert((await pageText()).includes(title));}});
 await check('实际桌面资金对话框、增减现金、旧版本防重复且资金不计收益',async()=>{
  await click('.main-nav [data-page="account"]');await waitFor(()=>evaluate(`!!document.querySelector('[data-action="capital"]') && !document.querySelector('[data-action="capital"]').disabled`));
  await click('[data-action="capital"]');await waitFor(()=>evaluate(`!!document.querySelector('#capital-value')`));
  await screenshot('capital-settings.png');
  await evaluate(`document.querySelector('#capital-value').value='25000';document.querySelector('#app-dialog form').requestSubmit()`);
  await waitFor(async()=>(await call('account')).totalAssets===25000&&await evaluate(`!document.querySelector('#app-dialog').open`));
  let a=await call('account');assert.equal(a.netCapital,25000);assert.equal(a.totalProfit,0);assert.equal(a.capitalFlows.length,1);
  const once={amount:-5000,generation:a.generation,expectedVersion:a.version};await call('adjustCapital',once);
  const replay=await evaluate(`(async()=>{const {createDesktopApi}=await import('trading://app/helpers.js');try{await createDesktopApi(window.trading).adjustCapital(${JSON.stringify(once)});return null;}catch(e){return {code:e.code};}})()`);assert.equal(replay.code,'VERSION_CONFLICT');
  a=await call('account');assert.equal(a.totalAssets,20000);assert.equal(a.capitalFlows.length,2);assert.equal(a.totalProfit,0);
  await call('adjustCapital',{amount:-10000,generation:a.generation,expectedVersion:a.version});a=await call('account');assert.equal(a.totalAssets,10000);assert.equal(a.netCapital,10000);assert.equal(a.totalProfit,0);assert.equal(a.capitalFlows.length,3);assert.deepEqual(a.watchlist,['sz000001']);assert.equal(a.trades.length,0);assert.equal((await call('diagnostics')).ok,true);
  originalAccountSnapshot=await exportAccountSnapshot();
 });
 await check('账户明确充值入口、默认增加现金、取消无修改与资金不计盈亏',async()=>{
  await click('.main-nav [data-page="account"]');
  await waitFor(()=>evaluate(`!!document.querySelector('[data-action="deposit"]:not(:disabled)')`));
  assert.equal(await evaluate(`document.querySelector('[data-action="deposit"]').textContent.trim()`),'充值账户资产');
  const before=await call('account');
  await click('[data-action="deposit"]');
  await waitFor(()=>evaluate(`document.querySelector('#app-dialog').open && !!document.querySelector('[data-form="capital"] #capital-value')`));
  assert.equal(await evaluate(`document.querySelector('#capital-mode').value`),'deposit');
  assert.equal(await evaluate(`document.querySelector('#capital-value').value`),'');
  assert.equal(await evaluate(`document.querySelector('[data-form="capital"] button[type="submit"]').textContent.trim()`),'确认充值');
  await evaluate(`document.querySelector('#capital-value').value='9999'`);
  await click('[data-form="capital"] [data-action="close-dialog"]');
  assert.equal(await evaluate(`document.querySelector('#app-dialog').open`),false);
  const cancelled=await call('account');
  assert.equal(cancelled.version,before.version);assert.equal(cancelled.cash,before.cash);assert.deepEqual(cancelled.capitalFlows,before.capitalFlows);
  await click('[data-action="deposit"]');
  await waitFor(()=>evaluate(`document.querySelector('#app-dialog').open && !!document.querySelector('[data-form="capital"]')`));
  assert.equal(await evaluate(`document.querySelector('#capital-mode').value`),'deposit');
  const amount=1234.56;
  await evaluate(`document.querySelector('#capital-value').value='1234.56'`);
  await screenshot('deposit-account.png');
  await evaluate(`document.querySelector('[data-form="capital"]').requestSubmit()`);
  const after=await waitFor(async()=>{const a=await call('account');return a.version>before.version && await evaluate(`!document.querySelector('#app-dialog').open`)?a:null;});
  assert.equal(after.cash,Math.round((before.cash+amount)*100)/100);
  assert.equal(after.netCapital,Math.round((before.netCapital+amount)*100)/100);
  assert.equal(after.capitalFlows.length,before.capitalFlows.length+1);assert.equal(after.capitalFlows[0].type,'deposit');assert.equal(after.capitalFlows[0].amount,amount);
  assert.equal(after.totalProfit,before.totalProfit);assert.equal(after.todayProfit,before.todayProfit);assert.equal(after.initial,before.initial);assert.equal(after.generation,before.generation);
  assert.deepEqual(after.watchlist,before.watchlist);assert.deepEqual(after.trades,before.trades);assert.deepEqual(after.orders,before.orders);assert.deepEqual(after.holdings,before.holdings);
  assert((await pageText()).includes('1,234.56'));assert.equal((await call('diagnostics')).ok,true);
 });
 await check('默认重置保留自选、清空资金与交易记录、更换世代且自动备份可恢复',async()=>{
  const before=await call('account'), saved=await exportAccountSnapshot();
  assert.equal(saved.kind,'investment-trading-room');assert(before.capitalFlows.length>0);assert(before.watchlist.length>0);
  const preview=await call('previewRestore');assert.equal(preview.ok,true);assert(preview.token);
  await openReset();await screenshot('reset-preserve-watchlist.png');
  const now=await submitReset(before);
  assert.deepEqual(now.watchlist,before.watchlist);
  assert((await evaluate(`document.querySelector('#toast').innerText`)).includes('自选已保留'));
  const automatic=resetBackup(saved);await restoreThroughUi(automatic);
  const restored=await call('account');
  assert.equal(restored.cash,before.cash);assert.equal(restored.nickname,before.nickname);assert.equal(restored.netCapital,before.netCapital);
  assert.deepEqual(restored.watchlist,before.watchlist);assert.deepEqual(restored.capitalFlows,before.capitalFlows);assert.notEqual(restored.generation,now.generation);
  assert.equal((await call('diagnostics')).ok,true);
 });
 await check('勾选重置清空自选及非空持仓成交，取消无修改且完整自动备份可恢复',async()=>{
  await restoreThroughUi(await resetFixtureSnapshot());
  const before=await call('account'), saved=await exportAccountSnapshot();
  assert.equal(before.holdings.length,1);assert.equal(before.trades.length,1);assert.equal(before.orders.length,1);assert.equal(before.capitalFlows.length,1);assert.deepEqual(before.watchlist,['sz000001']);
  assert.equal(before.trades[0].source,'isolated-desktop-reset-fixture');
  await openReset(true);await click('[data-form="reset"] [data-action="close-dialog"]');
  const cancelled=await call('account');assert.equal(cancelled.version,before.version);assert.equal(cancelled.generation,before.generation);assert.equal(cancelled.cash,before.cash);assert.deepEqual(cancelled.watchlist,before.watchlist);assert.deepEqual(cancelled.trades,before.trades);assert.deepEqual(cancelled.capitalFlows,before.capitalFlows);
  await openReset(true);await screenshot('reset-clear-watchlist.png');
  const now=await submitReset(before);assert.deepEqual(now.watchlist,[]);
  assert((await evaluate(`document.querySelector('#toast').innerText`)).includes('自选已清空'));
  const automatic=resetBackup(saved);await restoreThroughUi(automatic);
  const restored=await call('account');
  assert.equal(restored.cash,before.cash);assert.equal(restored.initial,before.initial);assert.equal(restored.netCapital,before.netCapital);assert.equal(restored.fees,before.fees);
  assert.deepEqual(restored.watchlist,before.watchlist);assert.deepEqual(restored.capitalFlows,before.capitalFlows);assert.deepEqual(restored.trades,before.trades);
  assert.equal(restored.holdings.length,1);assert.equal(restored.holdings[0].symbol,before.holdings[0].symbol);assert.equal(restored.holdings[0].qty,before.holdings[0].qty);assert.equal(restored.orders.length,1);assert.notEqual(restored.generation,now.generation);
  assert.equal((await call('diagnostics')).ok,true);
 });
 await check('备份格式损坏和过期恢复令牌不会修改账户',async()=>{await writeFile(backupFile,'{"wrong":true}');assert.equal((await call('previewRestore')).ok,false);const a=await call('account');let err;try{await call('restore',{token:'wrong',expectedVersion:a.version,generation:a.generation,confirm:'恢复账户'});}catch(e){err=e;}assert(err);assert.equal((await call('account')).version,a.version);});
 await check('不受信任的另一个窗口无法调用账户 IPC',async()=>{const intruder=new BrowserWindow({show:false,webPreferences:{preload:path.join(root,'desktop','preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});try{await intruder.loadURL('trading://app/index.html');const r=await intruder.webContents.executeJavaScript(`window.trading.account().then(r=>({allowed:r.ok,code:r.error?.code}))`);assert.equal(r.allowed,false);assert.equal(r.code,'ACCESS_DENIED');}finally{intruder.destroy();}});
 await check('重置验收结束后恢复原一万元及三条资金流水的隔离账户',async()=>{assert(originalAccountSnapshot);await restoreThroughUi(originalAccountSnapshot);const a=await call('account');assert.equal(a.cash,10000);assert.equal(a.netCapital,10000);assert.equal(a.capitalFlows.length,3);assert.deepEqual(a.watchlist,['sz000001']);assert.equal(a.trades.length,0);assert.equal(a.holdings.length,0);assert.equal((await call('diagnostics')).ok,true);});
 await click('.main-nav [data-page="account"]');await waitFor(async()=>(await pageText()).includes('资金流水'));await screenshot('account-desktop.png');
 await click('.main-nav [data-page="market"]');
 await waitFor(()=>evaluate(`document.querySelector('#content h1')?.textContent==='市场行情' && document.querySelector('.main-nav [data-page="market"]').classList.contains('active')`));
 await screenshot('market-desktop.png');
 await writeFile(path.join(directory,'report.json'),JSON.stringify({ok:true,version:(await call('bootstrap')).app.version,checks,directory,durationMs:Date.now()-begun},null,2));
 console.log(JSON.stringify({ok:true,version:(await call('bootstrap')).app.version,passed:checks.length,directory,durationMs:Date.now()-begun}));
 app.quit();
}catch(error){console.error(error.stack);if(window&&!window.isDestroyed())await screenshot('failure.png');await writeFile(path.join(directory,'report.json'),JSON.stringify({ok:false,checks,error:String(error.stack),directory},null,2));app.exit(1);}}
void run();

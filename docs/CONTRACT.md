# IPC 与账户接口契约

适用于 1.3.0。界面、Electron 主进程、账户服务和行情服务的职责见 [ARCHITECTURE.md](ARCHITECTURE.md)。IPC 与快照契约沿用 1.2.4，不增加 renderer 的系统权限。

默认数据目录为 Windows 系统“文档/投资交易室数据”，或 Mac 系统 Application Support 下的 `org.investment.tradingroom`；创建后通过 `realpath` 解析实际物理路径，再交给 SQLite 和行情缓存。`--data-dir=<本平台绝对路径>` 可用于隔离开发和测试，无效参数不回退到真实账户。快照不包含系统路径，Windows/Mac 通用。

前端不访问 Node、SQLite 或外网；金额在接口中为元，账户落盘为整数分。恢复和资金操作必须携带对应账户版本与世代，调用者不能通过更新请求参数绕过预览绑定。

## IPC API（preload暴露window.trading，调用均返回Promise）
`window.trading`为`transportVersion:1`的受限传输层，各方法返回`{ok,value}`或`{ok:false,error:{code,message}}`。renderer通过`helpers.js/createDesktopApi`在本上下文拆包并抛出带code的Error；不要从preload跨contextBridge抛出业务Error，其自定义code会丢失。以下为拆包后的应用API。
- bootstrap() -> {app:{name,version},account:AccountView,market:MarketOverview,status:MarketStatus}
- marketOverview({refresh?:boolean}) -> MarketOverview
- marketList({kind:'stocks'|'indices'|'sectors'|'hot',market?:'all'|'sh'|'sz'|'bj',query?:string,page?:number,pageSize?:number,sort?:'percent'|'amount'|'turnover'|'code',direction?:'asc'|'desc'}) -> {items:MarketItem[],total,page,pageSize,asOf,source,cached,warning?}
- quotes({symbols:string[]}) -> {items:Quote[],asOf,source,cached,warning?}
- history({symbol,kind:'minute'|'day'|'week'|'month'}) -> {items:ChartPoint[],source,asOf,warning?}
- account() -> AccountView
- setup({nickname,initial}) -> AccountView，仅未初始化账户允许；既有账户改资金走adjustCapital，重新清空账户才走reset。
- watch({symbol,remove?:boolean,expectedVersion?,generation}) -> AccountView
- adjustCapital({amount?:有符号元,targetAssets?:目标总资产元,expectedVersion,generation,note?}) -> AccountView；amount/targetAssets二选一，目标模式先刷新有效持仓报价，事务内最终检查估值。只改现金、记capitalFlows，同事务保存调整前备份；提取不能侵占冻结；净入金不计盈利，旧版本请求不能重复记账。
- submit({id,generation,symbol,side:'buy'|'sell',qty,limit}) -> {account:AccountView,order:OrderView,replayed?:boolean}
- cancel({id,generation}) -> {account:AccountView,order:OrderView}
- order({id,generation}) -> {order:OrderView|null,account:AccountView}
- diagnostics() -> {ok,checks:[{id,label,ok,detail}],problems:[],model}
- backup() -> {ok,path?} 原生保存对话框，导出自洽严格快照；取消返回{cancelled:true}
- listBackups() -> [{id,createdAt,version,generation}] 本地自动备份元数据，最新在前；列表不返回完整账本。
- previewBackup({id}) -> {token?,summary?,problems?,ok?,expectedVersion?,generation?} 指定本地UUID备份，主进程读取并严格检查；不存在或损坏不修改账户。
- previewRestore() -> {cancelled?:boolean,token?,summary?,problems?,ok?,expectedVersion?,generation?} 原生打开对话框；token在main保留快照及当前账户版本/世代，10分钟有效，不能让renderer提供路径；文件和本地备份复用同一预览流程。
- restore({token,expectedVersion,generation,confirm:'恢复账户'}) -> AccountView；同一事务备份当前账户、新世代恢复，不自动覆盖新版本。
- reset({initial,nickname,expectedVersion,generation,confirm:'重置账户',clearWatchlist?:boolean}) -> AccountView；先备份、清空交易资料，世代更新，默认保留自选，明确勾选才清空。
- status() -> MarketStatus
- onUpdate(callback) -> unsubscribe function（行情/账户变化后renderer主动重新读取，不直接信任事件payload）。

失败抛Error，error.message友好中文，error.code可选；preload必须保留错误码（如GENERATION_CHANGED / VERSION_CONFLICT / QUOTE_STALE / MARKET_CLOSED）。未知提交结果保留相同id+参数，可以查询/同编号重试，不允许新编号重复买。页面切换不清掉待确认委托。

## 数据形状（金额元，核心落盘整数分）
MarketItem: {symbol:'sh600519'|'sz000001'|'bj920001'|'sh000001'|板块id,name,code,market:'sh'|'sz'|'bj',type:'stock'|'index'|'sector',board?:'main'|'chinext'|'star'|'bse',price:number|null,change:number|null,percent:number|null,volume:number|null,amount:number|null,turnover:number|null,sector?:string,time?:string}
Quote继承MarketItem，加previous,open,high,low,bid,ask,bidSize,askSize,upper,lower,time,fetchedAt,source,orderBook:{bids:[{level,price,size}],asks:[...]},tradeable:boolean。缺行情用null/明确错误，不生成价格。
ChartPoint: {time,price,open?,high?,low?,volume?,average?}
图表：volume股票为股，sh689存托凭证为份；分时为时段量、K线为周期量，缺失不补0。完整图包含价格与量柱两区、同一X轴；指针与方向键使用同一个chartModel/chartPointAt定位，tooltip显示真实日期、价格/均价或OHLC及量。指数不返回成分股平均价作为均价，包括旧缓存；miniature不加副图。
MarketOverview: {indices:MarketItem[],sectors:MarketItem[],hot:MarketItem[],breadth:{up,down,flat,limitUp?,limitDown?,amount,total},asOf,source,cached,warning?,coverage?}
MarketStatus: {online:boolean,session:{open,label,date},lastSuccess:string|null,warning?,coverage?:string}
AccountView: {initialized:boolean,nickname,initial,netDeposits,netCapital,capitalFlows:CapitalFlow[],returnBasis:string,cash,frozenCash,totalCash,totalAssets,marketValue,totalProfit,totalReturn:number|null,todayProfit:number|null,valuationComplete:boolean,missingQuotes:string[],todayMissingQuotes:string[],version:number,generation:string,createdAt,watchlist:string[],holdings:Holding[],orders:OrderView[],trades:TradeView[],fees:number,realized:number}
CapitalFlow: {id,type:'deposit'|'withdrawal',amount,beforeCash,afterCash,frozenCash,time,note,accountVersion}；最近记录在前。净投入=initial+netDeposits，收益率仅净投入为正且估值完整时计算；所有资金流入/流出排除累计与当日交易盈亏。
Holding: {symbol,name,qty,available,frozen,cost,avgCost,price:number|null,marketValue:number|null,profit:number|null,profitPercent:number|null}
OrderView: {id,symbol,name,side,qty,limit,status:'pending'|'partial'|'filled'|'cancelled'|'expired'|'rejected',filledQty,remainingQty,frozenCash,time,updatedAt,message?,generation}
TradeView: {id,orderId,symbol,name,side,qty,price,gross,fees,commission,transfer,stamp,realized,time,quoteTime,source}

## 核心服务接口
core/account-service.mjs导出createAccountService({dbPath,quoteProvider,now?,onChange?})，返回：getAccount(quotes?:Quote[]), setup(payload), watch(payload), adjustCapital(payload), submit(payload)异步, cancel(payload), getOrder(payload), processPending()异步, diagnostics(), exportSnapshot(), inspectSnapshot(snapshot), restore(snapshot,payload), reset(payload), listBackups(), getBackup(id), close()。
quoteProvider(symbols) -> Promise<Quote[]>，报价命中真实时间和对手盘才允许模拟成交。先查已终态的相同完整意图，再请求网络，不增加版本。SQLite事务内最终检查版本/世代，冻结现金与股票数量必须覆盖未成交部分，撤单和成交原子，终态不能trim。交易日委托到期释放占用。恢复/重置先备份/新代/旧请求禁止，不打乱pending自洽。

## 实现范围与检验
支持沪深京行情。股票交易按板块数量规则/报价上下限/100%现金/FIFO/T+1（股票），限价等待、撤单、可追溯成交；不要宣称模拟交易所完整撮合队列或公司行为。统计缺行情时不冒充完整净值。委托中断/重复/取消交错、费用半分边界、部分FIFO/T+1/容量/快照导出可恢复必须实测。每天资产基准不混淆累计收益和当天盈亏。
Electron禁用nodeIntegration，contextIsolation+sandbox，仅受限IPC，不加载远程脚本。打包自带运行环境、不要求安装Node；SQLite在userData，不带用户私密资料到安装包；升级不覆盖数据。

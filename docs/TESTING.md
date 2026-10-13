# 测试方法与覆盖范围

纯逻辑测试使用临时目录、独立 SQLite 文件、注入时钟及明确的行情样本。桌面脚本各自在 `.qa` 下创建新账户，不附着现有窗口，也不使用默认个人账户。测试不会修改系统时钟。

1.3.0 沿用原有业务逻辑测试，并增加跨平台路径、窗口与包核验；本文件说明如何重跑，不把历史结果当作本次运行记录。实际结果以命令输出、GitHub Actions 与对应报告为准。

## 自动化逻辑测试

```powershell
npm ci
npm run check
npm test
```

目前五组共 160 项：账户 73 项、行情 37 项、界面纯逻辑 32 项、轮询 11 项、跨平台 7 项。也可运行 `npm run test:core`、`npm run test:market`、`npm run test:ui`。

| 范围 | 主要检查 |
|---|---|
| 账户 | 金额边界、幂等委托、并发/重复请求、部分成交、冻结金和数量、撤单、精确到期、T+1、FIFO、各板块数量规则及存托凭证、资金调整、版本与世代冲突、快照完整性、坏数据库、容量、缺行情估值 |
| 行情 | 源响应解析、沪深京完整目录校验、分页/搜索/排序、缓存与缺字段、日期及来源、新鲜度、并发请求合并、退避、拒绝无效代码、重定向目录原子写入和友好错误 |
| 界面 | 图表定位、量价与单位、字段缺失、按证券类型展示、输入 DOM 保留、选中股票再次搜索、旧账户响应拒绝 |
| 轮询 | 串行刷新、页面切换、隐藏/休市调度、失败退避、请求取消与迟到响应 |
| 跨平台 | Windows 旧目录与 UNC、Mac Application Support、非法隔离路径拒绝、菜单、两种 Mac 包布局、中文空格路径 SQLite/JSON/重开/重置恢复、NSIS/App ID/安全配置连续性 |

## 实际 Electron 界面

先关闭当前应用窗口，按顺序执行，避免多个界面测试争抢焦点。部分脚本访问公开行情源，需要联网；脚本失败不应改动默认账户。

```powershell
npx --no-install electron scripts/desktop-qa.mjs
npx --no-install electron scripts/search-input-qa.mjs
npx --no-install electron scripts/feedback-qa.mjs
```

推荐统一启动器（会从子进程移除 `ELECTRON_RUN_AS_NODE`，按顺序运行并传播失败退出码）：

```bash
node scripts/run-electron-qa.mjs scripts/platform-qa.mjs scripts/feedback-qa.mjs scripts/search-input-qa.mjs --offline
```

`--offline` 只在验收脚本中启用，不是生产软件的选项。平台脚本使用真实主进程、renderer、IPC、SQLite 和文件读写，显式断网；feedback 与 IME 脚本在已授权的真实 handler 后注入有标记的界面样本，不覆盖核心撮合行情，也不改变原有断言。IME 脚本不带 `--offline` 时仍检查真实公开目录。原 `desktop-qa.mjs` 有非交易日限制，不在普通工作日 CI 中强行跳过或修改那项断言。

`platform-qa.mjs` 在 Windows 检查 7 项，Mac 检查 8 项（多一项菜单/关闭驻留/Dock 重开）。包括 Ctrl/Command 全选、原生 Chromium 组合输入、不受信任窗口拒绝 IPC，以及在途导出期间重复退出仍完成原子备份。报告 `.qa/ci-platform.json` 记录实际运行平台、架构和受控范围。

- `desktop-qa.mjs`：17 项，实际主进程/preload/本地协议/renderer、账户、资金、恢复、重置、图表和日志边界。保存/打开对话框返回隔离文件路径，属于受控对话框测试。其中提交拒绝检查要求市场状态为“休市”，应在已核验日历覆盖的非交易日运行；盘中及仅显示“已收盘”的交易日收盘后不适用这项断言。
- `search-input-qa.mjs`：16 项，行情、自选、交易搜索；用 Chromium CDP `Input.imeSetComposition`/`Input.insertText` 验证中文组合输入、光标、焦点、旧搜索和旧报价响应。它不等于实际 Windows 拼音候选窗的全面测试。`--expect-regression` 仅用于已知 1.2.1 输入回归，不用于当前发布验收。
- `feedback-qa.mjs`：20 项，自动备份、损坏备份、原子导出、恢复版本冲突、充值迟到响应、证券详情分类、均价/成交量缺失、存托凭证单位、回车搜索及取消预览后保持关闭。报价和历史的界面展示样本、部分响应延迟及文件对话框选择受控，核心账本和文件读写真实执行。

验证打包应用时，可追加 `--installed-root=<Windows unpacked/安装目录或 Mac .app 的绝对路径>`；反馈脚本要求该安装版本与当前 `package.json` 一致。不要把数据目录当作安装根目录。报告和截图位于 `.qa/electron-integration-*`、`.qa/search-input-*`、`.qa/feedback-integration-*`。

## 真实 Windows 文件对话框

```powershell
npx --no-install electron scripts/native-dialog-qa.mjs
```

脚本不替换 `Electron.dialog`。根据控制台 `ACTION` 和提供的隔离文件路径，手动或用桌面自动化完成保存取消、实际保存、打开取消、选择坏 JSON、选择有效导出并恢复，共 5 项。不要选择个人文件；此脚本会打开原生对话框等待操作，十分钟内未完成会超时退出。

## 真实网络与安装验证

可单独运行只读联网探针，数据保存在临时目录：

```powershell
$previousMarketLive = $env:MARKET_LIVE
try {
  $env:MARKET_LIVE = '1'
  node tests/market-live-smoke.mjs
} finally {
  $env:MARKET_LIVE = $previousMarketLive
}
```

该检查覆盖动态目录总数/唯一性/市场分布、列表搜索、实际报价、多个周期历史和断网缓存。公开源若限流、证券代码历史不足或改变返回格式，测试可能失败，需要核对实际来源，不能生成样本行情来宣称真实联网通过。休市时只能验证行情和拒绝成交，盘中买卖逻辑由注入行情的核心测试覆盖。

构建后运行 `node scripts/verify-package.mjs`，检查 `app.asar` 文件与源码一致且无账户、行情缓存或测试数据，再核对 `LICENSE.electron.txt`、`LICENSES.chromium.html`。最后用安装后的真实 EXE 和新的 `--data-dir` 完成首次建户、正常退出重开、最小化恢复；升级验证应比较测试账户的完整账本。新机器安装、系统输入法候选窗、签名/SmartScreen、长期网络稳定性及交易所完整规则均不能仅凭上述自动化结果宣称通过。

Mac 构建后运行 `node scripts/verify-package.mjs "release/mac-arm64/投资交易室.app" --arch=arm64`（Intel 用 `release/mac/投资交易室.app` 和 `--arch=x64`）。另运行 `node scripts/smoke-application.mjs "<应用根目录>"`：启动实际 EXE/`.app`，正常退出，在隔离数据库创建账户，再次启动并检查持久化和正常退出。Mac 退出通过 AppleScript 发送 Quit，不删除隔离账本或修改系统安全设置。CPU 原生 Runner 上测试通过仍不等于物理 Mac 安装与人工全功能验收。

三个 Runner 的固定版本、执行顺序和 Artifacts 见 `.github/workflows/build.yml`。真实网络探针与系统输入法候选窗口属于单独验收；GitHub Actions 不上传数据库、备份、缓存或整份 `.qa`。生成校验值运行 `node scripts/release-metadata.mjs release`；汇总三平台产物时使用 `--all`。

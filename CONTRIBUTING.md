# 贡献指南

欢迎通过 Issue 反馈问题或通过 Pull Request 提交改进。提交代码和文档即表示同意将贡献按本项目的 MIT 许可证发布。

## 本地准备

使用 Windows 11 x64 或 macOS 13+ arm64/x64、Node.js 22.13.0 或更新版本和 npm，运行 `npm ci`。CI 使用 Node.js 24.20.0。使用独立的绝对 `--data-dir` 路径测试；自动化桌面脚本会在 `.qa` 下创建新账户。

修改后运行 `npm test`。涉及桌面行为时，按 [测试文档](docs/TESTING.md) 执行相应界面回归；涉及打包时，运行 `scripts/build-win.ps1` 与 `scripts/verify-package.mjs`。提交可复现的步骤、预期行为、实际行为以及运行环境。

## 修改约定

- 账户金额落盘为整数分；交易、冻结、资金流水和备份须在一致的 SQLite 事务内更新。
- 保持委托编号幂等、账户版本与世代检查；未知结果必须查询或重试原意图，不能重新编号重复操作。
- 主进程负责文件、网络和 SQLite。renderer 只使用 preload 白名单 API，不启用 Node 集成或加载远程脚本。
- 行情缺失、过期或分类变化必须明确显示；不要生成随机价格或把获取时间伪装为成交时间。
- 涉及交易日历、数量规则或数据单位时，注明可核验的上游/交易所来源并补充有意义的回归测试。

## 问题报告与隐私

Issue 可附版本、系统、操作步骤和经过检查的截图。不要提交本地账户数据库、备份文件、行情缓存、个人绝对路径、浏览器登录资料或访问凭据；这些文件通常应留在被忽略的 `.qa` 或数据目录中。

## 发布

同步修改 `package.json` 和 `package-lock.json` 的根版本及 `CHANGELOG.md`。保持 `--publish never`，先完成测试和包核验，再单独创建发布并上传安装包与 SHA-256。分发时保留本项目和 Electron/Chromium 的许可文件。

跨平台 PR 必须检查三平台 CI，Mac 选择对应 CPU 架构；不通过关闭 Gatekeeper、SIP、Electron 沙箱或削弱断言来解决失败。普通 PR 不使用签名秘密。Mac Developer ID、公证及真实机器验证分别记录；ad-hoc 或构建成功不能替代实机验收。Tag/手动发布使用 `.github/workflows/release.yml`，保留历史 Release。

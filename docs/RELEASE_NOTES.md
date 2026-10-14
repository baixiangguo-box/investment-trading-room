# 投资交易室 1.3.0 · Windows + macOS 预览

沿用现有 Windows 模拟交易功能，新增 macOS Apple Silicon（arm64）和 Intel（x64）支持。Mac 使用应用菜单、Command 编辑快捷键、Dock 重开窗口及独立 Application Support 账户目录。Windows 原有账户路径和 NSIS 安装方式保持不变。

提供 Windows x64 一键 EXE 与原有向导 EXE、Mac arm64/x64 PKG、DMG 与 ZIP，以及 SHA256SUMS.txt 和 build-metadata.json。安装包自带 Electron、Chromium、Node 和 SQLite 运行环境，无需预装开发工具；Mac 要求 macOS 13 或更新版本，使用与 CPU 对应的安装包。PKG 使用系统安装器；DMG 中将“投资交易室”拖入 Applications。安装可以离线进行，行情需要联网。

此发布由三平台构建流程全部成功后生成，流程包括 160 项逻辑测试、隔离 Electron 主进程/renderer 回归、包资源与隐私核验，以及真实 EXE/`.app` 的二次启动和 SQLite 持久化检查。具体执行结果以对应 Actions 运行链接为准。

发布前还在三个全新 Runner 上执行一键 EXE / 原生 PKG 的实际安装，核验资源和在应用 PATH 排除开发工具后的二次启动。Windows 原有选择安装目录的流程保留。一键安装不等于绕过操作系统：系统安全确认、Mac Installer 的继续和可能的管理员授权仍需用户操作。

**Mac 尚未完成 GUI 实机验收，未进行 Developer ID 签名或 Apple 公证，PKG 未数字签名。** app 的 ad-hoc 仅用于让开发构建具有有效代码签名结构，不证明发布者身份。Gatekeeper 可能阻止下载应用或安装器；通过系统提供的安全验证与允许流程处理，不关闭 Gatekeeper/SIP 或删除隔离属性。Windows 安装包同样未数字签名；不承诺所有机器完全免系统确认。

CI 中的离线行情/显示样本、文件选择返回值和 Chromium 组合输入是明确受控测试，不能当作真实盘口、系统中文输入法或真实 Mac 文件对话框的人工验收。账户仍保存在本机，Windows/Mac 可使用本软件导出的 JSON 备份迁移；恢复前核对预览并保留外部备份。

行情依赖公开数据源和网络，可能延迟、限流或缺字段。交易全部为本地模拟；交易日历仍仅覆盖 2026 年，未知年份暂停成交。MIT 许可不改变第三方组件和行情数据许可。

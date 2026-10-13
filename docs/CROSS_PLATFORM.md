# 跨平台审查、实施与验收

## 审查结论与实施计划

审查基线是 GitHub 的 1.2.4（`6ba272a`）。本次使用独立克隆与 `feat/windows-macos-support` 分支；不覆盖以前的本地暂存源码、安装目录或用户账户。

| 范围 | 审查结果与处理 |
|---|---|
| 技术栈 | 沿用 Electron 44.7.0、electron-builder 26.15.3、原生 ES modules/SVG/Node 内置 SQLite，不更换依赖 |
| 核心账本 | WAL、FULL、事务、整数分、版本/世代、T+1、FIFO 和 schema 1/2 迁移保持不变；在两个 Mac 原生架构 Runner 重跑测试 |
| 行情与时间 | Node fetch、TextDecoder、fs 和 path 可跨平台；上海时区交易日历保持不变。CI 的离线样本不视为上游实盘行情验收 |
| 数据目录 | Windows 保持原 Documents 目录；Mac 使用系统 Application Support 下的固定 App ID；隔离目录必须为本平台绝对路径 |
| 窗口与键盘 | Windows 关窗退出；Mac 关窗驻留、菜单/Command/Dock 恢复、退出等待在途 IPC 和备份 |
| 图标 | 复用原 1024px 绘制逻辑输出高清 PNG、多尺寸 ICNS，Windows ICO 保留 |
| 安装包 | 保持 NSIS；增加原生 arm64/x64 DMG+ZIP；分别核验 ASAR、Mac Info.plist/CPU/图标及运行时许可 |
| CI/CD | 固定 Node、锁定 npm 依赖、固定官方 Action SHA；Windows 和两个 Mac Runner 测试、构建、核验、上传 Artifacts；独立 Tag/手动发布流程 |

## 需要持续关注的风险

- Windows 改变默认目录会产生“空账户”假象，因此不迁移默认目录，也不在升级时重建旧账本。JSON 格式保持兼容，跨设备恢复生成新世代。
- 关闭窗口期间可能有等待行情或文件对话框的操作。关窗驻留与退出分开，退出先禁止新 IPC，再等待已授权操作完成；重复退出不能跳过等待。Mac 重开窗口不会重新注册 IPC 或启动第二个撮合器。
- Mac 构建使用原生 Runner，不能把 Windows 上的路径单测视为 Mac SQLite 验收。Apple Silicon 包和 Intel 包独立命名，避免同名覆盖。
- 无 Apple Developer 凭据时仅做 ad-hoc 开发签名，保留 hardened runtime 和 Electron 沙箱；没有 Developer ID、公证或真实 Mac 用户体验保证。不得关闭 Gatekeeper/SIP 或去掉下载隔离属性。
- 实际网络接口可能限流或改变格式。稳定 CI 使用明确的离线/界面样本，真实网络测试需要单独执行并报告；不能补造价格来通过测试。
- 交易日历仍仅覆盖 2026 年。进入未知年份暂停模拟成交的行为没有改变。

## 验收状态与证据

实际执行结果以对应 GitHub Actions 运行、Artifacts 中的校验值及报告为准，不将脚本存在当作验收通过。

| 项目 | 状态 |
|---|---|
| 修改前 Windows 逻辑测试 | 本地 153 项通过 |
| 新增跨平台逻辑测试 | 本地 7 项通过；总共 160 项 |
| Windows Electron/打包/真实 EXE | 本地 7 项平台验收、20 项反馈回归在源码和打包 ASAR 均通过；真实 EXE 两次启动、正常退出、SQLite 重新读取通过；18 个包资源核验通过 |
| Mac arm64 与 x64 原生 CI | 待运行，不宣称通过 |
| Mac 实机 DMG 安装、Finder/Dock、系统输入法、原生文件对话框 | 尚未完成实机验收 |
| Mac Developer ID 与公证 | 未配置凭据，未完成；ad-hoc 不等于发行者签名 |

CI 包含实际 `.app`/EXE 的两次启动、正常退出、隔离 SQLite 重新读取；仍不等于物理 Mac 全功能人工验收。物理验收应至少检查拖入 Applications、首次启动、编辑快捷键、中文候选窗口、完整行情、股票详情图表、交易与撤单、账户调整、JSON 导出/恢复、断网以及升级后的旧账户。

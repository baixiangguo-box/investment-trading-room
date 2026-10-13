# 第三方组件与数据说明

本项目原创源码、界面代码、应用图标和文档使用根目录的 MIT 许可证。第三方组件保留各自版权和许可；本项目的 MIT 许可不重新许可第三方软件，也不授予行情数据的权利。

## 运行时与构建工具

| 组件 | 项目使用版本 | 许可与来源 | 分发说明 |
|---|---|---|---|
| Electron | 44.7.0 | MIT；[electron/electron](https://github.com/electron/electron) | 安装目录保留 `LICENSE.electron.txt`；版权包括 Electron contributors 与 GitHub Inc. |
| Chromium 及 Electron 所集成组件 | 随上述 Electron 发行包 | 多种上游许可证；[Chromium](https://www.chromium.org/) | 安装目录保留完整 `LICENSES.chromium.html`，其中包含各组件许可和归属。 |
| Node.js | 随上述 Electron 发行包 | MIT 及第三方许可；[nodejs/node](https://github.com/nodejs/node) | 包含在 Electron 运行时中；以该运行时随附的许可和归属为准。 |
| SQLite | 由上述 Node.js 的 `node:sqlite` 提供 | [SQLite public domain](https://www.sqlite.org/copyright.html) | 未引入额外 npm SQLite 驱动。 |
| electron-builder | 26.15.3 | MIT；[electron-userland/electron-builder](https://github.com/electron-userland/electron-builder) | 开发/构建依赖，版权包括 Loopline Systems；项目不将其 npm 包嵌入应用业务代码。 |
| @electron/asar | 由 `package-lock.json` 固定 | MIT；[electron/asar](https://github.com/electron/asar) | 包核验使用的构建依赖，版权包括 GitHub Inc.。 |

Electron 下载包的 `LICENSE` 在安装目录中命名为 `LICENSE.electron.txt`。Electron 的 Chromium 归属文件较大，但它是分发运行时的一部分，不应移除。打包后应检查上述两份文件与应用 `app.asar` 中的本项目 `LICENSE`、`THIRD_PARTY_NOTICES.md` 均存在。

其他 npm 构建依赖的准确版本、下载地址、完整性校验值和 SPDX 许可证标记记录在 `package-lock.json`。`npm ci` 安装后，各包自身的 LICENSE/NOTICE 是对应归属的依据。若另外分发 `node_modules` 或修改打包方式而包含这些包，应一并保留其要求的许可和归属。本项目的常规应用包不包含构建依赖的 `node_modules`。

`scripts/make-icon.py` 是可选图标生成脚本，使用 [Pillow](https://github.com/python-pillow/Pillow)，许可以安装的 Pillow 版本自带 LICENSE 为准；Pillow 不是应用运行依赖，已有图标可直接用于构建。

## 行情来源

行情服务使用第三方提供的公开只读接口：

- [新浪财经](https://finance.sina.com.cn/)：沪深京股票目录及备用行业概况。
- [腾讯证券](https://stock.qq.com/)：证券报价、股票/指数分时及 K 线。
- [东方财富](https://www.eastmoney.com/)：行业板块及对应历史数据。

**行情响应、缓存、证券名称及截图中的行情数据不属于本项目 MIT 许可范围。** 获取和使用相关数据应遵循对应提供方及权利人的条件；本项目不声称拥有这些数据，不随源码仓库发布完整行情数据集。截图仅展示历史界面状态，不能当作实时数据源。

应用没有复制或加载第三方网站的界面、网页脚本、字体或商标图片。行情服务自行解析响应，不执行上游 JavaScript，不读取浏览器登录资料。

## 二次分发

分发本项目代码时保留根 MIT 许可；分发安装程序或 Electron 运行时还须保留随包提供的 Electron、Chromium 及其组件许可和归属。项目 MIT 许可不改变这些要求。

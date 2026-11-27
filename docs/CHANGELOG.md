# 更新日志

FolioPrism（棱阅）的版本改动记录。每个版本对应一个 GitHub Release。

## 未发布 · 仓库结构重构

只调整目录与构建脚本，不改任何业务逻辑；对外 HTTP 接口、Electron IPC 接口、渲染行为、安装包内容均保持不变。

- 目录改为 `src/` 分层：`main/`（Electron 主进程）、`preload/`、`server/`、`translator/`、`shared/`（前后端共用）、`renderer/`（原 `public/`，仍是零构建的原生前端）。
- `public/formats.js` → `src/shared/formats.js`：它是唯一一份前后端共用的模块，搬出「静态资源」目录。浏览器端改由服务端 `/shared/` 路由提供，`index.html` 的引用同步改为 `/shared/formats.js`。
- 构建脚本移入 `scripts/`：`pack.js`、`prepare-vendor.js`、`verify.js`、`verify-release.js`，每个脚本自行把仓库根定位到上一级。
- `pack.js` 的打包规则从**黑名单**（`IGNORE` 默认放行）改成**白名单**（只放行 `package.json`、`src/`、`build/`）。新增的调试脚本、`.env`、笔记等文件不会再被悄悄打进安装包；漏掉运行时代码则会在打包版启动时立刻报错。
- `verify-release.js` 不再写死 8 个文件路径，改为遍历 `src/` 全部运行时代码比对 SHA256，以后拆文件不用再同步这份清单。
- `@electron/asar` 补进 `devDependencies`（此前靠传递依赖提升，换机器可能找不到）。
- 新增 `.github/workflows/ci.yml`：Windows 跑 `npm ci → npm run setup → npm test → npm run verify`，Ubuntu 跑单元测试，提前暴露跨平台路径问题。
- 三份「改动总结」合并进 `docs/CHANGELOG.md`。

## 1.5.3

PDF 阅读体验与翻译稳定性修复。

- PDF 视图改为铺满窗口，顶栏新增 A- / A+ 缩放（75%–200%，快捷键沿用「视图 → 增大/减小字号」），并跟随 Windows「文本大小」辅助功能缩放。
- 「重新翻译」会真正强制重跑（`force` + `--ignore-cache`）；切换翻译服务 / 语言后自动刷新 PDF 状态。
- Bing 翻译长段落自动分块（≤900 字符、保护 `{vN}` 占位符）；原文与译文语言相同时给出明确提示，而不是静默失败。
- 界面字号改用 `--font-size-base × --text-scale` 计算。

## 1.5.2

修复 Excel 表格内嵌图片无法显示。

- 支持 WPS `=DISPIMG("ID_...",1)` 嵌入式单元格图片（解析 `xl/cellimages.xml` 与关系映射）。
- 支持标准 Excel 浮动图片（`oneCellAnchor` / `twoCellAnchor` 锚点落到对应单元格）。
- 自动隐藏 `WpsReserved_CellImgList` 等 veryHidden 保留表。
- 图片以 `Blob URL` 渲染并接入灯箱放大，切换文件时统一回收；外链与 SVG 等非位图媒体被安全拦截。

变更规模：7 个文件，`+717 / -24` 行（核心渲染器 `+413 / -15`）。

## 1.5.1

界面与导航重构。

- 顶栏移除「打开文件夹 / 打开文件」、路径框、字号 / 宽度 / 目录 / 翻译设置按钮，桌面端统一收口到原生菜单栏（「文件 → 打开文件…」`Ctrl+O`，「视图」内含 A+ / A- / 阅读宽度 / 翻译设置）。
- 移除全盘文件夹树、最近文件夹与右侧目录栏，改为两栏布局；左侧边栏保留「继续阅读」与可收起 / 展开的文档目录。
- 纯浏览器 Web 模式提供顶栏「打开文件」与「视图 ▾」下拉，替代原生菜单。

变更规模：7 个代码 / 文档文件，`+321 / -609` 行，净精简 288 行。

## 1.5.0

- 新增统一格式注册表 `formats.js`（现位于 `src/shared/`），成为主进程、服务端、渲染器与测试的唯一格式真相源。
- 补齐音频（mp3 / wav / m4a / flac / ogg）与 mkv / ogv 视频、点文件（`.gitignore`、`.env` 等）及无扩展名文件（`Makefile`、`Dockerfile`、`LICENSE`、`README`）支持。
- 侧栏新增隐藏项 / 依赖目录开关与不可读占位行；顶栏新增「打开文件」按钮并支持 Web 模式本地 File API 预览。
- 安装包支持注册 Windows「打开方式」与默认应用关联。

## 1.4.1

修复直接打开文本 / 代码文件时的渲染崩溃，补齐发布门禁。

## 1.4.0

朗读改为流式合成与流式播放（常驻 worker + HTTP 分块 + Web Audio 边解边播），新增安装包脚本与三层测试。

## 1.3.0

首个公开发行版，更名 FolioPrism 棱阅，支持命令行 / 拖拽 / 打开方式打开文件，MIT 许可。

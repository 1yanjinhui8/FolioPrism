<div align="center">

# FolioPrism (媒体阅读器)

**A local-first multimedia document reader & bilingual reading studio.**  
**本地优先的多媒体文档阅读与双语伴读工作台。**

![Platform](https://img.shields.io/badge/Platform-Windows%2010%2F11-0078D4?style=flat-square)
![Electron](https://img.shields.io/badge/Electron-44%2B-47848F?style=flat-square)
![Node.js](https://img.shields.io/badge/Node.js-20%2B%20(22%20LTS)-339933?style=flat-square)
![Architecture](https://img.shields.io/badge/Server-Zero--Dependency%20HTTP-orange?style=flat-square)
![Local First](https://img.shields.io/badge/Privacy-Local--First-brightgreen?style=flat-square)

[English](#english) · [简体中文](#简体中文)

</div>

---

<a id="english"></a>

## English

**FolioPrism** (repository: `media-reader`) is a local-first desktop and web multimedia document reader built with **Electron** and a **zero-dependency Node.js `http` server**. Designed with no database and no cloud lock-in, it excels at browsing local folders containing Markdown notes, academic PDFs, Office files, source code, and media side-by-side—especially for bilingual reading of English research papers and technical documentation.

### Key Features

- **Multi-Format Rendering**
  - **Markdown (`.md`, `.markdown`)**: GitHub-flavored rendering (`marked`), syntax-highlighted code blocks with one-click copy (`highlight.js`), auto-generated table of contents, and clickable relative links between local files.
  - **PDF (`.pdf`)**: Built-in PDF viewer with layout-preserving bilingual translation powered by [PDFMathTranslate](https://github.com/Byaidu/PDFMathTranslate) (`pdf2zh`), keeping formulas, charts, and tables intact. Independent iframes for **Original / Dual / Mono** modes preserve your scroll position when switching views.
  - **Office & Data**: `.docx` rendering (`mammoth`), multi-sheet `.xlsx` / `.xls` / `.csv` tables (`SheetJS`), and sanitized `.html` / `.htm`. (`.pptx` is recognized for download/external launch rather than inline preview.)
  - **Code & Plain Text**: 40+ programming and config formats with automatic encoding detection (`UTF-8`, `UTF-8 BOM`, `UTF-16 LE/BE`, `GBK`, `Latin1`, up to 32 MB).
- **Rich Media & Video Integration**
  - Resolves relative & remote images in Markdown with lazy loading and a full-screen **Lightbox** (zoom, pan, prev/next).
  - Embeds local audio/video players with HTTP `206 Partial Content` (`Range`) seeking and playback-progress resume.
  - Automatically converts **Bilibili (`BV...`)** and **YouTube** URLs in Markdown into embedded players.
- **Bilingual Reading & Smart Dictionary**
  - Sentence-level inline translation with a 3-state toggle (**Bilingual / Translation Only / Off**) persisted across files across **19 languages**.
  - **Translation Backends**: Out-of-the-box Bing Web Translate (default) and Google Translate (multi-endpoint failover), plus customizable **OpenAI-compatible APIs** (DeepSeek, GPT, local Ollama, etc.) tuned for academic papers.
  - **2-Second Hover / Selection Lookup**: Uses `Intl.Segmenter` for accurate word boundaries (including CJK), querying Youdao Dictionary (with US/UK phonetics for EN→ZH) or falling back to your translation engine, with instant pronunciation.
- **Neural Text-to-Speech (TTS)**
  - Paragraph-level and full-article/page-by-page PDF narration via `edge-tts` (with `0.7×–1.3×` speed control and language-aware neural voice selection), automatically falling back to the browser's `Web Speech API` when offline or unconfigured.
- **Thoughtful Reading Experience**
  - **Non-Destructive Find (`Ctrl+F` / `F3`)**: Powered by the CSS Custom Highlight API (`CSS.highlights`), skipping translation blocks so layout, TTS highlights, and scroll state stay untouched.
  - **Continuity**: Proportional scroll position memory (up to 200 files), *Continue Reading* & *Recent Folders* lists, Light/Dark themes, adjustable font sizes, and reading-width toggle.
  - **Desktop Integration**: Single-instance window, drag-and-drop file opening, Windows *"Open with"* / CLI file arguments, and a virtual **"This PC"** drive browser in standalone Web mode.

### Requirements

- **OS**: Windows 10 / 11
- **Runtime**: Node.js 20+ (22 LTS recommended) & npm (only required for running from source or building)
- **Optional Tools** (one-click installation inside **Translation Settings** via [`uv`](https://docs.astral.sh/uv/)):
  - `pdf2zh`: Layout-preserving PDF translation & PyMuPDF text extraction
  - `edge-tts`: Neural voice synthesis

### Quick Start

```bash
git clone https://github.com/1yanjinhui8/media-reader.git
cd media-reader
npm install
npm run setup
npm start
```

> `npm run setup` (`prepare-vendor.js`) copies browser-side libraries (`marked`, `highlight.js`, `mammoth`, `xlsx`, `DOMPurify`) from `node_modules` into `public/vendor/` so the app never relies on external CDNs. Run it after initial installation or dependency updates.

#### Browser-Only Mode

Run the local HTTP server without launching Electron (or double-click `start.bat` on Windows):

```bash
npm run web
```

The server binds to `127.0.0.1:7788` (auto-probing up to `7795` if occupied) and opens your default browser with a one-time token that exchanges into an `HttpOnly` cookie.

Available CLI options:

```bash
node server.js --port=8080 --root="D:\Documents" --no-open
```

### Packaging (Portable Windows App)

```bash
npm run dist
```

Outputs a standalone portable folder at `dist/媒体阅读器-win32-x64/`. Copy the folder to any Windows x64 machine and launch `媒体阅读器.exe`—no Node.js installation required on the target machine. (Internet access is needed during packaging to fetch Electron binaries.)

### Verification Script

```bash
node verify.js "D:\path\to\sample.md"
```

Spawns an isolated server instance on port `7789` to verify `/api/health`, static & vendor assets, `/api/browse`, `/api/read`, and Markdown image references via `/api/asset`. Without a sample path, sample-specific checks are marked `SKIP`.

Optional environment variables:
- `READER_SAMPLE`: Path to a sample Markdown file (alternative to CLI arg)
- `READER_EXPECT_REFS`: Expected number of image references in the sample
- `READER_MIN_MD_FILES`: Minimum `.md` files expected in the sample directory
- `READER_MIN_READ_BYTES`: Minimum byte length expected from `/api/read`
- `READER_DEVTOOLS=1`: Enable F12 DevTools in packaged builds
- `READER_DEBUG=1`: Enable the `/api/logs` diagnostic endpoint

### Project Structure

```text
main.js             Electron main process: window lifecycle, menu, native dialogs, file associations
preload.js          Minimal contextBridge IPC surface (window.readerNative)
server.js           Zero-dependency HTTP server: file browsing, smart encoding, range streaming, auth
translator.js       Text/PDF translation, hover dictionary, Edge TTS, cache pruning, uv installer
public/
  index.html        App shell & translation/TTS/find UI
  app.js            Renderers (Markdown/HTML/DOCX/XLSX/PDF/Media), bilingual engine, TTS, Lightbox
  style.css         Light/dark themes & responsive reader styling
  vendor/           Local browser libraries generated by `npm run setup`
prepare-vendor.js   Copies vendor bundles from node_modules
pack.js             @electron/packager portable win32-x64 build script
verify.js           End-to-end verification script
start.bat           One-click Windows Web mode launcher
build/              Application icon (icon.ico)
```

### Configuration, Cache & Logs

All runtime data is stored in the user's local AppData directory (keeping the app directory read-only safe):
- `%LOCALAPPDATA%\media-reader\config.json` — Translation backend, languages, OpenAI settings, TTS voices/rate
- `%LOCALAPPDATA%\media-reader\text-cache.json` — Text & dictionary lookup cache (capped at 4,000 entries)
- `%LOCALAPPDATA%\media-reader\cache\pdf\` — Translated PDF outputs (auto-pruned after 90 days / 2 GB)
- `%LOCALAPPDATA%\media-reader\cache\tts\` — Synthesized MP3 cache (auto-pruned after 30 days / 500 MB)

Logs are written asynchronously with 5 MB rotation to `runtime.log` (source mode) or `%TEMP%\media-reader.log` (packaged mode), with access tokens and lookup/TTS query texts redacted.

### Security & Privacy Architecture

Although the server only listens on `127.0.0.1`, localhost is still exposed to other local processes and cross-site browser attacks. FolioPrism enforces defense-in-depth:
- **Token + Cookie Auth**: All endpoints (except `/api/health`) require a 128-bit random token checked with `crypto.timingSafeEqual`. Initial URL tokens are stripped via `302` redirect into an `HttpOnly; SameSite=Strict` cookie; external browser previews use 60-second single-use bound tickets (`/api/ticket`).
- **Anti-DNS Rebinding & CSRF**: Rejects non-loopback `Host` headers, cross-site `Sec-Fetch-Site`, and external `Origin` headers.
- **Strict CSP & Sanitization**: Zero external CDN scripts (`script-src 'self'`). Markdown, HTML, and DOCX outputs are sanitized via `DOMPurify` (with a built-in fallback whitelist stripping `id`, inline `style`, and dangerous URI schemes); XLSX tables are built purely via `textContent`.
- **Path & File Boundary**: `/api/raw` restricts inline rendering to safe media/PDF/Office types and forces `Content-Disposition: attachment` with `sandbox` CSP on active content (e.g., HTML/SVG/JS); `/api/asset` restricts extensions to media types and verifies symlinks via `fs.promises.realpath`.
- **Credential Isolation**: API keys are stored only on disk and never returned by `/api/translate/config` (only `hasKey: boolean` is exposed).
- **Privacy Note**: Local files are never uploaded anywhere except the text segments you explicitly translate or narrate using cloud backends (Bing, Google, Edge TTS, or remote LLM APIs). For full offline/private text translation, configure a local OpenAI-compatible server such as **Ollama**.

### Known Limitations

- Designed primarily for **Windows** (`win32-x64` packaging, `where.exe` / `taskkill` process management).
- `.pptx` files do not support inline preview (a download/copy-path card is displayed instead).
- Very large text/table files (tens of MB; inline text cap is 32 MB) may take noticeable time during initial client-side parsing.
- Free Bing/Google web endpoints are unofficial and may rate-limit or break if upstream protocols change.

### License

No open-source license has been added to this repository yet.

---

<a id="简体中文"></a>

## 简体中文

**FolioPrism（媒体阅读器）** 是一个跑在本机的**多媒体文档与双语伴读工作台**，采用 **Electron 桌面窗口 + 零第三方依赖的 Node.js `http` 本地服务**构建，无需数据库，也不依赖云端托管。

主要面向「**把 Markdown 笔记、PDF 论文、Office 文档、源码和音视频放在本地文件夹中连续阅读**」的场景，尤其针对英文论文与技术文档的双语精读做了深度打磨。

### 核心功能

- **多格式文档渲染**
  - **Markdown（`.md` / `.markdown`）**：支持 GFM 排版（`marked`）、代码语法高亮与一键复制（`highlight.js`）、自动生成右侧大纲目录，以及文档间相对路径跳转。
  - **PDF（`.pdf`）**：内置阅读器并集成开源项目 [PDFMathTranslate](https://github.com/Byaidu/PDFMathTranslate)（`pdf2zh`），生成保留原版排版的双语 / 纯译文 PDF，公式、图表、表格留在原位；**原文 / 双语 / 译文**各自独立使用 `<iframe>`，切换视图不会跳回首页，刷新后也能接回后台翻译进度。
  - **Office 与网页**：支持 `.docx` 解析（`mammoth`）、多工作表 `.xlsx` / `.xls` / `.csv` 表格预览（`SheetJS`）以及消毒后的 `.html` / `.htm`。（`.pptx` 识别后提供下载与路径复制卡片，不做内联渲染。）
  - **代码与纯文本**：支持 40+ 种编程语言与配置文件（单文件上限 32 MB），自动识别 `UTF-8`、`UTF-8 BOM`、`UTF-16 LE/BE`、`GBK`、`Latin1` 编码，解决 Windows 中文文本乱码问题。
- **富媒体与视频嵌入**
  - 自动解析 Markdown 中的相对路径图片、远程图片及本地图片兜底目录，支持懒加载与全屏**图片灯箱**（缩放、拖拽、上下张切换）。
  - 支持本地音视频内嵌播放，服务端完整实现 HTTP `206 Partial Content`（`Range`）分片拖拽，并记住本地视频播放进度。
  - 自动将 Markdown 中的 **Bilibili（`BV...`）** 与 **YouTube** 视频链接转换为内嵌播放器。
- **双语精读与悬停查词**
  - **逐句双语对照**：支持 **19 种语言**，提供「双语 / 仅译文 / 关闭」三态一键切换，偏好跨文件自动记忆。
  - **多翻译引擎**：默认开箱即用 Bing 免费翻译（兼容国内网络）与 Google 翻译（多域名自动容灾互备）；支持配置 **OpenAI 兼容接口**（DeepSeek、GPT、本地 Ollama 等），内置面向学术论文的提示词优化。
  - **悬停 / 划词 2 秒自动查词**：基于 `Intl.Segmenter` 实现中/日/英/泰等多语种分词，英译中优先调用有道词典（带音标与词性释义），并支持一键单词发音。
- **神经语音朗读（TTS）**
  - 集成 `edge-tts` 神经语音合成，支持按段落点读、整篇连续朗读及 PDF 按页抽取朗读，支持 `0.7×–1.3×` 语速调节与按语种自动匹配母语音色；未安装语音引擎或离线时自动退回浏览器自带 `Web Speech API` 朗读。
- **沉浸式阅读辅助**
  - **无损文档内查找（`Ctrl+F` / `F3`）**：基于 `CSS Custom Highlight API`（`CSS.highlights`）实现，不修改 DOM 结构，不破坏双语排版与朗读高亮，自动跳过译文块。
  - **阅读连续性**：按滚动比例记忆每篇文档的阅读位置（最多 200 篇，并在首屏图片加载沉降后精准恢复）、*继续阅读* 与 *最近文件夹* 列表、明暗主题切换、字号与阅读宽度调节。
  - **桌面与 Web 双栖**：支持单实例运行、拖放文件打开、Windows「打开方式 / 命令行传参」直接打开；纯浏览器模式下提供虚拟「此电脑」全盘浏览入口。

### 环境要求

- **操作系统**：Windows 10 / 11
- **运行环境**：Node.js 20 或更高版本（推荐 22 LTS）与 npm（仅源码运行或打包时需要）
- **可选增强工具**（可在阅读器「翻译设置」中通过 [`uv`](https://docs.astral.sh/uv/) 一键安装）：
  - `pdf2zh`：PDF 保留排版翻译与 PyMuPDF 文本抽取
  - `edge-tts`：Edge 高清神经语音朗读

### 快速开始

```bash
git clone https://github.com/1yanjinhui8/media-reader.git
cd media-reader
npm install
npm run setup
npm start
```

> `npm run setup`（即 `prepare-vendor.js`）会把浏览器端依赖（`marked`、`highlight.js`、`mammoth`、`xlsx`、`DOMPurify`）从 `node_modules` 复制到 `public/vendor/`，确保完全不依赖外部 CDN。首次拉取或升级依赖后均需执行一次。

#### 仅用浏览器打开（Web 模式）

不启动 Electron 窗口，直接以本地服务 + 系统浏览器模式运行（Windows 下也可直接双击 `start.bat`）：

```bash
npm run web
```

服务默认监听 `127.0.0.1:7788`（端口被占用时自动顺延至 `7795`），并自动在浏览器打开带一次性令牌的 URL（校验后写入 `HttpOnly` Cookie 并从地址栏移除）。

支持命令行参数：

```bash
node server.js --port=8080 --root="D:\Documents" --no-open
```

### 打包 Windows 便携桌面版

```bash
npm run dist
```

打包产物位于 `dist/媒体阅读器-win32-x64/`。将整个文件夹复制到其他 Windows 电脑，双击 `媒体阅读器.exe` 即可运行，目标机器无需安装 Node.js。（打包过程需联网下载 Electron 运行时。）

### 端到端验收脚本

```bash
node verify.js "D:\path\to\sample.md"
```

脚本会在 `7789` 端口拉起独立服务实例，自动校验 `/api/health`、静态与 vendor 资源、`/api/browse` 目录浏览、`/api/read` 全文读取以及 `/api/asset` 图片引用；不传样本路径时，样本相关检查会标记为 `SKIP`。

常用环境变量：
- `READER_SAMPLE`：指定样本 Markdown 路径（等价于命令行参数）
- `READER_EXPECT_REFS`：断言样本期望的图片引用数量
- `READER_MIN_MD_FILES`：断言样本目录最少 Markdown 文件数
- `READER_MIN_READ_BYTES`：断言全文读取最小字节数
- `READER_DEVTOOLS=1`：在打包版中允许按 `F12` 打开开发者工具
- `READER_DEBUG=1`：开启 `/api/logs` 日志排查接口

### 目录结构

```text
main.js             Electron 主进程：窗口管理、菜单、原生文件/文件夹对话框、文件关联
preload.js          contextBridge 暴露的最小 IPC 接口（window.readerNative）
server.js           零依赖本地 HTTP 服务：目录浏览、编码识别、Range 流媒体、鉴权与安全边界
translator.js       文本/PDF 翻译、悬停查词、Edge TTS 合成、缓存清理、uv 一键安装
public/
  index.html        前端骨架与翻译/朗读/查找面板
  app.js            多格式渲染、双语引擎、TTS 控制、灯箱与阅读辅助逻辑
  style.css         明暗主题与排版样式
  vendor/           由 `npm run setup` 生成的本地浏览器依赖
prepare-vendor.js   从 node_modules 复制前端库
pack.js             @electron/packager 打包脚本（win32-x64 绿色版）
verify.js           端到端自动化验收脚本
start.bat           Windows 一键启动 Web 模式脚本
build/              应用图标（icon.ico）
```

### 配置、缓存与日志

配置与缓存均写入用户本地目录，不污染程序安装目录：
- `%LOCALAPPDATA%\media-reader\config.json`：翻译服务、语言、OpenAI 接口、TTS 音色与语速设置
- `%LOCALAPPDATA%\media-reader\text-cache.json`：文本翻译与查词缓存（上限 4,000 条）
- `%LOCALAPPDATA%\media-reader\cache\pdf\`：PDF 翻译输出缓存（90 天 / 2 GB 自动淘汰）
- `%LOCALAPPDATA%\media-reader\cache\tts\`：TTS 合成音频缓存（30 天 / 500 MB 自动淘汰）

运行日志异步批量写入并在达到 5 MB 时自动轮转：源码版位于项目根目录 `runtime.log`，打包版位于系统临时目录 `%TEMP%\media-reader.log`；访问令牌、查词及朗读原文均会脱敏处理。

### 安全与隐私设计

服务虽然只监听 `127.0.0.1`，但「本机」不等于「本应用」，因此针对本地越权与浏览器跨站攻击做了纵深防护：
- **令牌与 Cookie 鉴权**：除 `/api/health` 外，所有接口均校验 128 位随机令牌（`crypto.timingSafeEqual`）；首次 URL 令牌通过 `302` 写入 `HttpOnly; SameSite=Strict` Cookie 后抹除；外部浏览器打开文件使用 60 秒单次有效票据（`/api/ticket`）。
- **防 DNS Rebinding 与 CSRF**：严格校验回环 `Host`、拒绝跨站 `Sec-Fetch-Site` 与非本机 `Origin`。
- **严格 CSP 与内容消毒**：零外部 CDN 脚本（`script-src 'self'`）；Markdown / HTML / DOCX 经 `DOMPurify` 消毒（内置白名单兜底，剥离 `id`、内联 `style` 及危险 URI 协议）；XLSX 表格纯以 `textContent` 构建。
- **文件与路径边界**：`/api/raw` 仅对图片、音视频、PDF 和 Office 放行内联，其余类型强制附件下载并附加 `sandbox` CSP；`/api/asset` 限制仅允许媒体扩展名并通过 `realpath` 校验防符号链接越界。
- **凭据隔离**：API Key 仅保存在本地磁盘，接口仅回传 `hasKey` 状态而不回传明文。
- **隐私说明**：本机文档绝不上传；仅在使用云端翻译或 Edge TTS 朗读时向所选服务发送待处理文本。如需完全私有化的文本翻译，请在设置中改用本地 **Ollama** 等 OpenAI 兼容服务。

### 已知限制

- 主要面向 **Windows 10/11**（`win32-x64` 打包及 `where.exe` / `taskkill` 进程管理）。
- 暂不支持 `.pptx` 内联预览（仅提供下载与路径复制卡片）。
- 超大纯文本或表格文件（数千万字节级别，内联预览上限 32 MB）首次渲染会略慢。
- Bing / Google 免费网页接口非官方稳定 API，可能受网络环境或上游变动影响而限流。

### 许可证

本项目暂未添加开源许可证。

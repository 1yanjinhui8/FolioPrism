# 架构说明

FolioPrism 是一个本地优先的桌面阅读器：Electron 只负责窗口与系统集成，真正的界面是跑在 `127.0.0.1` 上的一个零依赖 Node HTTP 服务提供的网页。因此同一份前端既能在桌面窗口里跑，也能用 `npm run web` 在普通浏览器里跑。

## 分层

```text
src/
  main/index.js        Electron 主进程：窗口、菜单、单实例、文件关联、IPC
  preload/index.js     contextBridge 暴露给页面的最小接口（window.readerNative）
  server/index.js      本地 HTTP 服务：鉴权、静态资源、文件浏览、Range、翻译/TTS/PDF 接口
  translator/index.js  翻译（Bing/Google/OpenAI）、查词、Edge TTS、pdf2zh、缓存清理、uv 安装
  shared/formats.js    前后端共享的格式注册表（UMD：Node require 与浏览器 <script> 同一份）
  renderer/            纯前端，无构建步骤
    index.html
    app.js             六种渲染器 + 双语引擎 + 朗读 + 查找 + 灯箱
    style.css
    vendor/            npm run setup 从 node_modules 复制，不入库
```

依赖方向是单向的，不要反向引入：

```text
main ──▶ server ──▶ translator
  │         │
  └─────────┴──▶ shared/formats
renderer ──(HTTP / IPC)──▶ server / main
```

`renderer` 不 `require` 任何 Node 模块，只通过 HTTP 接口和 `window.readerNative` 与后端通信；`shared/formats.js` 是唯一同时被两侧加载的代码，它刻意写成 UMD，Node 侧 `require`，浏览器侧由服务端 `/shared/formats.js` 路由提供。

## 运行方式

- **桌面**：`npm start` → `src/main/index.js` 调 `server.start()` 拿到端口，窗口指向 `http://127.0.0.1:<port>/?token=…`。
- **纯浏览器**：`npm run web`（或双击 `start.bat`）直接运行 `src/server/index.js`，服务自己打开系统浏览器。
- **打包**：`npm run dist` → `scripts/pack.js` 用 `@electron/packager` 产出 `dist/FolioPrism-win32-x64/`，再用 `installer/FolioPrism.iss` 做安装包。

## 安全边界

服务只监听 `127.0.0.1`，但「本机」不等于「本应用」，所以：

- 除 `/api/health` 外都要求 128 位随机令牌；首次带 `?token=` 的访问会 302 并换成 `HttpOnly` Cookie。
- `isLocalHostHeader()` 只接受 `127.0.0.1` / `localhost`，`isCrossSiteRequest()` 拒绝跨站 `Origin` 与 `Sec-Fetch-Site`，抵御 DNS 重绑定。
- `safeJoin()` 做目录前缀校验；`/api/asset` 先 `realpath` 解开符号链接再卡扩展名白名单；`/api/raw` 对非白名单类型强制下载并加 sandbox CSP。

## 打包白名单

`scripts/pack.js` 用白名单而不是黑名单：只有 `package.json`、`src/`、`build/` 会进包。新增的调试脚本、`.env`、临时笔记默认进不去；如果漏掉了 `src/` 里的运行时代码，打包版启动会立刻报错，而不是悄悄发布一个坏包。

## 发布门禁

`scripts/verify-release.js` 在打 tag 前跑，检查版本号同步、`app.asar` 与源码的 SHA256 一致（遍历 `src/` 全部文件，不写死清单）、旧崩溃代码不存在、文件对话框筛选器覆盖全部可打开扩展名，以及 `dist/release/` 里安装包与 SHA256SUMS 的一致性。

`.github/workflows/ci.yml` 在每次 PR / push 时跑 Windows 的完整测试与 `npm run verify`，以及 Ubuntu 的单元测试。

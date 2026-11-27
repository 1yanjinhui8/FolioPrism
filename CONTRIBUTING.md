# 参与贡献

感谢你对 FolioPrism（棱阅）的兴趣。这个项目由单人维护，最需要的是**可复现的 Bug 报告**和**小而聚焦的 PR**。

## 开发环境

```bash
git clone https://github.com/1yanjinhui8/FolioPrism.git
cd FolioPrism
npm install
npm run setup     # 必须：把前端库复制到 src/renderer/vendor
npm start         # 桌面窗口
npm run web       # 纯浏览器模式
```

需要 Node.js 22+。开发与发布都以 Windows 为主平台。

## 提交前请自测

```bash
npm test          # 单元测试，必须全绿
npm run verify    # 本地服务端到端验收
```

改到打包、安装或主进程时，再补跑：

```bash
npm run dist && npm run verify:dist
npm run test:open
```

CI 会在 Windows 和 Linux 上各跑一遍单元测试，两边都必须通过。

## 目录约定

- `src/main/` — Electron 主进程
- `src/preload/` — contextBridge 接口
- `src/server/` — 本地 HTTP 服务
- `src/translator/` — 翻译 / 查词 / TTS / PDF
- `src/shared/` — 前后端共用模块（目前只有 `formats.js`，UMD）
- `src/renderer/` — 零构建的原生前端，不要引入打包工具

依赖方向是单向的：`main → server → translator`，`renderer` 只能通过 HTTP 与 IPC 访问后端。详见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 改动原则

- **不要引入前端构建步骤。** 改完刷新就能看到效果是这个项目的优势，不要为了「现代化」加 webpack/vite。
- **新文件默认不进安装包。** `scripts/pack.js` 用白名单，只放行 `package.json`、`src/`、`build/`；需要打进包的资源请放进这三个位置。
- **不要改 `installer/FolioPrism.iss` 里的 `AppId`**，升级安装靠它识别。
- 涉及安全边界的改动（鉴权、路径校验、CSP）请先开 Issue 讨论。

## 分支与提交

- 日常用 `feature/*`、`fix/*`；发布用 `release/x.y.z` 合回 `main` 后打 tag。
- `main` 受保护：只接受 PR，要求 CI 通过。
- 提交信息写清楚「为什么」，而不只是「改了什么」。

## 报告问题

- 功能缺陷请附：操作系统版本、FolioPrism 版本、复现步骤、涉及的文件类型。
- 安全漏洞请不要开公开 Issue，见 [SECURITY.md](SECURITY.md)。

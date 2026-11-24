# FolioPrism 1.5.1 改动总结

| 项目 | 内容 |
| --- | --- |
| 项目路径 | `D:\GitHub\FolioPrism` |
| 版本变更 | `1.5.0` → `1.5.1` |
| 日期 | 2026-11-24 |
| 依据 | 《FolioPrism-界面与导航重构改动总结-2026-11-24.docx》 |
| 状态 | 已实现、测试通过、产物已构建（待推送） |

## 一、改动概览

| 模块 | 解决问题 | 主要文件 |
| --- | --- | --- |
| 顶栏与原生菜单收口 | 「打开文件夹 / 打开文件」文案撞车、主次倒挂 | `main.js`、`public/index.html`、`public/app.js` |
| 「视图」菜单接管阅读设置 | 顶栏设置按钮过多，干扰阅读 | `main.js`、`preload.js`、`public/app.js` |
| 两栏布局与左侧目录栏 | 全盘文件树与右侧目录栏占用视野 | `public/index.html`、`public/style.css`、`public/app.js` |
| Web 模式替代控件 | 纯浏览器没有原生菜单栏 | `public/index.html`、`public/app.js` |
| 文档与版本 | 功能说明与版本号同步 | `README.md`、`llms.txt`、`package.json`、`installer/FolioPrism.iss` |

变更规模：7 个代码/文档文件，`+321 / -609` 行，净精简 288 行。

## 二、详细改动

### 1. 顶栏与原生菜单收口
- 移除顶栏 `#btn-open-folder`（紫色主按钮）、`#btn-open-file`、路径输入框 `#root-input` 与「前往」`#btn-go`。
- 桌面端「文件」菜单只保留 **打开文件…（`Ctrl+O`）** 与「退出」；`Ctrl+O` 从「打开文件夹」移交给「打开文件」。
- `main.js` 删除 `pickFolder()`、`menuOpenFolder()` 与 `reader:pick-folder` IPC；`preload.js` 删除 `pickFolder` / `onOpenFolder`。
- 保留 `reader:set-current-root` 与 `syncRootState()`，`Ctrl+O` 弹窗仍默认定位到上次打开文件所在目录。

### 2. 「视图」菜单接管阅读设置
- `main.js` 新增 `sendViewAction()`，通过 `reader:view-action` 下发 `font-inc` / `font-dec` / `toggle-width` / `translate-settings`。
- `preload.js` 新增 `onViewAction(cb)` 订阅。
- 「视图」菜单顶部加入 **增大字号（A+）、减小字号（A-）、切换阅读宽度、翻译设置…**；原页面缩放改名为「放大页面 / 缩小页面 / 实际大小」以示区分。
- 顶栏右侧仅保留 **🔊 朗读、双语、主题** 三个高频按钮。

### 3. 两栏布局与左侧目录栏
- 删除左侧文件树 `#tree`、「此电脑 / 上一级」、最近文件夹 `#recent`、隐藏项 / 依赖 / 刷新工具栏，以及右侧目录栏 `#toc-rail`。
- `#layout` 由三列改为 `260px minmax(0, 1fr)` 两栏；左侧 `#sidebar` 改为「继续阅读 + 文档目录」。
- 新增目录收起按钮 `#btn-toc`（目录 «）与顶栏展开按钮 `#btn-toc-expand`（目录 »）；`body.toc-off` 同步控制侧栏显隐、展开按钮出现时机与 `aria-expanded`，状态存入 `localStorage`（`media-reader/tocOff`）。
- 窄屏（≤ 780px）下目录自动切换为侧滑抽屉。

### 4. 前端清理与空状态
- `public/app.js` 删除文件树渲染、路径栏、最近文件夹等逻辑（净减约 400 行）。
- 新增 `clearToc(hint)`：无标题文档渲染 `<div class="toc-empty">`，不生成空 `<a>`，保证 `stats.tocItems === 0`。
- 新增 `stepFont(delta)`、`toggleWide()` 与对应 Toast 提示。
- 对已移除的 DOM 元素与单元测试沙箱补充空值与能力判断；欢迎文案改为提示通过「文件 → 打开文件…」、拖拽或「继续阅读」打开文档。

### 5. Web 模式替代控件
- 桌面端在 HTML 阶段即对 `#btn-web-open-file` 与 `#web-view-menu` 标记 `hidden`，避免启动闪现。
- 仅在非 Electron 模式下展示顶栏「📄 打开文件」与「视图 ▾」下拉（字号 / 宽度 / 翻译设置），点击外部自动关闭。
- `server.js` 的 `/api/browse` 保持原样，既有服务端测试与端到端校验继续兼容。

### 6. 版本与文档
- `package.json`、`installer/FolioPrism.iss`（`AppVersion`、`VersionInfoVersion`）同步到 `1.5.1`。
- `README.md` 中英文功能说明、`llms.txt` 最新版本与版本历史同步更新。

## 三、测试与门禁

| 验证 | 结果 |
| --- | --- |
| `npm test` | 25/25 通过 |
| `node verify.js` | 4 PASS / 0 FAIL / 3 SKIP（未传样本 Markdown 时跳过） |
| 源码版 Electron 冒烟（`npm run test:open`） | 通过（16 项 + 新布局断言） |
| 打包版 Electron 冒烟（`node test/open_file_smoke.js --packaged`） | 通过 |
| `node verify-release.js --require-release` | 9/9 PASS |

冒烟测试新增断言：顶栏与文件树/路径栏/右侧栏相关 ID 必须不存在；`#btn-read` / `#btn-bilingual` / `#btn-theme` 保留；Web 专属菜单在 Electron 下保持隐藏；左侧目录可收起/展开；Markdown 标题填充 `#sidebar #toc`。

## 四、发布产物（`dist\release\`）

| 文件 | 大小（字节） | SHA256 |
| --- | --- | --- |
| `FolioPrism-1.5.1-win32-x64-setup.exe` | 112,984,350 | `cc392d6f47bd71da07bdfcd4ef5244a51f38cc450f90e4873dda82956ee9ce70` |
| `FolioPrism-1.5.1-win32-x64-portable.zip` | 155,792,175 | `b3846b2eb66c2978cc171f8823c14891e5abfd4deb313085dc42e9257a7ddb63` |
| `SHA256SUMS.txt`、`RELEASE_NOTES_1.5.1.md` | — | — |

## 五、遗留与注意

- 安装包的文件关联注册表项已随 Inno Setup 编译，但尚未在真实机器上安装并手工验证「打开方式」与默认应用列表。
- `test:e2e`（真实联网 TTS）本次未重跑。
- 仓库根目录的《开源增长作战手册》`.docx` / `.pdf` 与本次改动无关，未纳入提交。

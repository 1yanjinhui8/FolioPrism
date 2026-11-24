# FolioPrism 1.5.0 改动总结

| 项目 | 内容 |
| --- | --- |
| 项目路径 | `D:\GitHub\FolioPrism` |
| 版本变更 | `1.4.1` → `1.5.0` |
| 日期 | 2026-11-24 |
| 依据 | 《FolioPrism-1.5.0-下次改动方案》 |
| 状态 | 已实现、测试通过、产物已构建（未执行 `git commit` / `git push`） |

## 一、改动概览

| 模块 | 解决问题 | 主要文件 |
| --- | --- | --- |
| 统一格式注册表 | P1-1、P2-3、NEW-4、NEW-5 | `public/formats.js`（新增） |
| 渲染补齐与边界修复 | NEW-1、P2-2、P2-4、NEW-3 | `public/app.js`、`public/style.css` |
| 目录浏览与侧栏 | P1-2、P2-1、NEW-2 | `server.js`、`public/index.html`、`public/app.js` |
| 对话框同步 / 打开文件 / Web 预览 | P1-3、P1-4 | `main.js`、`preload.js`、`public/app.js` |
| 命令行加固与文件关联 | P1-5、NEW-6 | `main.js`、`installer/FolioPrism.iss` |
| 文档、测试、门禁 | P2-6 | `README.md`、`llms.txt`、`test/*`、`verify-release.js` |

## 二、详细改动

### 1. 统一格式注册表 `public/formats.js`
- UMD 模块，Node（`require`）与浏览器（`window.FolioFormats`）共用，成为 `main.js`、`server.js`、`app.js`、测试的唯一格式来源。
- 导出：`IMAGE/VIDEO/AUDIO/DOCX/SHEET/CODE/PLAIN_TEXT/TEXT_EXT`、`INLINE_RAW_EXT`、`ASSET_EXT`、`OPENABLE_EXT`（95 个）、`FILE_DIALOG_FILTERS`、`FILE_ASSOCIATION_EXTS`。
- 工具函数：`baseNameOf`、`dirOf`、`extOf`、`kindOf`、`isTextFile`、`serverKindFor`、`hljsLangFor`。
- 支持点文件（`.gitignore`、`.env`、`.env.*`、`.editorconfig`、`.npmrc` 等）和无扩展名文件（`Makefile`、`Dockerfile`、`LICENSE`、`README`、`CHANGELOG` 等）；修复 `path.extname('.gitignore') === ''`。
- 视频新增 `mkv`、`ogv`；音频 `mp3/wav/m4a/flac/ogg`。

### 2. 前端渲染与边界（`public/app.js`、`style.css`）
- 新增 `renderAudioFile()` 音频播放器卡片及音频错误兜底。
- `openFile()` 改按 `kindOf()` 分流。
- `dirOf()` 正确处理盘根（`D:\a.txt` → `D:\`）与 UNC 共享根；`isAncestor` 去重尾部反斜杠，盘根下文件可自动展开。
- `api()` 解析服务端 JSON，附带 `err.status` / `err.code`；413 时展示 `renderTooLarge()` 友好卡片（下载 / 复制路径），不再出现红色错误卡和无效重试。
- Markdown / HTML / 文本 / DOCX / XLSX 渲染拆分为"数据 → DOM"函数，供服务端路径与本地 File 共用。

### 3. 目录浏览与侧栏
- `/api/browse` 新增 `hidden=1`、`deps=1` 开关，并始终返回 `hiddenCount`、`depsHiddenCount`；`ext` 改用 `formats.extOf`。
- `stat` 失败不再丢弃，返回 `unreadable: true` + `error`，前端灰显（`.tree-unreadable`）并标注原因。
- 侧栏新增「隐藏项」「依赖」开关（状态存 `localStorage`）与"已隐藏 N 项"提示；目录仅含隐藏项时给出专门提示。
- 点击「此电脑 / 上一级」同步 `state.root`、输入框、`LS.lastRoot` 与主进程目录。

### 4. 对话框同步、打开文件、Web 本地预览
- 主进程新增 `currentRoot`，IPC：`reader:set-current-root`、`reader:pick-file`；`pickFolder` / `pickFile` 起始目录优先使用当前浏览目录。
- 原生文件筛选器改用 `formats.FILE_DIALOG_FILTERS`（5 组）。
- 顶栏新增「打开文件」按钮：Electron 走原生对话框；Web 模式走 `<input type=file>` + `openWebLocalFile()`，用 `File API` 本地预览文本/代码（UTF-8 / BOM / UTF-16 / GBK / Latin1）、Markdown、HTML、DOCX、XLSX、PDF、图片、音频、视频；切换文件时释放 `Blob URL`，不写入磁盘路径历史。
- 拖入文件在无法取得真实路径时自动回退本地预览。
- CSP 为 `media-src` 与 `frame-src` 增加 `blob:`。

### 5. 命令行与 Windows 文件关联
- `extractFileArg(argv, cwd)`：支持相对路径（基于 `workingDirectory`）、中文/空格路径、`--` 分隔符、排除应用目录与入口脚本。
- `second-instance` 传入 `workingDirectory`；窗口未就绪时也通过 `openFileInRenderer` 暂存文件。
- `installer/FolioPrism.iss`：`ChangesAssociations=yes`、`registerassoc` 任务、`HKCU` 下 `ProgID`、`OpenWithProgids`、`Applications`、`Capabilities`、`RegisteredApplications`；不强行覆盖默认程序，卸载自动清理，无需管理员权限。

### 6. 文档与版本
- `package.json`、`installer/FolioPrism.iss`、`README.md`（中英）、`llms.txt` 同步到 1.5.0；`npm test` 纳入 `formats_unit.test.js`。

## 三、测试与门禁

| 验证 | 结果 |
| --- | --- |
| `npm test`（TTS + 文本渲染 + 格式注册表，共 25 项） | 25/25 通过 |
| 源码版 Electron 文件打开冒烟（16 项） | 全部通过 |
| 打包版 Electron 文件打开冒烟（16 项） | 全部通过 |
| `node verify.js`（服务端端到端） | 7/7 通过 |
| `node verify-release.js --require-release` | 9/9 PASS |

新增 / 更新的测试：`test/formats_unit.test.js`（注册表一致性、点文件/无扩展名、`dirOf`、`extractFileArg`、`/api/browse` 开关与不可读项、`/api/read` 413）；`text_render_unit.test.js`（点文件、无扩展名、音频、413 卡片、Web 本地 File）；`open_file_smoke.js`（新增 Makefile / Dockerfile / LICENSE / .gitignore / .env / .wav / Web File）；`verify-release.js`（加入 `formats.js` 哈希比对与筛选器全覆盖校验）。

测试过程中修复的两个问题：`extOf` 对 `.clang-format` 这类含连字符扩展名识别失败；测试沙箱缺少 `TextDecoder` 等全局对象。另将 `open_file_smoke.js` 源码版启动改为 `electron <ROOT_DIR>`、工作目录设为临时目录，以便在受限环境运行。

## 四、发布产物（`dist\release\`）

| 文件 | 大小（字节） | SHA256 |
| --- | --- | --- |
| `FolioPrism-1.5.0-win32-x64-setup.exe` | 111,902,284 | `db0e41b28791dc8a71e54703cbb16aa1a1885198f1caeb7f6445cf3ea3a6222a` |
| `FolioPrism-1.5.0-win32-x64-portable.zip` | 163,438,602 | `6dbc236f39548eb10c36a9eeb543791f4e635921605e02ac6e3800af4f4c7391` |
| `SHA256SUMS.txt`、`RELEASE_NOTES_1.5.0.md` | — | — |

## 五、遗留与注意

- 未执行 `git commit` / `git push`，需要时请另行指示。
- `npm run setup`（`prepare-vendor.js`）在当前沙箱因 `EPERM` 无法覆盖 `public/vendor`，已存在的 vendor 文件可正常使用；`test:e2e`（真实联网 TTS）与 `test:packaged` 本次未重跑。
- 安装包的文件关联注册表项已通过 Inno Setup 编译，但尚未在真实机器上安装并手工验证"打开方式"与默认应用列表。

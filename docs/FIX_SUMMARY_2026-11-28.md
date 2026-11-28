# 修复总结（2026-11-28）

本次改动针对 FolioPrism（棱阅）在单元测试依赖、前端 vendor 自动准备、纯 Node 环境下隐式触发 Electron 加载以及 `README.md` 测试说明同步等四个问题完成修复与验证。

---

## 一、修复内容总览

| 编号 | 问题摘要 | 修改文件 | 修复方案 |
|---|---|---|---|
| R1 | 单元测试中 `xlsx` 硬编码读取 `src/renderer/vendor/` | `test/text_render_unit.test.js` | `createDomHarness({ withXlsx: true })` 优先检查 `src/renderer/vendor/xlsx.full.min.js`，不存在时自动回退至 `require.resolve('xlsx/dist/xlsx.full.min.js')` |
| R2 | 缺少自动准备前端 vendor 的生命周期钩子 | `package.json` | 在 `scripts` 中补充 `postinstall`、`preverify`、`pretest`，与已有 `setup`、`predist` 一并调用 `node scripts/prepare-vendor.js` |
| R3 | 纯 Node 单元测试导入 `src/main` 时隐式触发 `require('electron')` | `src/main/index.js` | 将顶层 `require('electron')` 守卫为仅当 `process.versions.electron` 存在时执行 |
| R4 | `README.md` 中英文「测试 / Tests」章节与实际行为脱节 | `README.md` | 同步更新英文 `### Tests` 与中文 `### 测试` 章节，移除不准确的 `"self-contained"` 描述，补充 `npm run verify` 与完整执行顺序及钩子说明 |

---

## 二、各修复详情

### 1. R1：解除单元测试对 `src/renderer/vendor/xlsx.full.min.js` 的强耦合
- **文件**：`test/text_render_unit.test.js`（`createDomHarness`，原 L486–490）
- **原因**：`createDomHarness({ withXlsx: true })` 原本直接读取 `src/renderer/vendor/xlsx.full.min.js`。当仅执行 `npm install` 而未生成 `src/renderer/vendor/` 时，直接运行 `node --test test/text_render_unit.test.js` 会因文件缺失抛出 `ENOENT`。
- **修改**：
  - 先构造 `vendorXlsx = path.join(ROOT_DIR, 'src', 'renderer', 'vendor', 'xlsx.full.min.js')`；
  - 使用 `fs.existsSync(vendorXlsx) ? vendorXlsx : require.resolve('xlsx/dist/xlsx.full.min.js')` 选择加载路径 `xlsxPath`；
  - 读取 `xlsxPath` 并以 `{ filename: xlsxPath }` 传入 `vm.runInNewContext`。
- **效果**：`renderSheetBuffer` 表格图片测试（WPS `DISPIMG` 与标准 Excel 浮动锚点图片）在 `src/renderer/vendor/xlsx.full.min.js` 存在或缺失两种情况下均可正常通过。

### 2. R2：补充 `package.json` vendor 自动准备钩子
- **文件**：`package.json`（`scripts` 字段）
- **修改**：在保留原有 `"setup"` 与 `"predist"` 的基础上，新增：
  - `"postinstall": "node scripts/prepare-vendor.js"`
  - `"preverify": "node scripts/prepare-vendor.js"`
  - `"pretest": "node scripts/prepare-vendor.js"`
- **效果**：`npm install` 安装后会自动就绪 `src/renderer/vendor/` 下的全部 7 个前端静态资源；即使手动删除或跳过 `postinstall`，运行 `npm test`（`pretest`）、`npm run verify`（`preverify`）或 `npm run dist`（`predist`）前也会自动幂等补齐。

### 3. R3：消除纯 Node 单元测试中的隐式 Electron 加载
- **文件**：`src/main/index.js`（第 15 行）
- **原因**：`test/formats_unit.test.js`（导入 `extractFileArg`）与 `test/pdf_fixes_unit.test.js`（导入 `readSystemTextScale`）会执行 `require('../src/main')`。此前 `src/main/index.js` 顶层无条件执行 `require('electron')`，在纯 Node 环境下会进入 `node_modules/electron/index.js`，在未下载二进制时可能触发 Electron 下载/解压，甚至导致并发 `node --test` 出现 `os error 183` 解压冲突。
- **修改**：将第 15 行由 `const electron = require('electron');` 改为：
  ```js
  const electron = process.versions.electron ? require('electron') : null;
  ```
- **效果**：纯 Node 进程加载 `src/main` 时不再加载 `electron` 模块；Electron 主进程环境下 `process.versions.electron` 始终存在，原有桌面运行时逻辑保持不变。

### 4. R4：同步 `README.md` 中英文测试文档
- **文件**：`README.md`（英文 `### Tests` 与中文 `### 测试`）
- **修改**：
  - 移除了不准确的 `` `npm test` is self-contained. `` 表述，明确说明在完成 `npm install` 后，`npm test` 可在纯 Node.js 下离线运行、不触发 Electron 加载，且 `xlsx` 优先读取 `src/renderer/vendor/`、缺失时自动回退至 `node_modules/xlsx`；
  - 在中英文命令列表中补充 `npm run verify`；
  - 明确说明 `npm install` → `npm run setup`（及 `postinstall`、`pretest`、`preverify`、`predist` 自动钩子）→ `npm test` / `npm run verify` 的先后顺序与依赖关系。

---

## 三、变更文件清单

- 修改文件（4 个）：
  - `test/text_render_unit.test.js`
  - `package.json`
  - `src/main/index.js`
  - `README.md`
- 新增文件（1 个）：
  - `docs/FIX_SUMMARY_2026-11-28.md`（本文档）

---

## 四、验证记录

以下验证均在完成全部代码与 `README.md` 修改后实测执行：

1. **纯 Node Electron 加载守卫检查**
   - 命令：
     ```bash
     node -e "const m = require('./src/main'); const hits = Object.keys(require.cache).filter(k => k.includes('electron')); console.log(Object.keys(m), hits); if (hits.length) process.exit(1);"
     ```
   - 结果：退出码 `0`，输出 `[ 'extractFileArg', 'readSystemTextScale' ] []`（`require.cache` 中无任何 `electron` 命中）。

2. **`xlsx` 缺失回退路径测试（绕过 `pretest` 直接执行单测）**
   - 操作：临时将 `src/renderer/vendor/xlsx.full.min.js` 移至系统临时目录，确认 `src/renderer/vendor/xlsx.full.min.js` 不存在（`EXISTS_AFTER_MOVE=False`），随后执行：
     ```bash
     node --test test/text_render_unit.test.js
     ```
   - 结果：退出码 `0`，全部 7 项测试通过（`tests 7, pass 7, fail 0`），包含 `renderSheetBuffer` 的 WPS `DISPIMG` 与标准 Excel 浮动锚点图片两项测试。

3. **`pretest` 自动补齐与全量单元测试**
   - 操作：在 `src/renderer/vendor/xlsx.full.min.js` 仍处于缺失状态时直接运行：
     ```bash
     npm test
     ```
   - 结果：退出码 `0`。`pretest` 自动执行 `node scripts/prepare-vendor.js`，重新补齐 `src/renderer/vendor/` 下全部 7 个文件（`marked.min.js`、`highlight.min.js`、`hljs-github.min.css`、`hljs-github-dark.min.css`、`mammoth.browser.min.js`、`xlsx.full.min.js`、`purify.min.js`）；4 个单元测试文件共 32 项测试全部通过（`tests 32, pass 32, fail 0`）。

4. **`preverify` 与本地 HTTP 端到端验收**
   - 命令：
     ```bash
     npm run verify
     ```
   - 结果：退出码 `0`。`preverify` 自动执行 `node scripts/prepare-vendor.js` 确认 7 个 vendor 文件就绪；本地服务（端口 `7789`）验收输出 `PASS=5 FAIL=0 SKIP=3`（`/api/health`、`GET /`、`/shared/formats.js`、`/vendor/marked.min.js`、`/vendor/highlight.min.js` 全部通过；未指定样本路径故样本相关 3 项标记 `SKIP`）。

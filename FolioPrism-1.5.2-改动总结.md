# FolioPrism 1.5.2 改动总结

| 项目 | 内容 |
| --- | --- |
| 项目路径 | `D:\GitHub\FolioPrism` |
| 版本变更 | `1.5.1` → `1.5.2` |
| 日期 | 2026-11-26 |
| 状态 | 已实现、测试通过、产物已构建并校验 |

## 一、改动概览

| 模块 | 解决问题 | 主要文件 |
| --- | --- | --- |
| WPS 嵌入式单元格图片 | `=DISPIMG("ID_...",1)` 只显示公式文本 | `public/app.js` |
| 标准 Excel 浮动图片 | 锚定到单元格的图片不显示 | `public/app.js` |
| WPS 保留隐藏表 | `WpsReserved_CellImgList` 出现在标签栏 | `public/app.js` |
| 图片样式与灯箱 | 单元格图片尺寸、点击放大 | `public/style.css`、`public/app.js` |
| 安全与内存 | 外链 / SVG 拦截、Blob URL 回收 | `public/app.js` |
| 版本与文档 | 版本号、发布说明同步 | `package.json`、`installer/FolioPrism.iss`、`llms.txt`、`README.md` |

变更规模：7 个文件，`+717 / -24` 行（核心 `public/app.js` 为 `+413 / -15`）。

## 二、详细改动

### 1. WPS 嵌入式单元格图片（`=DISPIMG`）

- 新增 `extractXlsxImages(wb)`：`XLSX.read(input, { type: 'array', bookFiles: true })` 一次解包，所有 ZIP 条目进入 `wb.files`。
- 解析 `xl/_rels/workbook.xml.rels` 找到 `cellImage` 关系 → `xl/cellimages.xml`，再读 `xl/_rels/cellimages.xml.rels`：
  `cNvPr[name]`（`ID_*`）→ `a:blip[r:embed]` → `Relationship[Target]` → `xl/media/*` 字节流。
- 兜底扫描 `xl/drawings/*.xml` 中的 `pic` 映射，兼容把 `ID_*` 映射放在 drawing 里的 WPS 变体。
- 识别 `rawCell.f` 与单元格文本中的 `DISPIMG("ID_...",1)`，兼容 `_xlfn.` 前缀、有无前导 `=`、单双引号。
- 渲染为 `img.sheet-cell-img`；找不到映射或加载失败时降级为 `.sheet-img-fallback`「图片无法显示」，不再显示 `DISPIMG` 公式文本。

### 2. 标准 Excel 浮动图片

- 沿 `工作表 → sheetN.xml.rels → drawingN.xml（及其 rels）` 解析 `oneCellAnchor` / `twoCellAnchor`，读取 `<from><row>/<col>`，把图片挂到对应行列单元格。
- 同一单元格可叠加多张浮动图；工作表只有浮动图、没有 `!ref` 时，按锚点自动扩展渲染范围（行 +200、列 +50 上限，防止异常文件撑爆表格）。

### 3. 隐藏 WPS 保留表

- 过滤 `Workbook.Sheets[i].Hidden === 2`（veryHidden）与 `WpsReserved_CellImgList`。
- 全部工作表都被过滤时回退显示全部，避免出现空白标签栏。

### 4. 安全与内存

- `parseXmlRels` 跳过 `TargetMode="External"` 的外链关系，避免外部追踪请求。
- 媒体后缀白名单（png/jpg/jpeg/gif/webp/bmp/avif）；无扩展名或 `.bin`/`.dat` 时才做魔数嗅探；拒绝 `.svg` / `.xml` 等潜在脚本载体。
- 同一媒体路径的 URL 在工作簿内缓存复用；浏览器环境创建 `Blob URL` 并登记到 `state.activeBlobUrls`，切换文件（`cleanupActiveMedia`）与页面卸载（`beforeunload`）时统一 `revokeObjectURL`。
- 无 `Blob` 的沙箱环境回退 `data:<mime>;base64,...`。
- 传入 `Uint8Array` 而非裸 `ArrayBuffer`：规避 SheetJS 0.18.5 开启 `bookFiles` 时跨 VM/Realm 的 `RangeError: Invalid array length`。

### 5. 样式与交互

- `.sheet-cell-img`：最大 180×180、保持纵横比、居中、圆角、`cursor: zoom-in`、悬停轻微放大、多图纵向间距。
- 点击表格图片进入现有灯箱（`state.lightboxItems` 重置后按当前工作表登记，`bindZoom` 绑定索引）。
- 首屏 6 张 `loading="eager"`，其余懒加载。

### 6. 版本与文档

- `package.json`、`installer/FolioPrism.iss`（`AppVersion`、`VersionInfoVersion`）同步到 `1.5.2`。
- `llms.txt` 最新版本与版本历史、`README.md` 中英文 Office 表格说明同步更新。
- `package-lock.json` 按仓库惯例未随版本号改动。

## 三、测试与门禁

| 验证 | 结果 |
| --- | --- |
| `npm test` | 27/27 通过 |
| `node verify.js` | 4 PASS / 0 FAIL / 3 SKIP（未传样本 Markdown） |
| `node verify-release.js --require-release` | 9/9 PASS |
| 真实文件端到端（`01.小橘猫系列.xlsx`） | 31/31 图片加载；无 `DISPIMG` 文本；仅 `Sheet1`；灯箱可用；切文件 Blob 全回收 |
| 打包产物 CDP 验证（`dist/FolioPrism-win32-x64/FolioPrism.exe`） | 31/31 图片加载；0 console error；0 页面异常；灯箱与 Blob 回收正常 |

新增单元测试 2 项：

1. WPS `DISPIMG`：图片渲染、隐藏表过滤、灯箱、Web 本地 File 预览、外链与 SVG 拦截、切换文件回收 `Blob URL`。
2. 标准 Excel 浮动锚点图：`twoCellAnchor` 图片落到对应单元格。

## 四、发布产物（`dist\release\`）

| 文件 | 大小（字节） | SHA256 |
| --- | --- | --- |
| `FolioPrism-1.5.2-win32-x64-setup.exe` | 111,906,455 | `408138de1bc6e7c872b12261e5bbd3ffb4916d11c8744fc2eb1c3ad376e951e8` |
| `FolioPrism-1.5.2-win32-x64-portable.zip` | 158,814,340 | `09f4843092c5b999091648c50db372621dd3523a63d2ec28110136b30e629686` |
| `SHA256SUMS.txt`、`RELEASE_NOTES_1.5.2.md` | — | — |

## 五、遗留与注意

- 标准 Excel 的 `absoluteAnchor`（不绑定单元格的绝对定位图片）不渲染；`oneCellAnchor` / `twoCellAnchor` 已覆盖。
- EMF/WMF 等浏览器无法解码的矢量图会降级为「图片无法显示」，这是有意的安全白名单行为。
- `test:e2e`（真实联网 TTS）本次未重跑。
- 仓库根目录的 README 截图素材（`assets/`、`pack.js` 忽略规则）属于另一批工作，未纳入本次提交。

# 媒体阅读器

一个跑在本机的多媒体文档阅读器：用 Electron 做窗口，用 Node 内置的 `http` 模块做本地服务，不需要数据库，也不依赖云服务。

主要面向「把一堆 Markdown / PDF / Office 文档放在文件夹里，想按目录连续阅读」的场景，尤其是英文论文和技术文档的双语阅读。

## 功能

- **多种格式**：Markdown、HTML、PDF、DOCX、XLSX/XLS、PPTX（文本）、代码文件、纯文本
- **图片与音视频**：Markdown 里的相对路径图片、网络图片、本地视频和音频直接在页面里播放
- **双语阅读**：逐句对照翻译，支持「双语 / 仅译文 / 关闭」三态；可切换多种目标语言
- **PDF 翻译**：调用 [PDFMathTranslate](https://github.com/Byaidu/PDFMathTranslate)（`pdf2zh`）生成保留原排版的译文 PDF，公式、表格、图片留在原位
- **朗读**：基于 Edge 神经语音，可暂停、调语速，PDF 也能按页朗读
- **阅读辅助**：文章目录、字号 / 阅读宽度切换、明暗主题、阅读进度
- **站内查找**：`Ctrl+F` 在文档中查找，`Enter` / `Shift+Enter` 跳转匹配项
- **继续阅读**：记住每个文档的阅读位置，下次打开直接回到原处
- **视频续播**：记住本地视频的播放进度
- **本地优先**：所有文件都从本机读取，不上传；翻译时只把需要翻译的文本发给所选翻译服务

## 环境要求

- Windows 10/11
- Node.js 20 或更高版本（建议 22 LTS）
- npm

文本翻译开箱即用（默认 Bing 免费接口，Google 作为备用）。以下功能需要额外安装工具，阅读器里可以一键安装：

- `pdf2zh`：PDF 翻译，通过 `uv` 安装
- `edge-tts`：语音朗读，通过 `uv` 安装

## 快速开始

```bash
npm install
npm run setup
npm start
```

`npm run setup` 会把浏览器版依赖（marked、highlight.js、mammoth、xlsx、DOMPurify）从 `node_modules` 复制到 `public/vendor/`。首次运行或升级依赖后都要执行。

### 只用浏览器打开

```bash
npm run web
```

服务默认监听 `127.0.0.1:7788`，启动后会自动打开浏览器。首次访问的 URL 里带一次性令牌，服务端校验后会写入 HttpOnly Cookie 并从地址栏移除。

可用参数：

```bash
node server.js --port=8080 --root="D:\Documents" --no-open
```

## 打包 Windows 桌面版

```bash
npm run dist
```

产物在 `dist/媒体阅读器-win32-x64/`，整个目录拷到别的 Windows 电脑上双击 `媒体阅读器.exe` 即可运行，目标机器不需要安装 Node.js。打包过程需要联网下载 Electron 运行时。

## 验收脚本

```bash
node verify.js "D:\path\to\sample.md"
```

脚本会启动一个临时服务，检查健康接口、静态资源、目录浏览、全文读取和 Markdown 图片引用。不传样本路径时，与样本相关的检查会标记为 SKIP。

可用环境变量微调断言：

- `READER_EXPECT_REFS`：样本期望的图片引用数量
- `READER_MIN_MD_FILES`：样本目录期望的最少 Markdown 文件数
- `READER_MIN_READ_BYTES`：全文读取的最小字节数

## 目录结构

```
main.js            Electron 主进程：窗口、菜单、原生文件夹对话框
preload.js         contextBridge 暴露的最小 IPC 接口
server.js          本地 HTTP 服务：文件浏览、渲染、鉴权、静态资源
translator.js      翻译、PDF 翻译、Edge TTS、引擎安装
public/            前端页面
  index.html
  app.js           渲染与交互逻辑
  style.css
  vendor/          由 npm run setup 生成
verify.js          端到端验收脚本
pack.js            @electron/packager 打包脚本
prepare-vendor.js  复制浏览器版依赖
build/             应用图标
```

## 配置与缓存

配置和缓存写在用户目录，不写程序目录：

- `%LOCALAPPDATA%\media-reader\config.json`：翻译服务、语言、语音等设置
- `%LOCALAPPDATA%\media-reader\cache\`：PDF 翻译与语音缓存
- `%LOCALAPPDATA%\media-reader\text-cache.json`：文本翻译缓存

打包版运行日志写到系统临时目录的 `media-reader.log`；源码版写到项目根目录的 `runtime.log`（已在 `.gitignore` 中忽略）。

## 安全设计

服务只监听 `127.0.0.1`，但「本机」不等于「本应用」，所以做了以下限制：

- 除 `/api/health` 外的接口都要求随机访问令牌，令牌保存在 HttpOnly、SameSite=Strict 的 Cookie 中
- 首次访问的令牌通过 302 从 URL 移除
- 校验 Host、Origin、`Sec-Fetch-Site`，拒绝跨站请求和 DNS rebinding
- 严格的 CSP；不加载任何 CDN 脚本
- Markdown / DOCX / HTML 渲染结果统一用 DOMPurify 消毒；XLSX 用 `textContent` 构建表格
- 原始文件接口只放行图片、音视频、PDF 和 Office 文档，并做路径与 `realpath` 校验
- 外链只允许 `http` / `https`，由系统浏览器打开

## 翻译与隐私

- 文本翻译默认走 Bing 网页翻译接口，失败时尝试 Google；也可以在设置里改用 OpenAI 兼容接口（DeepSeek、GPT、本地 Ollama 等）
- 翻译会把当前文档的文本发送给所选服务；不希望外发时，请改用本地 OpenAI 兼容服务
- 朗读会把文本发送给 Edge 语音服务
- PDF 翻译由本机的 `pdf2zh` 完成，模型和依赖可能需要联网下载
- Bing / Google 的免费接口不是官方稳定 API，可能因网络或接口变动失效

## 已知限制

- 主要面向 Windows；打包脚本目前只生成 win32-x64
- PPTX 只提取文字，不渲染版式
- 超大文档（几十 MB 的 Markdown / 表格）首次渲染会慢一些

## 许可证

本项目暂未添加开源许可证。

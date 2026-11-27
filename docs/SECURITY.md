# 安全模型

## 威胁模型

FolioPrism 在本机跑一个 HTTP 服务来给界面提供内容。它面对的不是「外网攻击者」，而是**同机的其他程序**和**浏览器里打开的任意网页**：

- 任何本地进程都能访问 `127.0.0.1` 上的任意端口；
- 浏览器里的恶意页面可以通过 DNS 重绑定把请求发到本机端口；
- 服务端的 `/api/raw` 能读取用户有权限读取的任意文件，一旦被利用后果严重。

因此不能把「只监听回环地址」当成安全措施。

## 现有防护

| 风险 | 措施 |
|---|---|
| 其他程序直接调接口 | 除 `/api/health` 外全部要求 128 位随机令牌，`timingSafeEqual` 比对 |
| 令牌泄漏到地址栏 / 历史 | 首次 `?token=` 访问后 302 到无令牌地址，令牌写进 `HttpOnly; SameSite=Strict` Cookie |
| DNS 重绑定 | `isLocalHostHeader()` 只接受 `127.0.0.1` / `localhost` |
| 跨站请求 | `isCrossSiteRequest()` 拒绝跨站 `Origin` 与 `Sec-Fetch-Site` |
| 路径遍历 | `safeJoin()` 目录前缀校验；`/api/asset` 先 `realpath` 再卡扩展名白名单 |
| 任意文件当 HTML 执行 | `/api/raw` 对非白名单类型强制 `Content-Disposition: attachment` 并加 sandbox CSP |
| 渲染进程提权 | `contextIsolation: true`、`nodeIntegration: false`，preload 只暴露必要方法 |
| Markdown 里的原始 HTML | DOMPurify 消毒后再进 DOM，文档侧 `style` 属性统一剥离 |
| 外链在应用窗口打开 | `setWindowOpenHandler` / `will-navigate` 一律交给系统浏览器 |

## 已知缺口

- 主进程 `webPreferences` 尚未设置 `sandbox: true`。补上这一行即可让渲染进程运行在 Chromium 沙箱内，建议尽快加上。

## 报告问题

发现安全问题请通过 GitHub Issue 私密报告（Security → Report a vulnerability），不要在公开 Issue 里贴可利用细节。

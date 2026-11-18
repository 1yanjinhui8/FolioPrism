'use strict';

/**
 * FolioPrism（棱阅）—— 服务端
 * 只用 Node 内置模块，零第三方依赖。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const os = require('node:os');
const crypto = require('node:crypto');
const translator = require('./translator');

const __dir = __dirname;
const PUBLIC_DIR = path.join(__dir, 'public');
const VENDOR_DIR = path.join(PUBLIC_DIR, 'vendor');
/** 打包成 asar 后 __dirname 是只读的，日志只能落到系统临时目录 */
const LOG_FILE = __dir.includes('app.asar')
  ? path.join(os.tmpdir(), 'folioprism.log')
  : path.join(__dir, 'runtime.log');
/**
 * 图片兜底目录：新名字优先，旧名字保留兼容——
 * 改名之前用户放在 media-reader-images 里的图片不该突然找不到。
 */
const FALLBACK_IMAGE_ROOTS = [
  path.join(os.homedir(), 'Pictures', 'FolioPrism-images'),
  path.join(os.homedir(), 'Pictures', 'media-reader-images'),
];

/** 默认文档根目录：启动时可用 --root= 覆盖 */
const DEFAULT_ROOT = path.join(os.homedir(), 'Documents');

/** /api/browse 的虚拟路径：列出本机所有磁盘根，让用户能从「此电脑」开始浏览 */
const DRIVES_PATH = '__DRIVES__';

/**
 * 本机访问令牌。
 *
 * 服务虽然只监听 127.0.0.1，但「本机」并不等于「本应用」：任何本地程序、
 * 浏览器里的任意网页（DNS rebinding）都能访问这个端口，而 /api/raw 能读全盘。
 * 所以除 /api/health 外的接口和首页都要求令牌；Electron 启动时把令牌放在
 * 首次加载的 URL 里，服务端校验后写进 HttpOnly Cookie，页面里的 <img>/<audio>/
 * <iframe> 等子资源请求会自动带上，不需要前端逐个拼接。
 */
let ACCESS_TOKEN = crypto.randomBytes(16).toString('hex');
const ACCESS_COOKIE = 'mr_token';

const CSP =
  "default-src 'self'; " +
  // 只为本地 public/vendor 里的库放行，不再允许 CDN 脚本
  "script-src 'self'; " +
  // 进度条宽度、取词浮层定位、字号变量都用 element.style 动态设置，
  // 去掉 unsafe-inline 会让这些交互全部失效；文档侧的 style 属性已在
  // Markdown/DOCX/HTML/XLSX 四条渲染路径里统一剥离。
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob: https: http:; " +
  "media-src 'self' https: http:; " +
  "font-src 'self' data:; " +
  "connect-src 'self'; " +
  "frame-src 'self' https://player.bilibili.com https://www.youtube.com; " +
  "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/* ------------------------------------------------------------------ */
/* 启动参数                                                             */
/* ------------------------------------------------------------------ */

let PORT = 7788;
let ROOT = DEFAULT_ROOT;
let NO_OPEN = false;

for (const a of process.argv.slice(2)) {
  if (a.startsWith('--port=')) {
    const p = parseInt(a.slice('--port='.length), 10);
    if (Number.isFinite(p) && p > 0) PORT = p;
  } else if (a.startsWith('--root=')) {
    const r = a.slice('--root='.length);
    if (r) ROOT = r;
  } else if (a === '--no-open') {
    NO_OPEN = true;
  } else if (a.startsWith('--token=')) {
    // 自动化脚本（verify.js）用固定令牌，方便直接构造带鉴权的请求
    const t = a.slice('--token='.length).trim();
    if (/^[A-Za-z0-9_-]{8,128}$/.test(t)) ACCESS_TOKEN = t;
  }
}

function firstMarkdownIn(dir) {
  try {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    const mds = items
      .filter((d) => d.isFile() && /\.(md|markdown)$/i.test(d.name))
      .map((d) => d.name)
      .sort();
    return mds.length ? path.join(dir, mds[0]) : null;
  } catch (_) {
    return null;
  }
}

/** 在某个目录下挑一个"默认要打开的文件"：该目录第一个 Markdown */
function pickDefaultFile(root) {
  return firstMarkdownIn(root);
}

let DEFAULT_FILE = pickDefaultFile(ROOT);

let VERSION = '1.0.0';
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dir, 'package.json'), 'utf8'));
  if (pkg && pkg.version) VERSION = pkg.version;
} catch (_) {}

/* ------------------------------------------------------------------ */
/* MIME 映射（文本类必须带 charset，否则中文乱码）                        */
/* ------------------------------------------------------------------ */

const MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  mp4: 'video/mp4',
  avif: 'image/avif',
  webm: 'video/webm',
  ogg: 'video/ogg',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  m4v: 'video/mp4',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  mjs: 'application/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  tsv: 'text/tab-separated-values; charset=utf-8',
  zip: 'application/zip',
};

function contentTypeFor(p) {
  const ext = path.extname(p).slice(1).toLowerCase();
  // 未知类型以前一律当 text/plain，配合 nosniff 会把二进制文件当乱码显示；
  // 用 octet-stream 让浏览器按“下载”处理
  return MIME[ext] || 'application/octet-stream';
}

/**
 * /api/raw 的可信类型边界。
 *
 * 这些类型可以内联返回：PDF 需要给 iframe 用，图片/音视频要直接渲染，
 * Office 文件由前端 fetch 后解析。其余类型（HTML/SVG/JS/CSS/JSON/纯文本）
 * 一旦被直接导航，就等价于一个同源页面，能调用本服务的全部文件 API，
 * 因此统一改成附件下载并加 sandbox CSP。
 */
const INLINE_RAW_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif',
  'mp4', 'webm', 'ogg', 'ogv', 'mov', 'm4v', 'mkv',
  'mp3', 'wav', 'm4a', 'flac',
  'pdf', 'docx', 'xlsx', 'xls', 'pptx',
]);
/**
 * 文档里相对引用的资源只允许媒体类型：这个接口只给正文的 <img>/<video> 用，
 * 不需要 Office/PDF，收窄后 /api/asset 更不可能被当作任意文件读取通道。
 */
const ASSET_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg',
  'mp4', 'webm', 'ogg', 'ogv', 'mov', 'm4v', 'mkv',
  'mp3', 'wav', 'm4a', 'flac',
]);

function applyRawPolicy(res, filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (ext === 'svg') {
    // SVG 放在 <img> 里执行不了脚本；但用户直接打开该 URL 时必须禁脚本
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    return;
  }
  if (!INLINE_RAW_EXT.has(ext)) {
    res.setHeader('Content-Disposition', 'attachment');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  }
}

/* ------------------------------------------------------------------ */
/* kind 判定                                                            */
/* ------------------------------------------------------------------ */

const CODE_EXT = new Set([
  'js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs',
  'go', 'rs', 'php', 'rb', 'sh', 'bat', 'ps1', 'html', 'htm', 'css', 'scss',
  'less', 'json', 'yaml', 'yml', 'toml', 'ini', 'xml', 'sql', 'vue', 'swift',
  'kt', 'm', 'mm', 'gradle', 'properties',
]);

function kindFor(ext) {
  const e = String(ext || '').toLowerCase();
  if (e === 'md' || e === 'markdown') return 'markdown';
  if (CODE_EXT.has(e)) return 'code';
  return 'text';
}

/* ------------------------------------------------------------------ */
/* 日志                                                                 */
/* ------------------------------------------------------------------ */

const MEM_LOGS = [];
const LOG_MAX_BYTES = 5 * 1024 * 1024;

/** 日志改成攒一批异步写：以前每个请求都 appendFileSync，会卡事件循环 */
let pendingLogs = [];
let logFlushTimer = null;
let logFlushing = false;
let logBytes = -1;

function flushLogs() {
  logFlushTimer = null;
  if (!pendingLogs.length || logFlushing) return;
  const chunk = pendingLogs.join('\n') + '\n';
  pendingLogs = [];
  logFlushing = true;

  fs.promises
    .stat(LOG_FILE)
    .then((st) => {
      logBytes = st.size;
    })
    .catch(() => {
      logBytes = 0;
    })
    .then(() => {
      if (logBytes < LOG_MAX_BYTES) return null;
      // 超过 5 MB 就轮转，只保留一份 .1，避免 runtime.log 无限增长
      return fs.promises
        .rm(LOG_FILE + '.1', { force: true })
        .catch(() => {})
        .then(() => fs.promises.rename(LOG_FILE, LOG_FILE + '.1'))
        .catch(() => {})
        .then(() => {
          logBytes = 0;
        });
    })
    .then(() => fs.promises.appendFile(LOG_FILE, chunk, 'utf8'))
    .catch(() => {})
    .then(() => {
      logBytes += Buffer.byteLength(chunk);
      logFlushing = false;
      if (pendingLogs.length) flushLogs();
    });
}

function logEntry(entry) {
  const line = JSON.stringify(entry);
  MEM_LOGS.push(line);
  if (MEM_LOGS.length > 500) MEM_LOGS.splice(0, MEM_LOGS.length - 500);

  pendingLogs.push(line);
  if (pendingLogs.length >= 100) {
    if (logFlushTimer) {
      clearTimeout(logFlushTimer);
      logFlushTimer = null;
    }
    flushLogs();
    return;
  }
  if (!logFlushTimer && !logFlushing) {
    logFlushTimer = setTimeout(flushLogs, 1000);
    if (logFlushTimer.unref) logFlushTimer.unref();
  }
}

process.on('exit', () => {
  if (!pendingLogs.length) return;
  try {
    fs.appendFileSync(LOG_FILE, pendingLogs.join('\n') + '\n');
  } catch (_) {
    /* ignore */
  }
  pendingLogs = [];
});

/* ------------------------------------------------------------------ */
/* 响应辅助                                                             */
/* ------------------------------------------------------------------ */

function sendJson(res, code, obj) {
  let buf;
  try {
    buf = Buffer.from(JSON.stringify(obj), 'utf8');
  } catch (_) {
    buf = Buffer.from('{"error":"serialize failed"}', 'utf8');
  }
  try {
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': buf.length,
      // 配置、日志、文件内容都不应被浏览器或代理缓存
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  } catch (_) {
    /* 客户端可能已断开 */
  }
}

/** 读取 POST 的 JSON 请求体（上限 2 MB，翻译段落够用） */
function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    const max = limit || 2 * 1024 * 1024;
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(new Error('请求体过大'));
        try { req.destroy(); } catch (_) {}
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (_) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function safeJoin(base, rel) {
  const target = path.resolve(base, rel);
  const b = base.toLowerCase();
  const t = target.toLowerCase();
  if (t !== b && !t.startsWith(b + path.sep)) return null;
  return target;
}

/**
 * 通用文件响应，支持 Range / HEAD。
 *
 * 以前用 statSync：网络盘或大目录被访问时，一个请求就能把整个事件循环卡住。
 * Range 解析失败也不再悄悄退化成 200——视频播放器会因此认为服务器不支持拖动。
 */
async function sendFile(req, res, filePath) {
  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (_) {
    return sendJson(res, 404, { error: 'file not found', path: filePath });
  }
  if (!stat.isFile()) {
    return sendJson(res, 404, { error: 'not a file', path: filePath });
  }

  const total = stat.size;
  const type = contentTypeFor(filePath);
  const isHead = req.method === 'HEAD';
  const rangeHeader = req.headers['range'];

  if (rangeHeader) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
    if (!m) {
      // 语法合法的 Range 头但内容无法解析：按规范回 416，不要回整文件
      res.writeHead(416, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Range': 'bytes */' + total,
      });
      res.end(JSON.stringify({ error: 'range not satisfiable' }));
      return;
    }

    let start = m[1] === '' ? null : parseInt(m[1], 10);
    let end = m[2] === '' ? null : parseInt(m[2], 10);

    if (start === null && end === null) {
      start = 0;
      end = total - 1;
    } else if (start === null) {
      // 后缀范围 bytes=-N
      start = Math.max(0, total - end);
      end = total - 1;
    } else if (end === null || end >= total) {
      end = total - 1;
    }

    if (start > end || start >= total) {
      res.writeHead(416, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Range': 'bytes */' + total,
      });
      res.end(JSON.stringify({ error: 'range not satisfiable' }));
      return;
    }

    const headers = {
      'Content-Type': type,
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
    };
    try {
      res.writeHead(206, headers);
      if (isHead) {
        res.end();
        return;
      }
      const stream = fs.createReadStream(filePath, { start, end });
      stream.on('error', () => { try { res.end(); } catch (_) {} });
      stream.pipe(res);
    } catch (_) {
      try { res.end(); } catch (_) {}
    }
    return;
  }

  try {
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': total,
      'Accept-Ranges': 'bytes',
    });
    if (isHead) {
      res.end();
      return;
    }
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => { try { res.end(); } catch (_) {} });
    stream.pipe(res);
  } catch (_) {
    try { res.end(); } catch (_) {}
  }
}

/* ------------------------------------------------------------------ */
/* 图片兜底递归搜索                                                      */
/* ------------------------------------------------------------------ */

async function findByNameRecursive(root, baseName, maxDepth, maxEntries) {
  if (!root) return null;
  const needle = String(baseName).toLowerCase();
  let scanned = 0;
  const queue = [{ dir: root, depth: 0 }];

  while (queue.length) {
    const cur = queue.shift();
    if (cur.depth > maxDepth) continue;

    let items;
    try {
      items = await fs.promises.readdir(cur.dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }

    for (const it of items) {
      scanned++;
      if (scanned > maxEntries) return null;

      const full = path.join(cur.dir, it.name);
      if (it.isDirectory()) {
        if (it.name === 'node_modules' || it.name.startsWith('.')) continue;
        queue.push({ dir: full, depth: cur.depth + 1 });
      } else if (it.isFile() && it.name.toLowerCase() === needle) {
        return full;
      }
    }
  }
  return null;
}

/** 小并发批处理，避免大目录一次性打开几千个 stat */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const i = idx++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

const READ_MAX_BYTES = 32 * 1024 * 1024;

/**
 * 读文本文件并处理编码。
 * Windows 上大量中文 txt/csv/html 是 GBK，以前一律按 UTF-8 读会全是乱码。
 */
async function readTextSmart(filePath) {
  const st = await fs.promises.stat(filePath);
  if (!st.isFile()) throw Object.assign(new Error('不是文件'), { code: 'not-file' });
  if (st.size > READ_MAX_BYTES) {
    throw Object.assign(new Error('文件过大，暂不支持内联预览（上限 32 MB）'), { code: 'too-large' });
  }
  const buf = await fs.promises.readFile(filePath);

  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(buf.subarray(3)), encoding: 'utf-8-bom', size: st.size };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'utf-16le', size: st.size };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'utf-16be', size: st.size };
  }
  try {
    return {
      text: new TextDecoder('utf-8', { fatal: true }).decode(buf),
      encoding: 'utf-8',
      size: st.size,
    };
  } catch (_) {
    try {
      return { text: new TextDecoder('gbk').decode(buf), encoding: 'gbk', size: st.size };
    } catch (_) {
      return { text: buf.toString('latin1'), encoding: 'latin1', size: st.size };
    }
  }
}

/* ------------------------------------------------------------------ */
/* 路由                                                                 */
/* ------------------------------------------------------------------ */

function decodeSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch (_) {
    return s;
  }
}

/* ------------------------------------------------------------------ */
/* 访问鉴权                                                             */
/* ------------------------------------------------------------------ */

function getCookie(req, name) {
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

function tokenMatches(value) {
  const a = Buffer.from(String(value || ''), 'utf8');
  const b = Buffer.from(ACCESS_TOKEN, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** 令牌可以放 query（首次加载 / 自动化）、请求头或 Cookie（页面子资源） */
function isAuthorized(req, parsed) {
  const q = parsed.searchParams.get('token');
  if (q && tokenMatches(q)) return true;
  if (tokenMatches(req.headers['x-reader-token'])) return true;
  return tokenMatches(getCookie(req, ACCESS_COOKIE));
}

/**
 * 一次性打开票据。
 *
 * 「新窗口打开」会把 URL 交给系统浏览器，而系统浏览器没有本应用的 Cookie。
 * 直接把 access token 拼进 URL 会把它留在浏览器历史和日志里，所以改用
 * 60 秒有效、绑定单个文件、用后即焚的随机票据。
 */
const TICKETS = new Map();
const TICKET_TTL = 60 * 1000;

function createTicket(filePath) {
  const t = crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  TICKETS.set(t, { path: filePath, exp: now + TICKET_TTL });
  if (TICKETS.size > 100) {
    for (const [k, v] of TICKETS) {
      if (v.exp < now) TICKETS.delete(k);
    }
  }
  return t;
}

function consumeTicket(t) {
  const rec = TICKETS.get(t);
  TICKETS.delete(t);
  if (!rec || rec.exp < Date.now()) return '';
  return rec.path;
}

/**
 * 只接受本机回环 Host，并拒绝明显的跨站请求。
 *
 * 服务虽然只监听 127.0.0.1，但 DNS rebinding 可以让任意网站用 attacker.com
 * 指向本机端口；带 Origin 的跨站 fetch 也能直接调用这些文件 API。
 */
function isLocalHostHeader(req) {
  const host = String(req.headers.host || '').toLowerCase();
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);
}

function isCrossSiteRequest(req) {
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (site === 'cross-site') return true;

  const origin = String(req.headers.origin || '');
  if (!origin) return false;
  try {
    const u = new URL(origin);
    return !/^(127\.0\.0\.1|localhost|\[::1\])$/i.test(u.hostname);
  } catch (_) {
    return true;
  }
}

function sendPlain(res, code, text) {
  const buf = Buffer.from(String(text), 'utf8');
  try {
    res.writeHead(code, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': buf.length,
    });
    res.end(buf);
  } catch (_) {
    /* 客户端可能已断开 */
  }
}

function sendUnauthorized(res) {
  return sendPlain(
    res,
    401,
    '需要访问令牌。\n\n' +
      '请从「FolioPrism 棱阅」快捷方式启动，或在 `node server.js` 的启动输出里\n' +
      '打开带 ?token=… 的地址；令牌只用于阻止本机其他程序读取你的文件。\n'
  );
}

/**
 * 日志脱敏：
 *   token —— 访问凭据不能落盘
 *   text/word —— 朗读原文和查词内容也算阅读隐私
 */
function redactUrl(u) {
  return String(u || '')
    .replace(/([?&]token=)[^&]*/g, '$1***')
    .replace(/([?&](?:text|word)=)[^&]*/g, '$1***');
}

async function handleRequest(req, res) {
  const parsed = new URL(req.url, 'http://localhost');
  const pathname = decodeSafe(parsed.pathname);

  // 防 DNS rebinding / 跨站请求：Host 必须是本机回环，跨站 Origin 直接拒绝
  if (!isLocalHostHeader(req) || isCrossSiteRequest(req)) {
    return sendJson(res, 403, { error: 'forbidden host or origin' });
  }

  // /api/health 保持开放，方便启动探测；/api/raw 允许一次性票据（系统浏览器
  // 没有本应用 Cookie）；其余接口一律要令牌。
  const hasTicket = pathname === '/api/raw' && !!parsed.searchParams.get('ticket');
  if (
    pathname.startsWith('/api/') &&
    pathname !== '/api/health' &&
    !hasTicket &&
    !isAuthorized(req, parsed)
  ) {
    return sendJson(res, 401, { error: 'unauthorized' });
  }

  /* --- 静态：首页 --- */
  if (pathname === '/' || pathname === '/index.html') {
    if (!isAuthorized(req, parsed)) return sendUnauthorized(res);

    const cookie = ACCESS_COOKIE + '=' + ACCESS_TOKEN + '; Path=/; HttpOnly; SameSite=Strict';
    // 首次加载的 URL 带 ?token=…：先写 Cookie，再 302 到不带令牌的地址，
    // 否则令牌会长期留在地址栏和浏览器历史里。
    const q = parsed.searchParams.get('token');
    if (q && tokenMatches(q) && getCookie(req, ACCESS_COOKIE) !== ACCESS_TOKEN) {
      res.writeHead(302, { Location: '/', 'Set-Cookie': cookie, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }

    res.setHeader('Set-Cookie', cookie);
    res.setHeader('Content-Security-Policy', CSP);
    const indexFile = path.join(PUBLIC_DIR, 'index.html');
    if (!fs.existsSync(indexFile)) {
      return sendJson(res, 404, { error: 'public/index.html not found' });
    }
    res.setHeader('Cache-Control', 'no-cache');
    return sendFile(req, res, indexFile);
  }

  /* --- 静态：/assets/<path> --- */
  if (pathname.startsWith('/assets/')) {
    const rel = pathname.slice('/assets/'.length);
    const target = safeJoin(PUBLIC_DIR, rel);
    if (!target) return sendJson(res, 403, { error: 'forbidden' });
    // 这三个文件是本地开发时改得最勤的，禁用缓存免得改了看不到
    res.setHeader('Cache-Control', 'no-cache');
    return sendFile(req, res, target);
  }

  /* --- 静态：/vendor/<path> --- */
  if (pathname.startsWith('/vendor/')) {
    const rel = pathname.slice('/vendor/'.length);
    const target = safeJoin(VENDOR_DIR, rel);
    if (!target) return sendJson(res, 403, { error: 'forbidden' });
    return sendFile(req, res, target);
  }

  /* --- /api/config --- */
  if (pathname === '/api/config') {
    return sendJson(res, 200, {
      defaultRoot: ROOT,
      defaultFile: DEFAULT_FILE,
      port: ACTUAL_PORT,
      version: VERSION,
    });
  }

  /* --- /api/health --- */
  if (pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      uptime: Math.round(process.uptime()),
      port: ACTUAL_PORT,
    });
  }

  /* --- /api/logs：只在排查问题时开放，避免错误栈里的本机路径被页面读到 --- */
  if (pathname === '/api/logs') {
    if (process.env.READER_DEBUG !== '1') {
      return sendJson(res, 404, { error: 'not enabled' });
    }
    return sendJson(res, 200, { logs: MEM_LOGS.slice(-500) });
  }

  /* --- /api/ticket：给系统浏览器换取一次性文件访问票据 --- */
  if (pathname === '/api/ticket' && req.method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    const p = String(body.path || '');
    if (!p) return sendJson(res, 400, { error: 'missing path' });
    if (!INLINE_RAW_EXT.has(path.extname(p).slice(1).toLowerCase())) {
      return sendJson(res, 403, { error: '该类型不允许通过外部浏览器打开' });
    }
    const t = createTicket(p);
    return sendJson(res, 200, {
      url: 'http://127.0.0.1:' + ACTUAL_PORT + '/api/raw?ticket=' + encodeURIComponent(t),
      expiresIn: Math.round(TICKET_TTL / 1000),
    });
  }

  /* --- /api/browse --- */
  if (pathname === '/api/browse') {
    const p = parsed.searchParams.get('path') || ROOT;

    /* 虚拟目录「此电脑」：列出本机所有可用的磁盘根 */
    if (p === DRIVES_PATH) {
      // 断开的网络盘 stat 可能卡好几秒，别用同步调用把整个服务堵住
      const letters = [];
      for (let c = 65; c <= 90; c++) letters.push(String.fromCharCode(c));
      const drives = (
        await mapLimit(letters, 8, async (letter) => {
          const root = letter + ':\\';
          try {
            const st = await fs.promises.stat(root);
            if (!st.isDirectory()) return null;
          } catch (_) {
            return null;
          }
          return { name: letter + ':', isDir: true, path: root, size: 0, ext: '', mtime: 0 };
        })
      ).filter(Boolean);
      return sendJson(res, 200, { path: DRIVES_PATH, parent: null, entries: drives });
    }

    let stat;
    try {
      stat = await fs.promises.stat(p);
    } catch (_) {
      return sendJson(res, 404, { error: '目录不存在: ' + p });
    }
    if (!stat.isDirectory()) {
      return sendJson(res, 404, { error: '不是目录: ' + p });
    }

    let dirents;
    try {
      dirents = await fs.promises.readdir(p, { withFileTypes: true });
    } catch (e) {
      return sendJson(res, 404, { error: '无法读取目录: ' + p });
    }

    // 以前每项 statSync 一次：上千个文件的目录会把事件循环整个卡住
    const visible = dirents.filter(
      (d) => !d.name.startsWith('.') && !(d.isDirectory() && d.name === 'node_modules')
    );
    const entries = (
      await mapLimit(visible, 32, async (d) => {
        const full = path.join(p, d.name);
        let st;
        try {
          st = await fs.promises.stat(full);
        } catch (_) {
          return null;
        }
        const isDir = st.isDirectory();
        return {
          name: d.name,
          path: full,
          isDir,
          size: isDir ? 0 : st.size,
          ext: isDir ? '' : path.extname(d.name).slice(1).toLowerCase(),
          mtime: Math.round(st.mtimeMs),
        };
      })
    ).filter(Boolean);

    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const parentDir = path.dirname(p);
    return sendJson(res, 200, {
      path: p,
      parent: parentDir === p ? null : parentDir,
      entries,
    });
  }

  /* --- /api/read --- */
  if (pathname === '/api/read') {
    const p = parsed.searchParams.get('path');
    if (!p) return sendJson(res, 400, { error: 'missing path' });

    let info;
    try {
      info = await readTextSmart(p);
    } catch (e) {
      if (e.code === 'not-file') return sendJson(res, 404, { error: '不是文件: ' + p });
      if (e.code === 'too-large') return sendJson(res, 413, { error: e.message, path: p });
      if (e.code === 'ENOENT') return sendJson(res, 404, { error: '文件不存在: ' + p });
      return sendJson(res, 500, { error: '读取失败: ' + e.message });
    }

    const ext = path.extname(p).slice(1).toLowerCase();
    return sendJson(res, 200, {
      path: p,
      dir: path.dirname(p),
      name: path.basename(p),
      ext,
      kind: kindFor(ext),
      size: info.size,
      encoding: info.encoding,
      text: info.text,
    });
  }

  /* --- /api/raw --- */
  if (pathname === '/api/raw') {
    let p = parsed.searchParams.get('path');
    const ticket = parsed.searchParams.get('ticket');
    if (!p && ticket) {
      p = consumeTicket(ticket);
      if (!p) return sendJson(res, 403, { error: 'ticket expired or invalid' });
    }
    if (!p) return sendJson(res, 400, { error: 'missing path' });
    applyRawPolicy(res, p);
    // sendFile 自己会 stat 并返回 404，这里不再单独 existsSync
    return sendFile(req, res, p);
  }

  /* --- /api/asset --- */
  if (pathname === '/api/asset') {
    const file = parsed.searchParams.get('file');
    const rawRef = parsed.searchParams.get('ref');
    if (!file || rawRef === null) {
      return sendJson(res, 400, { error: 'missing file or ref' });
    }

    // 1) 远程地址直接跳转
    if (/^https?:\/\//i.test(rawRef)) {
      try {
        res.writeHead(302, { Location: rawRef });
        res.end();
      } catch (_) {
        /* ignore */
      }
      return;
    }

    // 2) 相对路径 -> 磁盘绝对路径
    // searchParams.get 已经做过一次解码，这里不能再 decodeSafe，否则 %2520 之类会被解两次
    const ref = rawRef;
    if (!ref || ref.indexOf('\0') >= 0 || /^(?:[a-zA-Z]:[\\/]|[\\/]{2})/.test(ref)) {
      return sendJson(res, 403, { error: 'absolute ref is not allowed' });
    }

    let resolved = null;
    try {
      resolved = path.resolve(path.dirname(file), ref);
    } catch (_) {
      resolved = null;
    }
    if (!resolved) return sendJson(res, 404, { error: 'asset not found' });

    // 只允许文档能引用的资源类型；文本/脚本/任意文件不再从 asset 通道返回
    const refExt = path.extname(resolved).slice(1).toLowerCase();
    if (!ASSET_EXT.has(refExt)) {
      return sendJson(res, 403, { error: 'asset type not allowed', ext: refExt });
    }

    // realpath 会解开符号链接/短路径，避免通过链接跳到资源目录之外
    let real = '';
    try {
      real = await fs.promises.realpath(resolved);
    } catch (_) {
      real = '';
    }
    if (real) {
      try {
        const st = await fs.promises.stat(real);
        if (st.isFile()) return sendFile(req, res, real);
      } catch (_) {
        /* fallthrough */
      }
    }

    // 3) 兜底：在 _images 下按文件名递归查找
    if (resolved) {
      const base = path.basename(resolved);
      let found = null;
      for (const root of FALLBACK_IMAGE_ROOTS) {
        found = await findByNameRecursive(root, base, 6, 20000);
        if (found) break;
      }
      if (found) {
        return sendFile(req, res, found);
      }
    }

    // 4) 找不到
    return sendJson(res, 404, {
      error: 'asset not found',
      file,
      ref: rawRef,
      resolved: resolved || null,
    });
  }

  /* --- 翻译：配置 / 状态 --- */
  if (pathname === '/api/translate/config') {
    if (req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
      translator.updateConfig(body);
      return sendJson(res, 200, translator.publicConfig());
    }
    return sendJson(res, 200, translator.publicConfig());
  }

  if (pathname === '/api/translate/status') {
    return sendJson(res, 200, translator.status());
  }

  /* --- 翻译：段落文本 --- */
  if (pathname === '/api/translate' && req.method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    const texts = Array.isArray(body.texts) ? body.texts.slice(0, 200) : null;
    if (!texts) return sendJson(res, 400, { error: 'texts 必须是数组' });
    try {
      const translations = await translator.translateTexts(texts, {
        service: body.service,
        target: body.target,
      });
      return sendJson(res, 200, { translations });
    } catch (e) {
      return sendJson(res, 502, { error: (e && e.message) || String(e) });
    }
  }

  /* --- 语音合成（Edge TTS） --- */
  if (pathname === '/api/tts') {
    const text = parsed.searchParams.get('text') || '';
    const voiceParam = parsed.searchParams.get('voice') || '';
    const langParam = parsed.searchParams.get('lang') || '';
    try {
      const file = await translator.synthesizeSpeech(text, {
        voice: voiceParam,
        rate: parsed.searchParams.get('rate'),
        lang: langParam,
      });
      res.setHeader('Cache-Control', 'public, max-age=604800');
      res.setHeader('X-TTS-Voice', translator.pickVoice(text, voiceParam, langParam));
      return sendFile(req, res, file);
    } catch (e) {
      const status = e && e.code === 'tts-missing' ? 409 : 400;
      return sendJson(res, status, {
        error: (e && e.message) || String(e),
        code: (e && e.code) || '',
      });
    }
  }

  /* --- PDF 文本抽取（朗读用） --- */
  if (pathname === '/api/pdf-text') {
    const p = parsed.searchParams.get('path');
    if (!p) return sendJson(res, 400, { error: 'missing path' });
    try {
      const pages = await translator.extractPdfText(p);
      let lang = '';
      try {
        const d = await translator.detectLanguage(pages.slice(0, 2).join(' ').slice(0, 4000));
        lang = d.lang || '';
      } catch (_) {
        /* 检测失败不影响朗读 */
      }
      // mtime 让前端判断缓存是否失效（PDF 被重新导出后要重新抽取）
      let mtime = 0;
      try {
        const st = await fs.promises.stat(p);
        mtime = Math.round(st.mtimeMs);
      } catch (_) {
        /* ignore */
      }
      return sendJson(res, 200, { path: p, pages: pages, lang: lang, mtime: mtime });
    } catch (e) {
      const status = e && e.code === 'engine-missing' ? 409 : 500;
      return sendJson(res, status, {
        error: (e && e.message) || String(e),
        code: (e && e.code) || '',
      });
    }
  }

  /* --- 语言检测 --- */
  if (pathname === '/api/detect' && req.method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    try {
      return sendJson(res, 200, await translator.detectLanguage(body.text || ''));
    } catch (e) {
      return sendJson(res, 500, { error: (e && e.message) || String(e) });
    }
  }

  /* --- 查词：悬停 / 选中单词 --- */
  if (pathname === '/api/dict') {
    const word = parsed.searchParams.get('word') || '';
    try {
      return sendJson(res, 200, await translator.dictLookup(word));
    } catch (e) {
      return sendJson(res, 502, { error: (e && e.message) || String(e) });
    }
  }

  /* --- 翻译：PDF（pdf2zh） --- */
  if (pathname === '/api/pdf-translate/cache') {
    const p = parsed.searchParams.get('path');
    if (!p) return sendJson(res, 400, { error: 'missing path' });
    return sendJson(res, 200, { output: translator.cachedPdf(p) });
  }

  /* 重新打开同一份 PDF 时恢复进度：前端据此显示「翻译中 / 已完成 / 无」 */
  if (pathname === '/api/pdf-translate/current') {
    const p = parsed.searchParams.get('path');
    if (!p) return sendJson(res, 400, { error: 'missing path' });
    return sendJson(res, 200, translator.currentPdfJob(p));
  }

  if (pathname === '/api/pdf-translate/cancel' && req.method === 'POST') {
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch (_) {
      body = {};
    }
    // 带 id 时只取消匹配任务，避免 A 窗口的「取消」把 B 窗口的任务杀掉
    return sendJson(res, 200, { job: translator.cancelPdfJob(body && body.id) });
  }

  if (pathname === '/api/pdf-translate' && req.method === 'POST') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    try {
      const r = await translator.startPdfTranslate(body.path);
      return sendJson(res, 200, r);
    } catch (e) {
      const code = e && e.code;
      const status = code === 'engine-missing' ? 409 : code === 'busy' ? 429 : 400;
      return sendJson(res, status, {
        error: (e && e.message) || String(e),
        code: code || '',
        job: e && e.job ? e.job : null,
      });
    }
  }

  if (pathname === '/api/pdf-translate/status') {
    const job = translator.getJob(parsed.searchParams.get('id'));
    if (!job) return sendJson(res, 404, { error: '任务不存在' });
    const output = job.meta && job.meta.key ? translator.outputUrls(job.meta.key) : null;
    return sendJson(res, 200, { job, output });
  }

  if (pathname === '/api/pdf-result') {
    const key = parsed.searchParams.get('key');
    const kind = parsed.searchParams.get('kind') === 'mono' ? 'mono' : 'dual';
    const file = translator.getPdfFile(key, kind);
    if (!file) return sendJson(res, 404, { error: '译文文件不存在' });
    res.setHeader('Cache-Control', 'no-cache');
    return sendFile(req, res, file);
  }

  if (pathname === '/api/pdf-engine/install' && req.method === 'POST') {
    try {
      const r = translator.startInstall();
      return sendJson(res, 200, r);
    } catch (e) {
      return sendJson(res, 400, {
        error: (e && e.message) || String(e),
        code: (e && e.code) || '',
      });
    }
  }

  return sendJson(res, 404, { error: 'not found', url: req.url });
}

/* ------------------------------------------------------------------ */
/* 服务                                                                 */
/* ------------------------------------------------------------------ */

let ACTUAL_PORT = PORT;

const server = http.createServer((req, res) => {
  const t0 = Date.now();

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');

  res.on('finish', () => {
    logEntry({
      time: new Date().toISOString(),
      method: req.method,
      url: redactUrl(req.url),
      status: res.statusCode,
      ms: Date.now() - t0,
    });
  });

  Promise.resolve()
    .then(() => handleRequest(req, res))
    .catch((e) => {
      logEntry({
        time: new Date().toISOString(),
        method: req.method,
        url: redactUrl(req.url),
        status: 500,
        ms: Date.now() - t0,
        error: (e && e.stack) || String(e),
      });
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'internal error', message: String((e && e.message) || e) });
      } else {
        try { res.end(); } catch (_) {}
      }
    });
});

process.on('uncaughtException', (e) => {
  try {
    logEntry({
      time: new Date().toISOString(),
      method: 'UNCAUGHT',
      url: '',
      status: 0,
      ms: 0,
      error: (e && e.stack) || String(e),
    });
  } catch (_) {
    /* ignore */
  }
  console.error('[uncaughtException]', (e && e.stack) || e);
  // 未捕获异常意味着进程状态已经不可信，继续运行只会把问题藏起来、
  // 让后续请求在坏状态上继续处理。退出前 process.on('exit') 会把日志落盘。
  process.exit(1);
});

process.on('unhandledRejection', (e) => {
  try {
    logEntry({
      time: new Date().toISOString(),
      method: 'UNHANDLED_REJECTION',
      url: '',
      status: 0,
      ms: 0,
      error: (e && e.stack) || String(e),
    });
  } catch (_) {
    /* ignore */
  }
});

function onReady(port, openBrowser) {
  ACTUAL_PORT = port;
  const localUrl = 'http://localhost:' + port + '/?token=' + ACCESS_TOKEN;
  console.log('阅读器已启动: ' + localUrl);
  console.log('默认目录:', ROOT);
  console.log('默认文件:', DEFAULT_FILE || '(无)');

  if (openBrowser) {
    try {
      // 令牌在 URL 里，浏览器打开后服务端会写 Cookie 并 302 到不带令牌的地址。
      // 用 execFile + 参数数组，避免拼接字符串时被路径里的引号干扰。
      if (process.platform === 'win32') {
        cp.execFile('cmd', ['/c', 'start', '', localUrl], { windowsHide: true }, () => {});
      } else {
        const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
        cp.execFile(opener, [localUrl], () => {});
      }
    } catch (e) {
      console.error('打开浏览器失败:', e.message);
    }
  }
}

function tryListen(idx, candidates, onOk, onFail) {
  if (idx >= candidates.length) {
    onFail(new Error('端口 ' + PORT + '~' + Math.max(PORT, 7795) + ' 均被占用，无法启动'));
    return;
  }
  const p = candidates[idx];

  const onError = (err) => {
    server.removeListener('error', onError);
    if (err && err.code === 'EADDRINUSE') {
      tryListen(idx + 1, candidates, onOk, onFail);
    } else {
      onFail(err);
    }
  };

  server.on('error', onError);
  // 只监听本机回环地址：阅读器会暴露本机文件和翻译 API Key，
  // 不应该让同一局域网里的其他设备访问到。
  server.listen(p, '127.0.0.1', () => {
    server.removeListener('error', onError);
    server.on('error', (e) => console.error('server error:', (e && e.stack) || e));
    onOk(p);
  });
}

/**
 * 启动 HTTP 服务。Electron 主进程通过它拿端口，再把窗口指到 localhost。
 *
 * @param {object} [opts]
 * @param {number} [opts.port]          起始端口（占用时自动往后试）
 * @param {string} [opts.root]          默认打开的目录
 * @param {boolean} [opts.openBrowser]  是否用系统浏览器打开（Electron 下必须为 false）
 * @returns {Promise<number>} 实际监听的端口
 */
function start(opts) {
  const o = opts || {};
  if (Number.isFinite(o.port) && o.port > 0) PORT = o.port;
  if (o.root) {
    ROOT = o.root;
    DEFAULT_FILE = pickDefaultFile(ROOT);
  }
  // 命令行传了 --no-open 就不再开浏览器；Electron 传 openBrowser:false 覆盖
  const openBrowser = o.openBrowser === undefined ? !NO_OPEN : !!o.openBrowser;

  const candidates = [];
  for (let p = PORT; p <= Math.max(PORT, 7795); p++) candidates.push(p);
  if (!candidates.length) candidates.push(PORT);

  return new Promise((resolve, reject) => {
    tryListen(
      0,
      candidates,
      (port) => {
        onReady(port, openBrowser);
        resolve(port);
      },
      reject
    );
  });
}

module.exports = {
  start,
  getPort: () => ACTUAL_PORT,
  getToken: () => ACCESS_TOKEN,
  /** 退出前调用：结束仍在跑的 pdf2zh / tts / 安装子进程，避免残留孤儿进程 */
  shutdown: () => translator.killAllChildren(),
};

/* 直接 `node server.js` 运行时，行为与以前完全一致 */
if (require.main === module) {
  start().catch((e) => {
    console.error('启动失败:', (e && e.stack) || e);
    process.exit(1);
  });
}

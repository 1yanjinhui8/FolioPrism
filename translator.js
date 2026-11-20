'use strict';

/**
 * 翻译模块（服务端）
 *
 * 两条翻译路线：
 *   1. 文本：/api/translate 把段落交给 Google 免费接口或 OpenAI 兼容接口
 *      （DeepSeek / GPT / 本地 Ollama 都行），前端做「原文 + 译文」对照。
 *   2. PDF：调用开源项目 PDFMathTranslate（pdf2zh）生成保留排版的
 *      「双语版 / 纯译文版」PDF，公式、图表、表格都留在原位。
 *
 * 配置与缓存都放在用户目录，不写进程序目录（打包成 asar 后是只读的）：
 *   %LOCALAPPDATA%\folioprism\config.json
 *   %LOCALAPPDATA%\folioprism\cache\
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const https = require('node:https');
const http = require('node:http');

const LOCAL_DIR = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const APP_DIR = path.join(LOCAL_DIR, 'folioprism');
const LEGACY_APP_DIR = path.join(LOCAL_DIR, 'media-reader');

/**
 * 改名迁移：老用户的翻译设置、词典/文本缓存、PDF 与 TTS 缓存都在
 * media-reader 目录下。首次以新名字启动时整份复制过来，旧目录保留。
 * 迁移失败不阻塞启动，最坏情况是让用户重新配一次翻译服务。
 */
try {
  if (!fs.existsSync(APP_DIR) && fs.existsSync(LEGACY_APP_DIR)) {
    fs.cpSync(LEGACY_APP_DIR, APP_DIR, { recursive: true });
  }
} catch (_) {
  /* ignore */
}

const CONFIG_FILE = path.join(APP_DIR, 'config.json');
const CACHE_DIR = path.join(APP_DIR, 'cache');
const PDF_CACHE_DIR = path.join(CACHE_DIR, 'pdf');
const TTS_CACHE_DIR = path.join(CACHE_DIR, 'tts');
const TEXT_CACHE_FILE = path.join(APP_DIR, 'text-cache.json');

const DEFAULT_CONFIG = {
  service: 'bing', // bing | google | openai
  targetLang: 'zh-CN',
  sourceLang: 'auto',
  openai: {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
  },
  pdf: {
    // 留空则跟随 service；可选 google / openai
    service: '',
    pdf2zhPath: '',
    extraArgs: '',
  },
  install: {
    uvPath: '',
    // 国内网络建议保留清华镜像；海外可改成 https://pypi.org/simple
    indexUrl: 'https://pypi.tuna.tsinghua.edu.cn/simple',
  },
  hfEndpoint: 'https://hf-mirror.com',
  tts: {
    voiceEn: 'en-US-AriaNeural',
    voiceZh: 'zh-CN-XiaoxiaoNeural',
    rate: 0, // -50 ~ 100，百分比
    edgeTtsPath: '',
  },
};

/** 支持的原文/译文语言：google 是 Google 代码，bing 是 Bing 代码，pdf 是 pdf2zh 代码 */
const LANGS = {
  'zh-CN': { name: '简体中文', google: 'zh-CN', bing: 'zh-Hans', pdf: 'zh', voice: 'zh-CN-XiaoxiaoNeural' },
  'zh-TW': { name: '繁體中文', google: 'zh-TW', bing: 'zh-Hant', pdf: 'zh', voice: 'zh-TW-HsiaoChenNeural' },
  en: { name: 'English', google: 'en', bing: 'en', pdf: 'en', voice: 'en-US-AriaNeural' },
  ja: { name: '日本語', google: 'ja', bing: 'ja', pdf: 'ja', voice: 'ja-JP-NanamiNeural' },
  ko: { name: '한국어', google: 'ko', bing: 'ko', pdf: 'ko', voice: 'ko-KR-SunHiNeural' },
  fr: { name: 'Français', google: 'fr', bing: 'fr', pdf: 'fr', voice: 'fr-FR-DeniseNeural' },
  de: { name: 'Deutsch', google: 'de', bing: 'de', pdf: 'de', voice: 'de-DE-TanjaNeural' },
  es: { name: 'Español', google: 'es', bing: 'es', pdf: 'es', voice: 'es-ES-ElviraNeural' },
  pt: { name: 'Português', google: 'pt', bing: 'pt', pdf: 'pt', voice: 'pt-BR-FranciscaNeural' },
  ru: { name: 'Русский', google: 'ru', bing: 'ru', pdf: 'ru', voice: 'ru-RU-SvetlanaNeural' },
  it: { name: 'Italiano', google: 'it', bing: 'it', pdf: 'it', voice: 'it-IT-ElsaNeural' },
  ar: { name: 'العربية', google: 'ar', bing: 'ar', pdf: 'ar', voice: 'ar-SA-ZariyahNeural' },
  hi: { name: 'हिन्दी', google: 'hi', bing: 'hi', pdf: 'hi', voice: 'hi-IN-SwaraNeural' },
  th: { name: 'ไทย', google: 'th', bing: 'th', pdf: 'th', voice: 'th-TH-PremwadeeNeural' },
  vi: { name: 'Tiếng Việt', google: 'vi', bing: 'vi', pdf: 'vi', voice: 'vi-VN-HoaiMyNeural' },
  id: { name: 'Bahasa Indonesia', google: 'id', bing: 'id', pdf: 'id', voice: 'id-ID-GadisNeural' },
  tr: { name: 'Türkçe', google: 'tr', bing: 'tr', pdf: 'tr', voice: 'tr-TR-EmelNeural' },
  nl: { name: 'Nederlands', google: 'nl', bing: 'nl', pdf: 'nl', voice: 'nl-NL-ColetteNeural' },
  pl: { name: 'Polski', google: 'pl', bing: 'pl', pdf: 'pl', voice: 'pl-PL-ZofiaNeural' },
};

function baseLang(code) {
  return String(code || '').split(/[-_]/)[0].toLowerCase();
}

function langInfo(code) {
  return LANGS[code] || LANGS[baseLang(code)] || null;
}

function pdfLangCode(code) {
  const info = langInfo(code);
  if (info) return info.pdf;
  const b = baseLang(code);
  return b || 'en';
}

/* ------------------------------------------------------------------ */
/* 配置                                                                 */
/* ------------------------------------------------------------------ */

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {
    /* ignore */
  }
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  if (!patch || typeof patch !== 'object') return out;
  for (const k of Object.keys(patch)) {
    if (UNSAFE_KEYS.has(k)) continue;
    const v = patch[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = deepMerge(out[k] && typeof out[k] === 'object' ? out[k] : {}, v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

let config = loadConfig();

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    return deepMerge(DEFAULT_CONFIG, JSON.parse(raw));
  } catch (_) {
    return deepMerge(DEFAULT_CONFIG, {});
  }
}

function saveConfig() {
  ensureDir(APP_DIR);
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  } catch (_) {
    /* 配置写不进去时不影响本次翻译 */
  }
}

/**
 * 只接受设置面板真正用得到的字段。
 *
 * 以前 updateConfig 会原样合并任意补丁，而接口只要有令牌就能调：
 * 补丁里塞 pdf.pdf2zhPath / pdf.extraArgs 等于让阅读器替你启动任意程序。
 * 这两个字段（以及 install.uvPath / tts.edgeTtsPath）只允许手工改 config.json。
 */
const SERVICE_VALUES = new Set(['bing', 'google', 'openai']);
const PDF_SERVICE_VALUES = new Set(['', 'bing', 'google', 'openai']);
const VOICE_RE = /^[a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural$/;

function sanitizePatch(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;

  if (SERVICE_VALUES.has(patch.service)) out.service = patch.service;
  if (Object.prototype.hasOwnProperty.call(LANGS, patch.targetLang)) {
    out.targetLang = patch.targetLang;
  }
  if (patch.sourceLang === 'auto' || Object.prototype.hasOwnProperty.call(LANGS, patch.sourceLang)) {
    out.sourceLang = patch.sourceLang;
  }
  if (typeof patch.hfEndpoint === 'string' && /^https?:\/\//i.test(patch.hfEndpoint)) {
    out.hfEndpoint = patch.hfEndpoint;
  }

  const openai = patch.openai;
  if (openai && typeof openai === 'object') {
    const o = {};
    if (typeof openai.baseUrl === 'string') o.baseUrl = openai.baseUrl.trim();
    if (typeof openai.apiKey === 'string') o.apiKey = openai.apiKey.trim();
    if (typeof openai.model === 'string') o.model = openai.model.trim();
    if (Object.keys(o).length) out.openai = o;
  }

  const tts = patch.tts;
  if (tts && typeof tts === 'object') {
    const t = {};
    if (VOICE_RE.test(String(tts.voiceEn || ''))) t.voiceEn = tts.voiceEn;
    if (VOICE_RE.test(String(tts.voiceZh || ''))) t.voiceZh = tts.voiceZh;
    const rate = Number(tts.rate);
    if (Number.isFinite(rate)) t.rate = Math.max(-50, Math.min(100, Math.round(rate)));
    if (Object.keys(t).length) out.tts = t;
  }

  const pdf = patch.pdf;
  if (pdf && typeof pdf === 'object' && PDF_SERVICE_VALUES.has(pdf.service)) {
    out.pdf = { service: pdf.service };
  }

  const install = patch.install;
  if (install && typeof install === 'object' && typeof install.indexUrl === 'string') {
    out.install = { indexUrl: install.indexUrl.trim() };
  }

  return out;
}

function updateConfig(patch) {
  config = deepMerge(config, sanitizePatch(patch));
  saveConfig();
  invalidateToolCache();
  return config;
}

function publicConfig() {
  return {
    service: config.service,
    targetLang: config.targetLang,
    sourceLang: config.sourceLang,
    // API Key 只在服务端使用：接口只告诉前端“有没有配”，不回传明文
    openai: {
      baseUrl: config.openai.baseUrl,
      model: config.openai.model,
      hasKey: !!config.openai.apiKey,
    },
    pdf: { service: config.pdf.service },
    tts: {
      voiceEn: config.tts.voiceEn,
      voiceZh: config.tts.voiceZh,
      rate: config.tts.rate,
    },
    dataDir: APP_DIR,
  };
}

/* ------------------------------------------------------------------ */
/* 可执行文件探测                                                        */
/* ------------------------------------------------------------------ */

const TOOL_CACHE_TTL_EMPTY = 10000;
const toolCache = {
  uv: null,
  pdf2zh: null,
  edgeTts: null,
  edgeTtsPython: null,
};

function invalidateToolCache() {
  toolCache.uv = null;
  toolCache.pdf2zh = null;
  toolCache.edgeTts = null;
  toolCache.edgeTtsPython = null;
}

function getCachedTool(key, probeFn) {
  const entry = toolCache[key];
  if (entry) {
    if (entry.value) {
      if (fs.existsSync(entry.value)) return entry.value;
    } else if (Date.now() - entry.at < TOOL_CACHE_TTL_EMPTY) {
      return '';
    }
  }
  const value = probeFn() || '';
  toolCache[key] = { value, at: Date.now() };
  return value;
}

function which(name) {
  try {
    const out = cp.execFileSync('where.exe', [name], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });
    const first = String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first && fs.existsSync(first)) return first;
  } catch (_) {
    /* 不在 PATH 里 */
  }
  return '';
}

function firstExisting(list) {
  for (const item of list) {
    const p = typeof item === 'function' ? item() : item;
    if (p && fs.existsSync(p)) return p;
  }
  return '';
}

function findUv() {
  if (config.install.uvPath && fs.existsSync(config.install.uvPath)) return config.install.uvPath;
  return getCachedTool('uv', () => {
    const home = os.homedir();
    return firstExisting([
      path.join(home, '.local', 'bin', 'uv.exe'),
      path.join(home, '.cargo', 'bin', 'uv.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'uv', 'uv.exe'),
      () => which('uv'),
    ]);
  });
}

function findPdf2zh() {
  if (config.pdf.pdf2zhPath && fs.existsSync(config.pdf.pdf2zhPath)) return config.pdf.pdf2zhPath;
  return getCachedTool('pdf2zh', () => {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const home = os.homedir();
    return firstExisting([
      path.join(appData, 'uv', 'tools', 'pdf2zh', 'Scripts', 'pdf2zh.exe'),
      path.join(home, '.local', 'bin', 'pdf2zh.exe'),
      path.join(home, '.local', 'bin', 'pdf2zh'),
      () => which('pdf2zh'),
    ]);
  });
}

function findEdgeTts() {
  if (config.tts.edgeTtsPath && fs.existsSync(config.tts.edgeTtsPath)) return config.tts.edgeTtsPath;
  return getCachedTool('edgeTts', () => {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const home = os.homedir();
    // 优先用 uv 工具目录里的新版：PATH 上可能有别的项目装的旧版（协议会失效）
    return firstExisting([
      path.join(appData, 'uv', 'tools', 'edge-tts', 'Scripts', 'edge-tts.exe'),
      path.join(home, '.local', 'bin', 'edge-tts.exe'),
      () => which('edge-tts'),
    ]);
  });
}

function findEdgeTtsPython() {
  const exe = findEdgeTts();
  if (!exe) return '';
  const pyName = process.platform === 'win32' ? 'python.exe' : 'python';
  const sibling = path.join(path.dirname(exe), pyName);
  if (fs.existsSync(sibling)) return sibling;
  return getCachedTool('edgeTtsPython', () => {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const uvPy = path.join(appData, 'uv', 'tools', 'edge-tts', 'Scripts', pyName);
    return fs.existsSync(uvPy) ? uvPy : '';
  });
}

function toolPythonPath() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'uv', 'tools', 'pdf2zh', 'Scripts', 'python.exe');
}

function engineInfo() {
  const exe = findPdf2zh();
  const ttsExe = findEdgeTts();
  return {
    available: !!exe,
    path: exe,
    uv: findUv(),
    toolPython: fs.existsSync(toolPythonPath()) ? toolPythonPath() : '',
    tts: { available: !!ttsExe, path: ttsExe },
    hint: exe ? '' : '首次使用请点「安装翻译引擎」，会通过 uv 安装 PDFMathTranslate（pdf2zh）。',
  };
}

function status() {
  return {
    engine: engineInfo(),
    config: publicConfig(),
    cacheDir: PDF_CACHE_DIR,
  };
}

/* ------------------------------------------------------------------ */
/* 通用 HTTP 请求                                                       */
/* ------------------------------------------------------------------ */

function request(urlStr, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      reject(e);
      return;
    }
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        method: o.method || 'GET',
        headers: Object.assign(
          {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
            Accept: 'application/json,text/plain,*/*',
          },
          o.headers || {}
        ),
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 400) {
            const err = new Error('HTTP ' + res.statusCode + ' ' + text.slice(0, 200));
            err.status = res.statusCode;
            reject(err);
          } else {
            resolve(text);
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(o.timeout || 30000, () => req.destroy(new Error('请求超时')));
    if (o.body) req.write(o.body);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function requestRetry(urlStr, opts, times) {
  const n = times || 3;
  let lastErr = null;
  for (let i = 0; i < n; i++) {
    try {
      return await request(urlStr, opts);
    } catch (e) {
      lastErr = e;
      if (e.status === 400 || e.status === 401 || e.status === 403) break;
      await sleep(500 * (i + 1));
    }
  }
  throw lastErr;
}

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

/* ------------------------------------------------------------------ */
/* 文本翻译                                                             */
/* ------------------------------------------------------------------ */

const textCache = new Map();
let cacheDirty = false;
let cacheTimer = null;

(function loadTextCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(TEXT_CACHE_FILE, 'utf8'));
    if (raw && typeof raw === 'object') {
      for (const k of Object.keys(raw)) {
        if (typeof raw[k] === 'string') textCache.set(k, raw[k]);
      }
    }
  } catch (_) {
    /* 首次运行没有缓存 */
  }
})();

function cacheKey(service, target, text) {
  return crypto
    .createHash('sha1')
    .update(service + '\u0000' + target + '\u0000' + text)
    .digest('hex');
}

function scheduleCacheSave() {
  cacheDirty = true;
  if (cacheTimer) return;
  cacheTimer = setTimeout(() => {
    cacheTimer = null;
    if (!cacheDirty) return;
    cacheDirty = false;
    try {
      ensureDir(APP_DIR);
      const obj = {};
      let n = 0;
      // 只保留最近 4000 条，避免缓存文件无限膨胀
      const keys = Array.from(textCache.keys());
      for (const k of keys.slice(Math.max(0, keys.length - 4000))) obj[k] = textCache.get(k);
      fs.writeFileSync(TEXT_CACHE_FILE, JSON.stringify(obj), 'utf8');
      n = keys.length;
      if (n > 4000) {
        textCache.clear();
        for (const k of Object.keys(obj)) textCache.set(k, obj[k]);
      }
    } catch (_) {
      /* ignore */
    }
  }, 1500);
  if (cacheTimer.unref) cacheTimer.unref();
}

function splitLong(text, max) {
  const limit = max || 1800;
  if (text.length <= limit) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = -1;
    const window = rest.slice(0, limit);
    const m = /[.!?。！？؟۔।॥]\s|[.!?。！？؟۔।॥]$/g;
    let last = null;
    let mm;
    while ((mm = m.exec(window)) !== null) last = mm;
    if (last) cut = last.index + 1;
    else cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = limit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) parts.push(rest);
  return parts;
}

/* ------------------------------- Google ------------------------------- */

// 同一套 Google 免费接口有好几个域名，任何一个被限流时换下一个。
// translate.googleapis.com 最容易 429，translate.google.com 和 clients5 通常还能用。
let googleHostIdx = 0;

function googleEndpoints(text, target) {
  const q = encodeURIComponent(text);
  const tl = encodeURIComponent(target);
  return [
    {
      url: 'https://translate.google.com/translate_a/single?client=gtx&sl=auto&tl=' + tl + '&dt=t&q=' + q,
      kind: 'single',
    },
    {
      url: 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' + tl + '&dt=t&q=' + q,
      kind: 'single',
    },
    {
      url: 'https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=' + tl + '&q=' + q,
      kind: 'flat',
    },
  ];
}

function parseGoogleBody(body, kind) {
  const data = JSON.parse(body);
  if (kind === 'flat') {
    // clients5: ["译文"] 或 [["句子1","句子2"]]
    if (Array.isArray(data)) {
      if (data.every((x) => typeof x === 'string')) return data.join('');
      if (Array.isArray(data[0]) && data[0].every((x) => typeof x === 'string')) {
        return data[0].join('');
      }
      if (Array.isArray(data[0])) {
        let s = '';
        for (const row of data) {
          if (Array.isArray(row) && typeof row[0] === 'string') s += row[0];
        }
        return s;
      }
    }
    return '';
  }
  let s = '';
  if (Array.isArray(data) && Array.isArray(data[0])) {
    for (const seg of data[0]) {
      if (seg && typeof seg[0] === 'string') s += seg[0];
    }
  }
  return s;
}

async function googleTranslate(text, target) {
  const chunks = splitLong(text, 1800);
  const out = [];
  for (const chunk of chunks) {
    const eps = googleEndpoints(chunk, target);
    let translated = '';
    let lastErr = null;
    for (let i = 0; i < eps.length; i++) {
      const ep = eps[(googleHostIdx + i) % eps.length];
      try {
        const body = await requestRetry(ep.url, { timeout: 30000 }, 2);
        const s = parseGoogleBody(body, ep.kind);
        if (!s) throw new Error('Google 返回空译文');
        translated = s;
        googleHostIdx = (googleHostIdx + i + 1) % eps.length;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!translated) {
      throw lastErr || new Error('Google 翻译不可用');
    }
    out.push(translated);
  }
  return out.join('');
}

/* -------------------------------- Bing -------------------------------- */

// Bing 网页翻译：先抓 translator 页面拿 IG / IID / token，再 POST ttranslatev3。
// 不需要 Key，国内网络可用，是默认服务。
const bing = {
  cookie: '',
  ig: '',
  iid: '',
  key: '',
  token: '',
  expires: 0,
  host: 'https://www.bing.com',
  pending: null,
};

const BING_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';

/**
 * 发起请求并跟随重定向（Bing 在部分地区会把 www.bing.com 302 到 cn.bing.com）。
 * 返回时带上最终 URL 和累计 Cookie，Bing 后续的 ttranslatev3 必须用最终域名。
 */
function requestFull(urlStr, opts) {
  const o = opts || {};
  const initial = [];
  const origCookie = (o.headers && (o.headers.Cookie || o.headers.cookie)) || '';
  if (origCookie) initial.push(origCookie);
  return requestFullRec(urlStr, o, 0, initial);
}

function requestFullRec(urlStr, o, depth, jar) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      reject(e);
      return;
    }
    const lib = u.protocol === 'http:' ? http : https;
    const headers = Object.assign({}, o.headers || {});
    if (jar.length) headers.Cookie = jar.join('; ');

    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        method: o.method || 'GET',
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const status = res.statusCode || 0;
          const setCookies = (res.headers['set-cookie'] || [])
            .map((c) => String(c).split(';')[0])
            .filter(Boolean);
          const nextJar = setCookies.length ? jar.concat(setCookies) : jar;
          const loc = res.headers.location;

          if (depth < 5 && loc && [301, 302, 303, 307, 308].indexOf(status) >= 0) {
            let nextUrl = '';
            try {
              nextUrl = new URL(loc, urlStr).toString();
            } catch (_) {
              nextUrl = '';
            }
            if (nextUrl) {
              const method = String(o.method || 'GET').toUpperCase();
              const nextOpts = {
                headers: Object.assign({}, headers),
                timeout: o.timeout,
                method: o.method,
                body: o.body,
              };
              // 301/302/303 的 POST 按浏览器行为改成 GET；307/308 保留原方法
              if (status === 303 || ((status === 301 || status === 302) && method !== 'GET' && method !== 'HEAD')) {
                nextOpts.method = 'GET';
                nextOpts.body = '';
                delete nextOpts.headers['Content-Length'];
                delete nextOpts.headers['content-length'];
                delete nextOpts.headers['Content-Type'];
                delete nextOpts.headers['content-type'];
              }
              requestFullRec(nextUrl, nextOpts, depth + 1, nextJar).then(resolve, reject);
              return;
            }
          }

          resolve({
            status,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            url: urlStr,
            cookies: nextJar,
          });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(o.timeout || 30000, () => req.destroy(new Error('请求超时')));
    if (o.body) req.write(o.body);
    req.end();
  });
}

async function bingAuth(force) {
  const now = Date.now();
  if (!force && bing.token && now < bing.expires) return bing;
  if (bing.pending) return bing.pending;
  bing.pending = (async () => {
    const r = await requestFull('https://www.bing.com/translator', {
      headers: {
        'User-Agent': BING_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (r.status !== 200) throw new Error('Bing 翻译页面打开失败（HTTP ' + r.status + '）');
    const cookies = (r.cookies && r.cookies.length
      ? r.cookies
      : (r.headers['set-cookie'] || []).map((c) => String(c).split(';')[0])
    ).join('; ');
    const ig =
      (r.body.match(/"ig":"(.*?)"/) || [])[1] ||
      (r.body.match(/IG:"(.*?)"/) || [])[1] ||
      '';
    const iids = r.body.match(/data-iid="translator\.[0-9]+"/g) || [];
    const iid = iids.length ? iids[iids.length - 1].slice('data-iid="'.length, -1) : '';
    const m = r.body.match(/params_AbusePreventionHelper\s*=\s*\[(.*?),"(.*?)",/);
    if (!ig || !iid || !m) throw new Error('Bing 翻译鉴权参数解析失败');
    bing.cookie = cookies;
    bing.ig = ig;
    bing.iid = iid;
    bing.key = m[1];
    bing.token = m[2];
    // 可能被重定向到 cn.bing.com；后续 POST 必须打到同一个域名
    try {
      bing.host = new URL(r.url).origin;
    } catch (_) {
      bing.host = 'https://www.bing.com';
    }
    bing.expires = now + 10 * 60 * 1000;
    return bing;
  })();
  try {
    return await bing.pending;
  } finally {
    bing.pending = null;
  }
}

function bingLang(target) {
  const info = langInfo(target);
  if (info) return info.bing;
  const t = String(target || 'zh-CN');
  if (/^zh/i.test(t)) return /TW|Hant/i.test(t) ? 'zh-Hant' : 'zh-Hans';
  return baseLang(t) || 'en';
}

function bingPostHeaders(a, form) {
  const origin = (a && a.host) || 'https://www.bing.com';
  const h = {
    'User-Agent': BING_UA,
    'Content-Type': 'application/x-www-form-urlencoded',
    Referer: origin + '/translator',
    Origin: origin,
    'Content-Length': Buffer.byteLength(form),
  };
  if (a && a.cookie) h.Cookie = a.cookie;
  return h;
}

async function bingTranslateOnce(text, target) {
  const a = await bingAuth(false);
  const form = new URLSearchParams({
    fromLang: 'auto-detect',
    to: bingLang(target),
    text: text,
    token: a.token,
    key: a.key,
  }).toString();
  const r = await requestFull(
    ((a && a.host) || 'https://www.bing.com') +
      '/ttranslatev3?isVertical=1&IG=' +
      encodeURIComponent(a.ig) +
      '&IID=' +
      encodeURIComponent(a.iid),
    {
      method: 'POST',
      headers: bingPostHeaders(a, form),
      body: form,
      timeout: 30000,
    }
  );
  if (r.status !== 200) throw new Error('Bing 翻译请求失败（HTTP ' + r.status + '）');
  let data;
  try {
    data = JSON.parse(r.body);
  } catch (_) {
    throw new Error('Bing 翻译返回了无法解析的内容');
  }
  const tr =
    Array.isArray(data) && data[0] && data[0].translations && data[0].translations[0]
      ? data[0].translations[0].text
      : '';
  if (!tr) throw new Error('Bing 翻译没有返回译文（可能需要刷新会话）');
  return tr;
}

async function bingTranslate(text, target) {
  const chunks = splitLong(text, 900);
  const out = [];
  for (const chunk of chunks) {
    let tr = '';
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt > 0) await bingAuth(true);
        tr = await bingTranslateOnce(chunk, target);
        break;
      } catch (e) {
        lastErr = e;
        bing.expires = 0;
      }
    }
    if (!tr) throw lastErr || new Error('Bing 翻译不可用');
    out.push(tr);
  }
  return out.join('');
}

function parseJsonArray(content) {
  let s = String(content || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const a = s.indexOf('[');
  const b = s.lastIndexOf(']');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  const arr = JSON.parse(s);
  if (!Array.isArray(arr)) throw new Error('模型没有返回数组');
  return arr.map((x) => (typeof x === 'string' ? x : String(x == null ? '' : x)));
}

/** 目标语言的中文名（用于提示词），未支持的语言直接用代码 */
function targetLanguageName(target) {
  const info = langInfo(target);
  if (info) return info.name;
  const b = baseLang(target);
  return (LANGS[b] && LANGS[b].name) || b || '目标语言';
}

async function openaiTranslateBatch(texts, target) {
  const o = config.openai;
  if (!o.apiKey) throw new Error('还没有填写 API Key，请在「翻译设置」里配置');
  const base = String(o.baseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
  const tname = targetLanguageName(target);
  // 以前这里写死了「简体中文」，目标语言选日语/英语时结果仍是中文
  const sys =
    '你是专业的学术论文翻译助手。把用户给出的 JSON 字符串数组逐条翻译成' + tname + '。' +
    '要求：1) 只输出 JSON 字符串数组，长度、顺序与输入完全一致；2) 不要输出任何解释或 Markdown 代码块；' +
    '3) 保留公式、变量名、代码、参考文献编号、专有名词的原文，必要时在括号里补充' + tname + '释义；' +
    '4) 译文要通顺、准确，适合学习和理解论文。';
  const body = JSON.stringify({
    model: o.model || 'deepseek-chat',
    temperature: 0.2,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: JSON.stringify(texts) },
    ],
  });
  const raw = await requestRetry(
    base + '/chat/completions',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + o.apiKey,
      },
      body,
      timeout: 120000,
    },
    2
  );
  let data;
  try {
    data = JSON.parse(raw);
  } catch (_) {
    throw new Error('翻译接口返回了无法解析的内容');
  }
  if (data && data.error) throw new Error(data.error.message || '翻译接口报错');
  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : '';
  const arr = parseJsonArray(content);
  if (arr.length !== texts.length) {
    throw new Error('模型返回的条数不对（' + arr.length + '/' + texts.length + '）');
  }
  return arr;
}

/**
 * 翻译一组文本，保持顺序。
 * @param {string[]} texts
 * @param {{service?:string,target?:string}} [opts]
 * @returns {Promise<string[]>}
 */
async function translateTexts(texts, opts) {
  const list = Array.isArray(texts) ? texts.map((t) => String(t == null ? '' : t)) : [];
  const o = opts || {};
  const wanted = o.service || config.service;
  const service = wanted === 'openai' || wanted === 'google' || wanted === 'bing' ? wanted : 'bing';
  const target = o.target || config.targetLang || 'zh-CN';
  const out = new Array(list.length);
  const pending = [];

  list.forEach((t, i) => {
    const text = t.trim();
    if (!text || !/\p{L}/u.test(text)) {
      out[i] = t;
      return;
    }
    const k = cacheKey(service, target, text);
    if (textCache.has(k)) out[i] = textCache.get(k);
    else pending.push({ i, text, k });
  });

  if (pending.length) {
    if (service === 'openai') {
      // 按字符数分组，避免一次塞太多
      const groups = [];
      let cur = [];
      let size = 0;
      for (const p of pending) {
        // 批次小一点，减少长文被 max_tokens 截断导致整批 JSON 解析失败
        if (cur.length && (cur.length >= 8 || size + p.text.length > 4000)) {
          groups.push(cur);
          cur = [];
          size = 0;
        }
        cur.push(p);
        size += p.text.length;
      }
      if (cur.length) groups.push(cur);
      for (const g of groups) {
        let arr;
        try {
          arr = await openaiTranslateBatch(g.map((p) => p.text), target);
        } catch (e) {
          if (g.length === 1) throw e;
          // 整批失败时退化成逐条，尽量不让整页翻译挂掉
          arr = [];
          for (const p of g) {
            try {
              const one = await openaiTranslateBatch([p.text], target);
              arr.push(one[0]);
            } catch (e2) {
              arr.push('');
            }
          }
        }
        g.forEach((p, j) => {
          const tr = arr[j] || '';
          out[p.i] = tr || p.text;
          if (tr) {
            textCache.set(p.k, tr);
          }
        });
      }
    } else {
      const primary = service === 'bing' ? bingTranslate : googleTranslate;
      const secondary = service === 'bing' ? googleTranslate : bingTranslate;
      let failed = 0;
      const res = await mapLimit(pending, 3, async (p) => {
        try {
          return await primary(p.text, target);
        } catch (e) {
          try {
            // 主服务被限流时自动换另一家免费接口
            return await secondary(p.text, target);
          } catch (e2) {
            return { error: e2, primary: e };
          }
        }
      });
      res.forEach((tr, j) => {
        const p = pending[j];
        if (tr && typeof tr === 'object' && tr.error) {
          // 单条失败保留原文，整体不报错（第一页就能看到内容）
          out[p.i] = p.text;
          failed++;
          return;
        }
        out[p.i] = tr || p.text;
        if (tr) textCache.set(p.k, tr);
      });
      if (failed && failed === pending.length) {
        const sample = res.find((r) => r && typeof r === 'object' && r.error);
        const pMsg = sample && sample.primary ? sample.primary.message : '';
        const sMsg = sample && sample.error ? sample.error.message : '';
        const detail = [pMsg && 'Bing: ' + pMsg, sMsg && 'Google: ' + sMsg]
          .filter(Boolean)
          .join(' / ');
        throw new Error(
          '翻译服务暂时不可用' + (detail ? '（' + detail + '）' : '（Bing / Google 都被限流了）') +
          '，请稍后重试或改用 API Key'
        );
      }
    }
    scheduleCacheSave();
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* 单词查询（悬停 / 选中翻译）                                           */
/* ------------------------------------------------------------------ */

async function youdaoLookup(word) {
  const url = 'https://dict.youdao.com/jsonapi?q=' + encodeURIComponent(word);
  const body = await requestRetry(
    url,
    {
      timeout: 8000,
      headers: { 'User-Agent': BING_UA, Accept: 'application/json,text/plain,*/*' },
    },
    2
  );
  const data = JSON.parse(body);
  const ec = data && data.ec;
  const w = ec && Array.isArray(ec.word) ? ec.word[0] : null;
  if (!w) return null;
  const phonetic = w.usphone || w.ukphone || '';
  const meanings = [];
  for (const tr of w.trs || []) {
    for (const t of tr.tr || []) {
      const items = (t.l && t.l.i) || [];
      for (const it of items) {
        if (typeof it === 'string' && it.trim()) meanings.push(it.trim());
      }
    }
  }
  if (!meanings.length) return null;
  return { phonetic: phonetic, meanings: meanings };
}

/**
 * 查一个单词或短语：优先后有道词典（带音标和词性），失败再走翻译接口。
 * @param {string} text
 */
async function dictLookup(text) {
  const q = String(text || '').replace(/\s+/g, ' ').trim();
  if (!q) throw new Error('没有要查询的内容');
  if (q.length > 80) throw new Error('一次最多查询 80 个字符');

  const key = 'dict|' + config.targetLang + '|' + q.toLowerCase();
  if (textCache.has(key)) {
    try {
      return JSON.parse(textCache.get(key));
    } catch (_) {
      /* 缓存坏了就重新查 */
    }
  }

  let result = null;
  // 有道是英汉词典：只有译文是中文时才用它，其他目标语言走翻译接口
  if (/^zh/i.test(config.targetLang) && /^[A-Za-z][A-Za-z'’\- ]{0,60}$/.test(q)) {
    try {
      const y = await youdaoLookup(q);
      if (y) {
        result = { word: q, phonetic: y.phonetic, meanings: y.meanings, source: 'youdao' };
      }
    } catch (_) {
      /* 词典不可用时退回翻译 */
    }
  }

  if (!result) {
    const tr = await translateTexts([q]);
    result = {
      word: q,
      phonetic: '',
      meanings: [tr[0] || q],
      source: 'translate',
    };
  }

  textCache.set(key, JSON.stringify(result));
  scheduleCacheSave();
  return result;
}

/* ------------------------------------------------------------------ */
/* 语音朗读（Edge TTS）                                                  */
/* ------------------------------------------------------------------ */

const TTS_VOICE_RE = /^[a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural$/;
const ttsPending = new Map();
let ttsCacheDirEnsured = false;
let ttsTmpSeq = 0;

function ensureTtsCacheDir() {
  if (ttsCacheDirEnsured) return;
  ensureDir(TTS_CACHE_DIR);
  ttsCacheDirEnsured = true;
}

const TTS_WORKER_SCRIPT = [
  'import asyncio, base64, json, socket, sys, time',
  'import aiohttp, edge_tts',
  '',
  'try:',
  '    from xml.sax.saxutils import escape as _xml_escape',
  '    from edge_tts.constants import WSS_URL, WSS_HEADERS, SEC_MS_GEC_VERSION',
  '    from edge_tts.drm import DRM',
  '    from edge_tts.communicate import (',
  '        _SSL_CTX,',
  '        connect_id,',
  '        date_to_string,',
  '        get_headers_and_data,',
  '        mkssml,',
  '        remove_incompatible_characters,',
  '        split_text_by_byte_length,',
  '        ssml_headers_plus_data,',
  '    )',
  '    from edge_tts.data_classes import TTSConfig',
  '    from edge_tts.exceptions import NoAudioReceived, UnexpectedResponse, UnknownResponse, WebSocketError',
  '    HAS_STANDBY_WS = True',
  'except Exception:',
  '    HAS_STANDBY_WS = False',
  '',
  'class SharedTCPConnector(aiohttp.TCPConnector):',
  '    def __init__(self, *args, **kwargs):',
  '        super().__init__(*args, **kwargs)',
  '        self._ip_penalty = {}',
  '        self._ip_latency = {}',
  '        self._rr = 0',
  '    async def close(self):',
  '        return None',
  '    async def real_close(self):',
  '        return await super().close()',
  '    def mark_bad_ip(self, ip):',
  '        if ip:',
  '            self._ip_penalty[ip] = time.monotonic() + 30.0',
  '    def mark_good_ip(self, ip, lat_ms=None):',
  '        if ip:',
  '            self._ip_penalty.pop(ip, None)',
  '            if lat_ms is not None:',
  '                prev = self._ip_latency.get(ip)',
  '                self._ip_latency[ip] = lat_ms if prev is None else (prev * 0.5 + lat_ms * 0.5)',
  '    def ip_score(self, ip):',
  '        now = time.monotonic()',
  '        if self._ip_penalty.get(ip, 0) > now:',
  '            return 100000.0',
  '        return self._ip_latency.get(ip, 500.0)',
  '    async def _resolve_host(self, host, port, traces=None):',
  '        res = await super()._resolve_host(host, port, traces=traces)',
  '        if len(res) > 1:',
  '            now = time.monotonic()',
  '            good = [r for r in res if self._ip_penalty.get(r.get("host"), 0) <= now]',
  '            bad = [r for r in res if self._ip_penalty.get(r.get("host"), 0) > now]',
  '            if good:',
  '                idx = self._rr % len(good)',
  '                self._rr += 1',
  '                return good[idx:] + good[:idx] + bad',
  '        return res',
  '',
  'async def main():',
  '    # 优先走 IPv4，规避双栈网络中 IPv6 路由卡顿；失败时自动退回 AF_UNSPEC',
  '    connector_v4 = SharedTCPConnector(limit=16, ttl_dns_cache=300, keepalive_timeout=60, family=socket.AF_INET)',
  '    connector_any = SharedTCPConnector(limit=16, ttl_dns_cache=300, keepalive_timeout=60)',
  '    tasks = {}',
  '    shutdown_evt = asyncio.Event()',
  '    loop = asyncio.get_running_loop()',
  '    standby_pool = []',
  '    STANDBY_TARGET = 4',
  '    MAX_STANDBY_AGE = 18.0',
  '    HEDGE_DELAY = 0.70',
  '    refill_running = False',
  '    session_v4 = None',
  '    session_any = None',
  '    if HAS_STANDBY_WS:',
  '        timeout_cfg = aiohttp.ClientTimeout(total=None, connect=None, sock_connect=10, sock_read=60)',
  '        session_v4 = aiohttp.ClientSession(connector=connector_v4, trust_env=True, timeout=timeout_cfg)',
  '        session_any = aiohttp.ClientSession(connector=connector_any, trust_env=True, timeout=timeout_cfg)',
  '',
  '    def emit(obj):',
  '        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\\n")',
  '        sys.stdout.flush()',
  '',
  '    def ws_peer_ip(ws):',
  '        try:',
  '            tr = getattr(getattr(ws, "_writer", None), "transport", None)',
  '            if tr is None:',
  '                tr = getattr(getattr(getattr(ws, "_response", None), "connection", None), "transport", None)',
  '            peer = tr.get_extra_info("peername") if tr else None',
  '            return peer[0] if peer else None',
  '        except Exception:',
  '            return None',
  '',
  '    async def warm_dns():',
  '        try:',
  '            await loop.getaddrinfo("speech.platform.bing.com", 443, family=socket.AF_INET, type=socket.SOCK_STREAM)',
  '        except Exception:',
  '            pass',
  '',
  '    async def close_ws_quiet(ws):',
  '        if ws is None:',
  '            return',
  '        try:',
  '            await ws.close()',
  '        except Exception:',
  '            pass',
  '',
  '    async def open_ws(use_any=False):',
  '        sess = session_any if use_any else session_v4',
  '        for attempt in range(2):',
  '            try:',
  '                return await sess.ws_connect(',
  '                    f"{WSS_URL}&ConnectionId={connect_id()}"',
  '                    f"&Sec-MS-GEC={DRM.generate_sec_ms_gec()}"',
  '                    f"&Sec-MS-GEC-Version={SEC_MS_GEC_VERSION}",',
  '                    compress=15,',
  '                    headers=DRM.headers_with_muid(WSS_HEADERS),',
  '                    ssl=_SSL_CTX,',
  '                )',
  '            except aiohttp.ClientResponseError as e:',
  '                if e.status == 403 and attempt == 0:',
  '                    DRM.handle_client_response_error(e)',
  '                    continue',
  '                raise',
  '',
  '    async def prune_standby():',
  '        now = time.monotonic()',
  '        alive = []',
  '        to_close = []',
  '        for ws, opened_at in standby_pool:',
  '            if not ws.closed and (now - opened_at) < MAX_STANDBY_AGE:',
  '                alive.append((ws, opened_at))',
  '            else:',
  '                to_close.append(ws)',
  '        standby_pool[:] = alive',
  '        for ws in to_close:',
  '            await close_ws_quiet(ws)',
  '',
  '    async def refill_standby():',
  '        nonlocal refill_running',
  '        if not HAS_STANDBY_WS or refill_running or shutdown_evt.is_set():',
  '            return',
  '        refill_running = True',
  '        try:',
  '            await prune_standby()',
  '            needed = STANDBY_TARGET - len(standby_pool)',
  '            if needed > 0 and not shutdown_evt.is_set():',
  '                async def open_one():',
  '                    try:',
  '                        ws = await open_ws(use_any=False)',
  '                    except aiohttp.ClientConnectorError:',
  '                        ws = await open_ws(use_any=True)',
  '                    if shutdown_evt.is_set():',
  '                        await close_ws_quiet(ws)',
  '                        return',
  '                    standby_pool.append((ws, time.monotonic()))',
  '                await asyncio.gather(*(open_one() for _ in range(needed)), return_exceptions=True)',
  '        finally:',
  '            refill_running = False',
  '',
  '    def schedule_refill():',
  '        if HAS_STANDBY_WS and not shutdown_evt.is_set() and not refill_running:',
  '            asyncio.create_task(refill_standby())',
  '',
  '    async def standby_keeper():',
  '        if not HAS_STANDBY_WS:',
  '            return',
  '        schedule_refill()',
  '        while not shutdown_evt.is_set():',
  '            try:',
  '                await asyncio.wait_for(shutdown_evt.wait(), timeout=10.0)',
  '                break',
  '            except asyncio.TimeoutError:',
  '                await prune_standby()',
  '                if len(standby_pool) < STANDBY_TARGET:',
  '                    schedule_refill()',
  '',
  '    async def checkout_ws(avoid_ip=None):',
  '        now = time.monotonic()',
  '        alive = []',
  '        to_close = []',
  '        for ws, opened_at in standby_pool:',
  '            if ws.closed or (now - opened_at) >= MAX_STANDBY_AGE:',
  '                to_close.append(ws)',
  '            else:',
  '                alive.append((ws, opened_at))',
  '        standby_pool[:] = alive',
  '        best_idx = -1',
  '        best_score = 1e12',
  '        for i, (ws, _) in enumerate(standby_pool):',
  '            ip = ws_peer_ip(ws)',
  '            if avoid_ip and ip == avoid_ip:',
  '                continue',
  '            sc = connector_v4.ip_score(ip)',
  '            if sc < best_score:',
  '                best_score = sc',
  '                best_idx = i',
  '        if best_idx < 0 and standby_pool:',
  '            best_idx = len(standby_pool) - 1',
  '        picked = standby_pool.pop(best_idx)[0] if best_idx >= 0 else None',
  '        schedule_refill()',
  '        try:',
  '            for ws in to_close:',
  '                await close_ws_quiet(ws)',
  '        except BaseException:',
  '            if picked is not None:',
  '                await close_ws_quiet(picked)',
  '            raise',
  '        return picked, (picked is not None)',
  '',
  '    def parse_ws_msg(msg):',
  '        if msg.type == aiohttp.WSMsgType.TEXT:',
  '            encoded_data = msg.data.encode("utf-8")',
  '            parameters, _ = get_headers_and_data(encoded_data, encoded_data.find(b"\\r\\n\\r\\n"))',
  '            p = parameters.get(b"Path", None)',
  '            if p == b"turn.end":',
  '                return ("end", None)',
  '            if p not in (b"response", b"turn.start", b"audio.metadata"):',
  '                raise UnknownResponse("Unknown path received")',
  '            return ("meta", None)',
  '        if msg.type == aiohttp.WSMsgType.BINARY:',
  '            if len(msg.data) < 2:',
  '                raise UnexpectedResponse("We received a binary message, but it is missing the header length.")',
  '            header_length = int.from_bytes(msg.data[:2], "big")',
  '            if header_length > len(msg.data):',
  '                raise UnexpectedResponse("The header length is greater than the length of the data.")',
  '            parameters, data = get_headers_and_data(msg.data, header_length)',
  '            if parameters.get(b"Path") != b"audio":',
  '                raise UnexpectedResponse("Received binary message, but the path is not audio.")',
  '            content_type = parameters.get(b"Content-Type", None)',
  '            if content_type not in (b"audio/mpeg", None):',
  '                raise UnexpectedResponse("Received binary message, but with an unexpected Content-Type.")',
  '            if content_type is None:',
  '                if len(data) == 0:',
  '                    return ("meta", None)',
  '                raise UnexpectedResponse("Received binary message with no Content-Type, but with data.")',
  '            if len(data) == 0:',
  '                raise UnexpectedResponse("Received binary message, but it is missing the audio data.")',
  '            return ("audio", data)',
  '        if msg.type == aiohttp.WSMsgType.ERROR:',
  '            raise WebSocketError(msg.data if msg.data else "Unknown error")',
  '        if msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.CLOSING):',
  '            return ("closed", None)',
  '        return ("meta", None)',
  '',
  '    async def open_or_checkout(avoid_ip=None):',
  '        ws, from_pool = await checkout_ws(avoid_ip=avoid_ip)',
  '        if ws is not None:',
  '            return ws, from_pool',
  '        try:',
  '            return await open_ws(use_any=False), False',
  '        except aiohttp.ClientConnectorError:',
  '            return await open_ws(use_any=True), False',
  '',
  '    async def start_and_get_first(ws, tc, part_bytes, timeout_s):',
  '        t0 = time.monotonic()',
  '        cfg_json = json.dumps({"context": {"synthesis": {"audio": {"metadataoptions": {"sentenceBoundaryEnabled": "true", "wordBoundaryEnabled": "false"}, "outputFormat": "audio-24khz-48kbitrate-mono-mp3"}}}})',
  '        await ws.send_str(',
  '            f"X-Timestamp:{date_to_string()}\\r\\n"',
  '            "Content-Type:application/json; charset=utf-8\\r\\n"',
  '            "Path:speech.config\\r\\n\\r\\n"',
  '            + cfg_json + "\\r\\n"',
  '        )',
  '        await ws.send_str(',
  '            ssml_headers_plus_data(',
  '                connect_id(),',
  '                date_to_string(),',
  '                mkssml(tc, part_bytes),',
  '            )',
  '        )',
  '        while True:',
  '            msg = await ws.receive(timeout=timeout_s)',
  '            kind, data = parse_ws_msg(msg)',
  '            if kind == "audio":',
  '                lat_ms = (time.monotonic() - t0) * 1000.0',
  '                return ws, data, lat_ms',
  '            if kind == "end":',
  '                raise NoAudioReceived("No audio was received. Please verify that your parameters are correct.")',
  '            if kind == "closed":',
  '                raise WebSocketError("WebSocket closed before audio")',
  '',
  '    async def continue_ws_stream(job_id, ws):',
  '        while True:',
  '            msg = await ws.receive(timeout=60.0)',
  '            kind, data = parse_ws_msg(msg)',
  '            if kind == "audio":',
  '                emit({"type": "chunk", "id": job_id, "data": base64.b64encode(data).decode("ascii")})',
  '            elif kind in ("end", "closed"):',
  '                break',
  '',
  '    async def run_with_connector(job_id, text, voice, rate, conn):',
  '        got_audio = False',
  '        comm = edge_tts.Communicate(text, voice, rate=rate, connector=conn)',
  '        async for msg in comm.stream():',
  '            if msg.get("type") == "audio":',
  '                data = msg.get("data")',
  '                if data:',
  '                    got_audio = True',
  '                    emit({"type": "chunk", "id": job_id, "data": base64.b64encode(data).decode("ascii")})',
  '        return got_audio',
  '',
  '    async def stream_part_hedged(job_id, tc, part_bytes, speakable, can_hedge):',
  '        async def run_probe(avoid_ip, timeout_s, ip_box=None):',
  '            ws, _ = await open_or_checkout(avoid_ip=avoid_ip)',
  '            ip = ws_peer_ip(ws)',
  '            if ip_box is not None:',
  '                ip_box[0] = ip',
  '            try:',
  '                res = await start_and_get_first(ws, tc, part_bytes, timeout_s)',
  '                connector_v4.mark_good_ip(ip, res[2])',
  '                return res',
  '            except asyncio.CancelledError:',
  '                await close_ws_quiet(ws)',
  '                raise',
  '            except Exception as e:',
  '                if speakable or not isinstance(e, NoAudioReceived):',
  '                    connector_v4.mark_bad_ip(ip)',
  '                await close_ws_quiet(ws)',
  '                raise',
  '',
  '        ip1_box = [None]',
  '        t1 = asyncio.create_task(run_probe(None, 4.0 if can_hedge else 8.0, ip1_box))',
  '        t2 = None',
  '        t3 = None',
  '        win_ws = None',
  '        first_chunk = None',
  '        try:',
  '            if not can_hedge:',
  '                win_ws, first_chunk, _ = await t1',
  '            else:',
  '                done, _ = await asyncio.wait({t1}, timeout=HEDGE_DELAY)',
  '                if t1 in done and not t1.cancelled() and t1.exception() is None:',
  '                    win_ws, first_chunk, _ = t1.result()',
  '                else:',
  '                    t2 = asyncio.create_task(run_probe(ip1_box[0], 4.0))',
  '                    pending = {t2} if t1 in done else {t1, t2}',
  '                    last_err = t1.exception() if (t1 in done and not t1.cancelled()) else None',
  '                    while pending:',
  '                        done2, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)',
  '                        for d in done2:',
  '                            if not d.cancelled() and d.exception() is None:',
  '                                win_ws, first_chunk, _ = d.result()',
  '                                break',
  '                            elif not d.cancelled():',
  '                                last_err = d.exception()',
  '                        if win_ws is not None:',
  '                            break',
  '                    if win_ws is None:',
  '                        # 若两路并发均偶发失败（如边缘节点抖动），再做一次全新直连兜底',
  '                        t3 = asyncio.create_task(run_probe(None, 8.0))',
  '                        win_ws, first_chunk, _ = await t3',
  '        finally:',
  '            for task in (t1, t2, t3):',
  '                if task is None:',
  '                    continue',
  '                if not task.done():',
  '                    task.cancel()',
  '                    try:',
  '                        await task',
  '                    except BaseException:',
  '                        pass',
  '                elif not task.cancelled() and task.exception() is None:',
  '                    try:',
  '                        cand_ws = task.result()[0]',
  '                        if cand_ws is not win_ws:',
  '                            await close_ws_quiet(cand_ws)',
  '                    except Exception:',
  '                        pass',
  '        try:',
  '            emit({"type": "chunk", "id": job_id, "data": base64.b64encode(first_chunk).decode("ascii")})',
  '            await continue_ws_stream(job_id, win_ws)',
  '        finally:',
  '            await close_ws_quiet(win_ws)',
  '',
  '    async def run_standby_synth(job_id, text, voice, rate):',
  '        tc = TTSConfig(voice, rate, "+0%", "+0Hz", "SentenceBoundary")',
  '        parts = list(split_text_by_byte_length(_xml_escape(remove_incompatible_characters(text)), 4096))',
  '        speakable = any(ch.isalnum() for ch in text)',
  '        got_audio = False',
  '        for idx, part in enumerate(parts):',
  '            await stream_part_hedged(job_id, tc, part, speakable, (not got_audio and speakable))',
  '            got_audio = True',
  '        return got_audio',
  '',
  '    async def run_synth(job_id, text, voice, rate):',
  '        try:',
  '            if HAS_STANDBY_WS:',
  '                got_audio = await run_standby_synth(job_id, text, voice, rate)',
  '            else:',
  '                try:',
  '                    got_audio = await run_with_connector(job_id, text, voice, rate, connector_v4)',
  '                except aiohttp.ClientConnectorError:',
  '                    got_audio = await run_with_connector(job_id, text, voice, rate, connector_any)',
  '            if not got_audio:',
  '                emit({"type": "error", "id": job_id, "error": "没有生成音频"})',
  '            else:',
  '                emit({"type": "end", "id": job_id})',
  '        except asyncio.CancelledError:',
  '            pass',
  '        except Exception as e:',
  '            emit({"type": "error", "id": job_id, "error": str(e)})',
  '        finally:',
  '            tasks.pop(job_id, None)',
  '',
  '    def handle_cmd(cmd):',
  '        t = cmd.get("type")',
  '        jid = cmd.get("id")',
  '        if t == "synth":',
  '            text = cmd.get("text", "")',
  '            voice = cmd.get("voice", "en-US-AriaNeural")',
  '            rate = cmd.get("rate", "+0%")',
  '            tasks[jid] = asyncio.create_task(run_synth(jid, text, voice, rate))',
  '        elif t == "cancel":',
  '            task = tasks.pop(jid, None)',
  '            if task:',
  '                task.cancel()',
  '        elif t == "ping":',
  '            emit({"type": "pong", "id": jid})',
  '',
  '    def read_stdin():',
  '        try:',
  '            while True:',
  '                raw = sys.stdin.readline()',
  '                if not raw:',
  '                    break',
  '                line = raw.strip()',
  '                if not line:',
  '                    continue',
  '                try:',
  '                    cmd = json.loads(line)',
  '                except Exception:',
  '                    continue',
  '                loop.call_soon_threadsafe(handle_cmd, cmd)',
  '        finally:',
  '            loop.call_soon_threadsafe(shutdown_evt.set)',
  '',
  '    emit({"type": "ready"})',
  '    asyncio.create_task(warm_dns())',
  '    keeper_task = asyncio.create_task(standby_keeper())',
  '    reader_fut = loop.run_in_executor(None, read_stdin)',
  '    await shutdown_evt.wait()',
  '    keeper_task.cancel()',
  '    for t in list(tasks.values()):',
  '        t.cancel()',
  '    for ws, _ in standby_pool:',
  '        await close_ws_quiet(ws)',
  '    standby_pool.clear()',
  '    try:',
  '        await reader_fut',
  '    except Exception:',
  '        pass',
  '    if session_v4 is not None:',
  '        await session_v4.close()',
  '    if session_any is not None:',
  '        await session_any.close()',
  '    await connector_v4.real_close()',
  '    await connector_any.real_close()',
  '',
  'asyncio.run(main())',
].join('\n');

let ttsWorker = null;
const brokenWorkerPythons = new Set();
const workerPreReadyFailures = new Map();
const MAX_PRE_READY_FAILURES = 3;

function resetTtsWorker() {
  const w = ttsWorker;
  ttsWorker = null;
  if (!w) return;
  w.stopping = true;
  if (w.startupTimer) clearTimeout(w.startupTimer);
  if (typeof w.finishStartup === 'function') w.finishStartup(false);
  for (const job of w.jobs.values()) {
    if (job.timer) clearTimeout(job.timer);
    job.onError(new Error('TTS worker 已关闭'));
  }
  w.jobs.clear();
  try {
    if (w.proc && w.proc.stdin && !w.proc.stdin.destroyed) w.proc.stdin.end();
  } catch (_) {}
}

function ensureTtsWorker() {
  if (ttsWorker && ttsWorker.proc && !ttsWorker.proc.killed && ttsWorker.proc.exitCode === null) {
    return ttsWorker.readyPromise;
  }
  const py = findEdgeTtsPython();
  if (!py || brokenWorkerPythons.has(py)) return Promise.resolve(null);

  let proc;
  try {
    proc = trackChild(
      cp.spawn(py, ['-u', '-c', TTS_WORKER_SCRIPT], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: Object.assign({}, process.env, {
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
          PYTHONUNBUFFERED: '1',
        }),
      })
    );
  } catch (_) {
    return Promise.resolve(null);
  }

  if (proc.stdin) proc.stdin.on('error', () => {});

  let resolveReady;
  const readyPromise = new Promise((resolve) => {
    resolveReady = resolve;
  });

  const finishStartup = (ok) => {
    if (worker.startupTimer) {
      clearTimeout(worker.startupTimer);
      worker.startupTimer = null;
    }
    if (!resolveReady) return;
    const r = resolveReady;
    resolveReady = null;
    r(ok ? worker : null);
  };

  const worker = {
    py,
    proc,
    ready: false,
    stopping: false,
    readyPromise,
    finishStartup,
    jobs: new Map(),
    seq: 0,
    stdoutBuf: '',
    stderrBuf: '',
    startupTimer: null,
  };
  ttsWorker = worker;

  const recordPreReadyFailure = () => {
    const count = (workerPreReadyFailures.get(py) || 0) + 1;
    workerPreReadyFailures.set(py, count);
    if (count >= MAX_PRE_READY_FAILURES) {
      brokenWorkerPythons.add(py);
    }
  };

  worker.startupTimer = setTimeout(() => {
    if (!worker.ready) {
      if (!worker.stopping) recordPreReadyFailure();
      worker.stopping = true;
      if (ttsWorker === worker) ttsWorker = null;
      killChild(proc);
      finishStartup(false);
    }
  }, 15000);
  if (worker.startupTimer.unref) worker.startupTimer.unref();

  proc.stderr.on('data', (d) => {
    worker.stderrBuf = (worker.stderrBuf + d.toString()).slice(-1000);
  });

  proc.stdout.on('data', (d) => {
    worker.stdoutBuf += d.toString('utf8');
    let nl;
    while ((nl = worker.stdoutBuf.indexOf('\n')) >= 0) {
      const line = worker.stdoutBuf.slice(0, nl).trim();
      worker.stdoutBuf = worker.stdoutBuf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (_) {
        continue;
      }
      if (msg.type === 'ready') {
        worker.ready = true;
        workerPreReadyFailures.delete(py);
        finishStartup(true);
        continue;
      }
      const job = worker.jobs.get(msg.id);
      if (!job) continue;
      if (msg.type === 'chunk') {
        if (msg.data) {
          refreshJobTimer(job);
          job.onChunk(Buffer.from(msg.data, 'base64'));
        }
      } else if (msg.type === 'end') {
        worker.jobs.delete(msg.id);
        if (job.timer) clearTimeout(job.timer);
        job.onEnd();
      } else if (msg.type === 'error') {
        worker.jobs.delete(msg.id);
        if (job.timer) clearTimeout(job.timer);
        job.onError(new Error(msg.error || '语音合成失败'));
      }
    }
  });

  function refreshJobTimer(job) {
    if (job.timer) clearTimeout(job.timer);
    job.timer = setTimeout(() => {
      worker.jobs.delete(job.id);
      try {
        if (!proc.killed && proc.stdin.writable) {
          proc.stdin.write(JSON.stringify({ type: 'cancel', id: job.id }) + '\n');
        }
      } catch (_) {}
      job.onError(new Error('语音合成超时'));
    }, 30000);
    if (job.timer.unref) job.timer.unref();
  }

  worker.refreshJobTimer = refreshJobTimer;

  const onExit = (code) => {
    if (ttsWorker === worker) ttsWorker = null;
    if (!worker.ready) {
      if (!worker.stopping && code !== 0) recordPreReadyFailure();
      finishStartup(false);
    }
    const err = new Error(
      'edge-tts worker 退出' + (code != null ? ' (' + code + ')' : '') +
        (worker.stderrBuf ? '：' + worker.stderrBuf.slice(0, 200) : '')
    );
    for (const job of worker.jobs.values()) {
      if (job.timer) clearTimeout(job.timer);
      job.onError(err);
    }
    worker.jobs.clear();
  };

  proc.on('error', () => onExit(null));
  proc.on('close', (code) => onExit(code));

  return readyPromise;
}

function warmTtsWorker() {
  return ensureTtsWorker().catch(() => null);
}

function dispatchWorkerJob(worker, { text, voice, rateStr }, callbacks) {
  const id = ++worker.seq;
  let cancelled = false;
  const job = {
    id,
    timer: null,
    onChunk: callbacks.onChunk,
    onEnd: callbacks.onEnd,
    onError: callbacks.onError,
  };
  worker.jobs.set(id, job);
  worker.refreshJobTimer(job);

  try {
    worker.proc.stdin.write(
      JSON.stringify({ type: 'synth', id, text, voice, rate: rateStr }) + '\n'
    );
  } catch (e) {
    worker.jobs.delete(id);
    if (job.timer) clearTimeout(job.timer);
    throw e;
  }

  return () => {
    if (cancelled) return;
    cancelled = true;
    if (worker.jobs.delete(id)) {
      if (job.timer) clearTimeout(job.timer);
      try {
        if (!worker.proc.killed && worker.proc.stdin.writable) {
          worker.proc.stdin.write(JSON.stringify({ type: 'cancel', id }) + '\n');
        }
      } catch (_) {}
    }
  };
}

function spawnCliStreamJob(exe, { text, voice, rate }, callbacks) {
  const args = ['--voice', voice, '--text=' + text, '--write-media', '-', '--no-progress'];
  if (rate !== 0) args.push('--rate=' + (rate > 0 ? '+' : '') + rate + '%');

  const child = trackChild(
    cp.spawn(exe, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, {
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        PYTHONUNBUFFERED: '1',
      }),
    })
  );

  let errText = '';
  let gotAudio = false;
  let finished = false;
  let cancelled = false;

  let timer = setTimeout(() => {
    if (finished) return;
    finished = true;
    killChild(child);
    callbacks.onError(new Error('语音合成超时'));
  }, 30000);
  if (timer.unref) timer.unref();

  const bumpTimer = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      killChild(child);
      callbacks.onError(new Error('语音合成超时'));
    }, 30000);
    if (timer.unref) timer.unref();
  };

  child.stderr.on('data', (d) => {
    errText = (errText + d.toString()).slice(-1000);
  });

  child.stdout.on('data', (chunk) => {
    if (finished || cancelled || !chunk || !chunk.length) return;
    gotAudio = true;
    bumpTimer();
    callbacks.onChunk(chunk);
  });

  child.on('error', (e) => {
    if (finished || cancelled) return;
    finished = true;
    clearTimeout(timer);
    callbacks.onError(e);
  });

  child.on('close', (code) => {
    if (finished || cancelled) return;
    finished = true;
    clearTimeout(timer);
    if (code !== 0) {
      callbacks.onError(
        new Error('edge-tts 退出码 ' + code + (errText ? '：' + errText.slice(0, 200) : ''))
      );
      return;
    }
    if (!gotAudio) {
      callbacks.onError(new Error('没有生成音频'));
      return;
    }
    callbacks.onEnd();
  });

  return () => {
    if (cancelled || finished) return;
    cancelled = true;
    finished = true;
    clearTimeout(timer);
    killChild(child);
  };
}

const LATIN_LANGS = new Set(['en', 'fr', 'de', 'es', 'pt', 'it', 'nl', 'pl', 'tr', 'vi', 'id']);

/** 按文字本身判断语言；拉丁字母返回空串，交给调用方给的语言提示 */
function detectScriptLang(text) {
  const s = String(text || '');
  if (/[぀-ヿ]/.test(s)) return 'ja';
  if (/[가-힯]/.test(s)) return 'ko';
  if (/[一-鿿]/.test(s)) return 'zh';
  if (/[؀-ۿ]/.test(s)) return 'ar';
  if (/[ऀ-ॿ]/.test(s)) return 'hi';
  if (/[฀-๿]/.test(s)) return 'th';
  if (/[Ѐ-ӿ]/.test(s)) return 'ru';
  return '';
}

function pickVoice(text, voice, langHint) {
  if (voice && TTS_VOICE_RE.test(voice)) return voice;
  let lang = detectScriptLang(text);
  if (lang === 'zh' && /^zh-TW/i.test(langHint || '')) lang = 'zh-TW';
  if (!lang) {
    const b = baseLang(langHint);
    lang = LATIN_LANGS.has(b) ? b : 'en';
  }
  if (lang === 'en') return config.tts.voiceEn || LANGS.en.voice;
  if (lang === 'zh') return config.tts.voiceZh || LANGS['zh-CN'].voice;
  const info = LANGS[lang] || LANGS[baseLang(lang)];
  return (info && info.voice) || config.tts.voiceEn || LANGS.en.voice;
}

function parseTtsParams(text, opts) {
  const q = String(text || '').replace(/\s+/g, ' ').trim();
  if (!q) throw Object.assign(new Error('没有要朗读的文字'), { code: 'bad-request' });
  if (q.length > 1200) {
    throw Object.assign(new Error('一次最多朗读 1200 个字符'), { code: 'bad-request' });
  }
  const o = opts || {};
  const voice = pickVoice(q, o.voice, o.lang);
  let rate = parseInt(o.rate != null ? o.rate : config.tts.rate, 10);
  if (!Number.isFinite(rate)) rate = 0;
  rate = Math.max(-50, Math.min(100, rate));
  const rateStr = (rate >= 0 ? '+' : '') + rate + '%';
  const key = crypto
    .createHash('sha1')
    .update([voice, rate, q].join('|'))
    .digest('hex')
    .slice(0, 24);
  const out = path.join(TTS_CACHE_DIR, key + '.mp3');
  return { q, voice, rate, rateStr, key, out };
}

function createTtsStreamJob({ key, q, voice, rate, rateStr, out }) {
  ensureTtsCacheDir();
  const tmpPath = path.join(TTS_CACHE_DIR, key + '.' + process.pid + '.' + (++ttsTmpSeq) + '.tmp.mp3');

  let resolveFile;
  let rejectFile;
  const filePromise = new Promise((resolve, reject) => {
    resolveFile = resolve;
    rejectFile = reject;
  });
  // 防止流式调用方不直接 await filePromise 时触发 unhandledRejection
  filePromise.catch(() => {});

  let ws = null;
  let cacheWriteFailed = false;
  let wsError = null;

  const openTmpStream = () => {
    if (ws || cacheWriteFailed) return;
    try {
      ws = fs.createWriteStream(tmpPath);
      ws.on('error', (e) => {
        cacheWriteFailed = true;
        wsError = e;
      });
    } catch (e) {
      cacheWriteFailed = true;
      wsError = e;
    }
  };

  const cleanupTmp = async () => {
    if (ws) {
      const stream = ws;
      ws = null;
      await new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(t);
          resolve();
        };
        const t = setTimeout(finish, 500);
        if (t.unref) t.unref();
        stream.once('close', finish);
        stream.once('error', finish);
        try { stream.destroy(); } catch (_) { finish(); }
      });
    }
    try { await fs.promises.unlink(tmpPath); } catch (_) {}
  };

  const commitTmp = async () => {
    if (cacheWriteFailed || !ws) {
      await cleanupTmp();
      if (wsError) throw wsError;
      throw new Error('缓存写入失败');
    }
    await new Promise((resolve, reject) => {
      ws.once('error', reject);
      ws.end(resolve);
    });
    ws = null;
    try {
      await fs.promises.rename(tmpPath, out);
    } catch (_) {
      // 某些 Windows 环境下 rename 可能报 EXDEV/EPERM，退回 copyFile
      await fs.promises.copyFile(tmpPath, out);
      try { await fs.promises.unlink(tmpPath); } catch (_) {}
    }
    return out;
  };

  const job = {
    key,
    voice,
    rate,
    chunks: [],
    totalBytes: 0,
    done: false,
    error: null,
    cancelled: false,
    subscribers: new Set(),
    waiters: 0,
    cancelUpstream: null,
    filePromise,
  };

  const failJob = (err) => {
    if (job.cancelled || job.done || job.error) return;
    job.error = err;
    ttsPending.delete(key);
    cleanupTmp();
    for (const sub of Array.from(job.subscribers)) {
      try { sub.onError(err); } catch (_) {}
    }
    job.subscribers.clear();
    rejectFile(err);
  };

  const callbacks = {
    onChunk: (buf) => {
      if (job.cancelled || job.done || job.error || !buf || !buf.length) return;
      job.chunks.push(buf);
      job.totalBytes += buf.length;
      openTmpStream();
      if (ws && !cacheWriteFailed) {
        try { ws.write(buf); } catch (_) { cacheWriteFailed = true; }
      }
      for (const sub of Array.from(job.subscribers)) {
        try { sub.onChunk(buf); } catch (_) {}
      }
    },
    onEnd: () => {
      if (job.cancelled || job.done || job.error) return;
      if (job.totalBytes <= 0) {
        failJob(new Error('没有生成音频'));
        return;
      }
      job.done = true;
      for (const sub of Array.from(job.subscribers)) {
        try { sub.onEnd(); } catch (_) {}
      }
      job.subscribers.clear();
      if (job.totalBytes > 100) {
        commitTmp()
          .then((savedPath) => {
            ttsPending.delete(key);
            resolveFile(savedPath);
          })
          .catch((e) => {
            ttsPending.delete(key);
            cleanupTmp();
            rejectFile(e);
          });
      } else {
        ttsPending.delete(key);
        cleanupTmp();
        rejectFile(new Error('音频过短'));
      }
    },
    onError: failJob,
  };

  job.subscribe = (handlers) => {
    const h = handlers || {};
    const sub = {
      onChunk: typeof h.onChunk === 'function' ? h.onChunk : () => {},
      onEnd: typeof h.onEnd === 'function' ? h.onEnd : () => {},
      onError: typeof h.onError === 'function' ? h.onError : () => {},
    };
    for (const c of job.chunks) sub.onChunk(c);
    if (job.done) {
      sub.onEnd();
      return () => {};
    }
    if (job.error) {
      sub.onError(job.error);
      return () => {};
    }
    job.subscribers.add(sub);
    return () => {
      job.subscribers.delete(sub);
      if (
        job.subscribers.size === 0 &&
        job.waiters === 0 &&
        !job.done &&
        !job.error &&
        !job.cancelled
      ) {
        job.cancelled = true;
        ttsPending.delete(key);
        if (job.cancelUpstream) {
          try { job.cancelUpstream(); } catch (_) {}
        }
        cleanupTmp();
        rejectFile(Object.assign(new Error('已取消'), { code: 'cancelled' }));
      }
    };
  };

  // 启动上游合成：优先复用常驻 Python worker，不可用时自动退回 CLI 流式输出
  ensureTtsWorker()
    .then((worker) => {
      if (job.cancelled || job.done || job.error) return;
      if (worker) {
        try {
          job.cancelUpstream = dispatchWorkerJob(worker, { text: q, voice, rateStr }, callbacks);
          return;
        } catch (_) {
          /* worker stdin 不可写时落到 CLI 兜底 */
        }
      }
      const exe = findEdgeTts();
      if (!exe) {
        failJob(Object.assign(new Error('语音引擎尚未安装'), { code: 'tts-missing' }));
        return;
      }
      job.cancelUpstream = spawnCliStreamJob(exe, { text: q, voice, rate }, callbacks);
    })
    .catch((e) => failJob(e));

  return job;
}

/**
 * 流式语音合成：缓存命中时直接返回文件路径；未命中时返回可订阅的实时流，并在后台落盘缓存。
 */
async function streamSpeech(text, opts) {
  const { q, voice, rate, rateStr, key, out } = parseTtsParams(text, opts);
  try {
    const st = await fs.promises.stat(out);
    if (st.isFile() && st.size > 100) {
      return { hit: true, file: out, voice, rate, key };
    }
  } catch (_) {
    /* 还没缓存 */
  }

  let job = ttsPending.get(key);
  if (!job) {
    const exe = findEdgeTts();
    const py = findEdgeTtsPython();
    if (!exe && !py) {
      throw Object.assign(new Error('语音引擎尚未安装'), { code: 'tts-missing' });
    }
    job = createTtsStreamJob({ key, q, voice, rate, rateStr, out });
    ttsPending.set(key, job);
  }

  return {
    hit: false,
    voice,
    rate,
    key,
    subscribe: (handlers) => job.subscribe(handlers),
    filePromise: job.filePromise,
  };
}

/**
 * 合成一段语音，返回本地 mp3 路径。相同文字/音色/语速直接命中缓存。
 * @param {string} text
 * @param {{voice?:string, rate?:number|string}} [opts]
 */
async function synthesizeSpeech(text, opts) {
  const { q, voice, rate, rateStr, key, out } = parseTtsParams(text, opts);
  try {
    const st = await fs.promises.stat(out);
    if (st.isFile() && st.size > 100) return out;
  } catch (_) {
    /* 还没缓存 */
  }

  let job = ttsPending.get(key);
  if (!job) {
    const exe = findEdgeTts();
    const py = findEdgeTtsPython();
    if (!exe && !py) {
      throw Object.assign(new Error('语音引擎尚未安装'), { code: 'tts-missing' });
    }
    job = createTtsStreamJob({ key, q, voice, rate, rateStr, out });
    ttsPending.set(key, job);
  }

  job.waiters++;
  try {
    return await job.filePromise;
  } finally {
    job.waiters--;
  }
}

/** 用 pdf2zh 自带的 PyMuPDF 抽出 PDF 每页文字，供朗读使用 */
function extractPdfText(file) {
  return new Promise((resolve, reject) => {
    const py = toolPythonPath();
    if (!py || !fs.existsSync(py)) {
      reject(Object.assign(new Error('需要先安装 PDF 引擎'), { code: 'engine-missing' }));
      return;
    }
    const script =
      'import fitz,json,sys;d=fitz.open(sys.argv[1]);' +
      'print(json.dumps([p.get_text() for p in d],ensure_ascii=False))';
    cp.execFile(
      py,
      ['-c', script, file],
      {
        encoding: 'utf8',
        maxBuffer: 40 * 1024 * 1024,
        timeout: 60000,
        windowsHide: true,
        env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }),
      },
      (err, stdout) => {
        if (err) {
          reject(new Error('PDF 文本读取失败：' + err.message));
          return;
        }
        try {
          const s = String(stdout || '');
          const a = s.indexOf('[');
          const b = s.lastIndexOf(']');
          if (a < 0 || b <= a) throw new Error('empty');
          resolve(JSON.parse(s.slice(a, b + 1)));
        } catch (_) {
          reject(new Error('PDF 文本解析失败'));
        }
      }
    );
  });
}

/* ------------------------------------------------------------------ */
/* 语言检测                                                             */
/* ------------------------------------------------------------------ */

const STOPWORDS = {
  en: ['the', 'and', 'of', 'to', 'is', 'in', 'that', 'for', 'with', 'as', 'on', 'this', 'are', 'be'],
  fr: ['le', 'la', 'les', 'des', 'et', 'une', 'un', 'du', 'est', 'que', 'pour', 'dans', 'avec', 'sur'],
  de: ['der', 'die', 'das', 'und', 'ist', 'ein', 'eine', 'mit', 'für', 'auf', 'den', 'dem', 'des', 'nicht'],
  es: ['el', 'la', 'los', 'las', 'y', 'una', 'un', 'es', 'que', 'para', 'con', 'en', 'por', 'del'],
  pt: ['o', 'a', 'os', 'as', 'e', 'uma', 'um', 'é', 'que', 'para', 'com', 'em', 'por', 'do', 'da'],
  it: ['il', 'la', 'i', 'le', 'e', 'una', 'un', 'è', 'che', 'per', 'con', 'in', 'di', 'del'],
  nl: ['de', 'het', 'een', 'en', 'is', 'van', 'dat', 'voor', 'met', 'op', 'niet', 'zijn'],
  pl: ['i', 'w', 'na', 'z', 'do', 'jest', 'nie', 'że', 'się', 'oraz', 'dla', 'od'],
  tr: ['ve', 'bir', 'bu', 'için', 'ile', 'da', 'de', 'olan', 'gibi', 'çok', 'daha'],
  vi: ['và', 'của', 'là', 'không', 'có', 'được', 'trong', 'cho', 'với', 'một', 'những'],
  id: ['dan', 'yang', 'untuk', 'dengan', 'adalah', 'ini', 'itu', 'dari', 'pada', 'tidak'],
};

function heuristicLang(text) {
  const s = String(text || '').toLowerCase();
  if (/[ăâđêôơư]/i.test(s)) return 'vi';
  if (/[ğışçöü]/i.test(s)) return 'tr';
  if (/[ąćęłńóśźż]/i.test(s)) return 'pl';
  if (/[äöüß]/.test(s)) return 'de';
  if (/[ãõ]/i.test(s)) return 'pt';
  if (/[ñ¿¡]/i.test(s)) return 'es';
  if (/œ/.test(s)) return 'fr';

  const words = s.match(/[a-zà-ÿ']+/g) || [];
  if (!words.length) return '';
  let best = '';
  let bestCount = 0;
  for (const lang of Object.keys(STOPWORDS)) {
    const set = new Set(STOPWORDS[lang]);
    let n = 0;
    for (const w of words) if (set.has(w)) n++;
    if (n > bestCount) {
      bestCount = n;
      best = lang;
    }
  }
  return bestCount >= 2 ? best : 'en';
}

async function googleDetect(text, opts) {
  const o = opts || {};
  const q = encodeURIComponent(String(text || '').slice(0, 1200));
  const url =
    'https://translate.google.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=' + q;
  const timeout = Number.isFinite(o.timeout) ? o.timeout : 10000;
  const retries = Number.isFinite(o.retries) ? o.retries : 1;
  const body = await requestRetry(url, { timeout }, retries);
  const data = JSON.parse(body);
  const code = Array.isArray(data) ? data[2] : '';
  return typeof code === 'string' ? code : '';
}

/**
 * 判断一段文字的语言，返回 BCP-47 风格代码（zh / ja / fr …）。
 * 先看文字脚本，再用 Google 检测，最后用常见词兜底。
 */
async function detectLanguage(text, opts) {
  const o = opts || {};
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return { lang: '', source: 'none' };

  const script = detectScriptLang(s);
  if (script) return { lang: script, source: 'script' };

  if (!o.localOnly) {
    try {
      const g = await googleDetect(s, o);
      const full = String(g || '').replace('_', '-');
      // 以前只认 LANGS 里的精确代码，Google 返回 zh-CN 时会掉到启发式并被误判成 en。
      // 现在按「精确代码 → 基础代码 → 原样保留」的顺序映射，未收录的语言也不会冒充英语。
      if (/^[a-z]{2,3}(-[A-Za-z]{2,8})?$/i.test(full)) {
        const b = baseLang(full);
        const lang = LANGS[full] ? full : LANGS[b] ? b : full;
        return { lang: lang, source: 'google' };
      }
    } catch (_) {
      /* 网络不可用时走本地判断 */
    }
  }

  return { lang: heuristicLang(s) || 'en', source: 'heuristic' };
}

async function detectPdfLanguage(file) {
  try {
    const pages = await extractPdfText(file);
    const text = pages.slice(0, 3).join(' ').slice(0, 4000);
    const d = await detectLanguage(text, { localOnly: true });
    return d.lang || 'en';
  } catch (_) {
    return 'en';
  }
}

/* ------------------------------------------------------------------ */
/* 任务管理（PDF 翻译 / 引擎安装）                                        */
/* ------------------------------------------------------------------ */

const jobs = new Map();
let jobSeq = 0;
let activePdfJob = null;
let activeInstallJob = null;

/** 所有由阅读器拉起的子进程（pdf2zh / uv / edge-tts），退出时统一清理 */
const activeChildren = new Set();

function trackChild(child) {
  if (!child) return child;
  activeChildren.add(child);
  const drop = () => activeChildren.delete(child);
  child.on('close', drop);
  child.on('error', drop);
  return child;
}

/** Windows 下 pdf2zh 可能再拉起子进程，用 taskkill /T 杀整棵进程树 */
function killChild(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32' && child.pid) {
      const tk = cp.spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        detached: false,
      });
      if (tk && tk.unref) tk.unref();
      return;
    }
  } catch (_) {
    /* 落到 child.kill */
  }
  try {
    child.kill();
  } catch (_) {
    /* ignore */
  }
}

function killAllChildren() {
  resetTtsWorker();
  for (const c of Array.from(activeChildren)) killChild(c);
  activeChildren.clear();
}

process.on('exit', () => {
  for (const c of activeChildren) {
    try {
      c.kill();
    } catch (_) {
      /* ignore */
    }
  }
});

function createJob(kind, meta) {
  const id = Date.now().toString(36) + '-' + (++jobSeq).toString(36);
  const job = {
    id,
    kind,
    status: 'running',
    progress: 0,
    log: [],
    error: '',
    meta: meta || {},
    startedAt: Date.now(),
    endedAt: 0,
    child: null,
  };
  jobs.set(id, job);
  // 只保留最近 20 个任务，避免内存增长
  if (jobs.size > 20) {
    const old = Array.from(jobs.values()).sort((a, b) => a.startedAt - b.startedAt);
    for (const j of old.slice(0, jobs.size - 20)) {
      if (j.status !== 'running') jobs.delete(j.id);
    }
  }
  return job;
}

function pushLog(job, chunk) {
  const text = String(chunk || '');
  for (const line of text.split(/\r\n|\n|\r/)) {
    if (!line.trim()) continue;
    job.log.push(line.slice(0, 500));
  }
  if (job.log.length > 300) job.log.splice(0, job.log.length - 300);
  const ms = text.match(/(\d{1,3})%/g);
  if (ms && ms.length) {
    const p = parseInt(ms[ms.length - 1], 10);
    if (Number.isFinite(p)) job.progress = Math.max(job.progress, Math.min(99, p));
  }
}

function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    progress: job.progress,
    error: job.error,
    log: job.log.slice(-120),
    meta: job.meta,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    elapsed: Math.round(((job.endedAt || Date.now()) - job.startedAt) / 1000),
  };
}

function getJob(id) {
  return publicJob(jobs.get(String(id || '')));
}

/* ------------------------------------------------------------------ */
/* PDF 翻译（pdf2zh）                                                   */
/* ------------------------------------------------------------------ */

function fileKey(file, service) {
  let st;
  try {
    st = fs.statSync(file);
  } catch (_) {
    return '';
  }
  return crypto
    .createHash('sha1')
    .update(
      [
        path.resolve(file),
        st.size,
        Math.round(st.mtimeMs),
        service,
        config.sourceLang,
        config.targetLang,
      ].join('|')
    )
    .digest('hex')
    .slice(0, 20);
}

function findOutputs(key) {
  const dir = path.join(PDF_CACHE_DIR, key);
  const out = { dual: '', mono: '', dir };
  let files = [];
  try {
    files = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  const all = [];
  for (const f of files) {
    const full = path.join(dir, f.name);
    if (f.isFile() && /\.pdf$/i.test(f.name)) all.push(full);
    else if (f.isDirectory()) {
      try {
        for (const g of fs.readdirSync(full)) {
          if (/\.pdf$/i.test(g)) all.push(path.join(full, g));
        }
      } catch (_) {
        /* ignore */
      }
    }
  }
  for (const p of all) {
    const base = path.basename(p).toLowerCase();
    if (/-dual\.pdf$/.test(base)) out.dual = p;
    else if (/-mono\.pdf$/.test(base)) out.mono = p;
  }
  return out;
}

function outputUrls(key) {
  const o = findOutputs(key);
  return {
    key,
    dual: o.dual ? '/api/pdf-result?key=' + encodeURIComponent(key) + '&kind=dual' : '',
    mono: o.mono ? '/api/pdf-result?key=' + encodeURIComponent(key) + '&kind=mono' : '',
  };
}

function getPdfFile(key, kind) {
  const k = String(key || '');
  if (!/^[a-f0-9]{8,40}$/i.test(k)) return '';
  const o = findOutputs(k);
  return kind === 'mono' ? o.mono : o.dual;
}

function pdfService() {
  const s = config.pdf.service || config.service;
  if (s === 'openai') return 'openai';
  if (s === 'google') return 'google';
  return 'bing';
}

/**
 * 按命令行规则切分 pdf.extraArgs：支持单/双引号、反斜杠转义。
 * 以前用 split(/\s+/) 会把 “D:\My Papers\font.ttf” 断成三个参数。
 */
function splitArgs(raw) {
  const out = [];
  let cur = '';
  let quote = '';
  const s = String(raw || '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    // Windows 路径里的反斜杠是普通字符，只有 \" 和 \\ 才是转义
    if (ch === '\\') {
      const next = s[i + 1];
      if (quote === '"' && (next === '"' || next === '\\')) {
        cur += next;
        i++;
        continue;
      }
      if (!quote && (next === '"' || next === "'")) {
        cur += next;
        i++;
        continue;
      }
      cur += '\\';
      continue;
    }
    if (quote) {
      if (ch === quote) quote = '';
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function cachedPdf(file) {
  const service = pdfService();
  const key = fileKey(file, service);
  if (!key) return null;
  const urls = outputUrls(key);
  if (!urls.dual && !urls.mono) return null;
  return urls;
}

/**
 * 某个 PDF 当前的翻译状态：正在跑的任务或已有缓存。
 * 页面刷新后用它把轮询接回来，而不是只知道“有任务在忙”。
 */
function currentPdfJob(file) {
  const key = fileKey(String(file || ''), pdfService());
  if (!key) return { job: null, output: null };
  if (activePdfJob && activePdfJob.status === 'running' && activePdfJob.meta.key === key) {
    return { job: publicJob(activePdfJob), output: outputUrls(key) };
  }
  const output = outputUrls(key);
  if (output.dual || output.mono) return { job: null, output: output };
  return { job: null, output: null };
}

function cancelPdfJob(id) {
  const job = activePdfJob;
  if (!job || job.status !== 'running') return publicJob(job);
  // 带 id 时只允许取消该任务：以前任意窗口点「取消」都会杀掉全局唯一任务，
  // 同时开两个 PDF 时会出现「取消 A 结果 B 停了」。
  if (id && String(id) !== String(job.id)) return publicJob(job);
  job.status = 'error';
  job.error = '已取消翻译';
  job.log.push('用户取消了翻译，正在终止 pdf2zh');
  job.endedAt = Date.now();
  if (job.child) killChild(job.child);
  activePdfJob = null;
  return publicJob(job);
}

/* ------------------------------------------------------------------ */
/* 缓存清理                                                             */
/* ------------------------------------------------------------------ */

const CACHE_LIMITS = {
  ttsDays: 30,
  ttsBytes: 500 * 1024 * 1024,
  pdfDays: 90,
  pdfBytes: 2 * 1024 * 1024 * 1024,
};

async function removePath(full) {
  try {
    await fs.promises.rm(full, { recursive: true, force: true });
  } catch (_) {
    /* 文件被占用时下次启动再清 */
  }
}

async function entrySize(full, isDir) {
  if (!isDir) {
    try {
      return (await fs.promises.stat(full)).size;
    } catch (_) {
      return 0;
    }
  }
  let total = 0;
  let items = [];
  try {
    items = await fs.promises.readdir(full, { withFileTypes: true });
  } catch (_) {
    return 0;
  }
  for (const it of items) {
    total += await entrySize(path.join(full, it.name), it.isDirectory());
  }
  return total;
}

/** 按「过期时间 + 总容量」清理一个缓存目录；超容量时从最旧的开始删 */
async function pruneCacheDir(dir, opts) {
  let entries = [];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (_) {
    return;
  }
  const now = Date.now();
  const ageMs = opts.days * 24 * 60 * 60 * 1000;
  const items = [];

  for (const d of entries) {
    if (opts.dirsOnly && !d.isDirectory()) continue;
    if (!opts.dirsOnly && !d.isFile()) continue;
    // 正在写入的翻译任务目录不能清
    if (activePdfJob && activePdfJob.status === 'running' && activePdfJob.meta.key === d.name) continue;
    const full = path.join(dir, d.name);
    let st;
    try {
      st = await fs.promises.stat(full);
    } catch (_) {
      continue;
    }
    if (now - st.mtimeMs > ageMs) {
      await removePath(full);
      continue;
    }
    items.push({ full, mtime: st.mtimeMs, size: opts.dirsOnly ? await entrySize(full, true) : st.size });
  }

  let total = items.reduce((n, it) => n + it.size, 0);
  if (total <= opts.bytes) return;
  items.sort((a, b) => a.mtime - b.mtime);
  for (const it of items) {
    if (total <= opts.bytes) break;
    await removePath(it.full);
    total -= it.size;
  }
}

/** 启动后延迟执行，避免和首屏抢 I/O */
function scheduleCachePrune() {
  const timer = setTimeout(() => {
    pruneCacheDir(TTS_CACHE_DIR, { days: CACHE_LIMITS.ttsDays, bytes: CACHE_LIMITS.ttsBytes, dirsOnly: false });
    pruneCacheDir(PDF_CACHE_DIR, { days: CACHE_LIMITS.pdfDays, bytes: CACHE_LIMITS.pdfBytes, dirsOnly: true });
  }, 4000);
  if (timer.unref) timer.unref();
}

scheduleCachePrune();

async function startPdfTranslate(file) {
  const p = String(file || '');
  if (!p) throw Object.assign(new Error('缺少文件路径'), { code: 'bad-request' });
  let st;
  try {
    st = fs.statSync(p);
  } catch (_) {
    throw Object.assign(new Error('文件不存在：' + p), { code: 'bad-request' });
  }
  if (!st.isFile() || !/\.pdf$/i.test(p)) {
    throw Object.assign(new Error('只能翻译 PDF 文件'), { code: 'bad-request' });
  }

  const exe = findPdf2zh();
  if (!exe) {
    throw Object.assign(new Error('PDF 翻译引擎尚未安装'), { code: 'engine-missing' });
  }

  const service = pdfService();
  const key = fileKey(p, service);
  const cached = outputUrls(key);
  if (cached.dual || cached.mono) {
    const job = createJob('pdf', { file: p, key, service, cached: true });
    job.status = 'done';
    job.progress = 100;
    job.endedAt = Date.now();
    job.log.push('使用已有缓存');
    return { job: publicJob(job), output: cached, cached: true };
  }

  if (activePdfJob && activePdfJob.status === 'running') {
    if (activePdfJob.meta.key === key) {
      return { job: publicJob(activePdfJob), output: outputUrls(key) };
    }
    throw Object.assign(new Error('已有 PDF 正在翻译，请等它完成'), {
      code: 'busy',
      job: publicJob(activePdfJob),
    });
  }

  const outDir = path.join(PDF_CACHE_DIR, key);
  ensureDir(outDir);

  // 先占位再 await：语言检测可能耗时几秒，两个并发请求以前都能通过
  // busy 检查，各自 spawn 一个 pdf2zh 往同一个缓存目录里写
  const job = createJob('pdf', { file: p, key, service });
  activePdfJob = job;
  job.log.push('引擎：' + exe);

  let source = config.sourceLang;
  if (!source || source === 'auto') source = await detectPdfLanguage(p);
  const sourceCode = pdfLangCode(source);
  const targetCode = pdfLangCode(config.targetLang);
  job.meta.source = sourceCode;
  job.meta.target = targetCode;
  job.log.push('语言：' + sourceCode + ' → ' + targetCode);
  job.log.push(
    '服务：' +
      (service === 'google'
        ? 'Google 免费翻译'
        : service === 'bing'
          ? 'Bing 免费翻译'
          : 'OpenAI 兼容接口')
  );
  // 检测期间可能已被取消/应用退出
  if (job.status !== 'running') {
    return { job: publicJob(job), output: outputUrls(key) };
  }

  const args = [
    p,
    '-o',
    outDir,
    '-li',
    sourceCode,
    '-lo',
    targetCode,
    '-s',
    service,
  ];
  if (config.pdf.extraArgs) {
    for (const a of splitArgs(config.pdf.extraArgs)) {
      if (a) args.push(a);
    }
  }

  const env = Object.assign({}, process.env, {
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    HF_ENDPOINT: config.hfEndpoint || 'https://hf-mirror.com',
  });
  if (service === 'openai') {
    env.OPENAI_BASE_URL = config.openai.baseUrl || 'https://api.deepseek.com/v1';
    env.OPENAI_API_KEY = config.openai.apiKey || '';
    env.OPENAI_MODEL = config.openai.model || 'deepseek-chat';
  }

  let child;
  try {
    child = cp.spawn(exe, args, { cwd: outDir, env, windowsHide: true });
  } catch (e) {
    job.status = 'error';
    job.error = e.message;
    job.endedAt = Date.now();
    activePdfJob = null;
    return { job: publicJob(job), output: outputUrls(key) };
  }
  job.child = trackChild(child);

  child.stdout.on('data', (d) => pushLog(job, d.toString()));
  child.stderr.on('data', (d) => pushLog(job, d.toString()));

  const timer = setTimeout(() => {
    if (job.status !== 'running') return;
    job.log.push('翻译超时（45 分钟），已终止');
    killChild(child);
  }, 45 * 60 * 1000);
  if (timer.unref) timer.unref();

  child.on('error', (e) => {
    clearTimeout(timer);
    job.status = 'error';
    job.error = '启动 pdf2zh 失败：' + e.message;
    job.endedAt = Date.now();
    activePdfJob = null;
  });

  child.on('close', (code) => {
    clearTimeout(timer);
    if (job.status === 'error') return;
    const urls = outputUrls(key);
    if (urls.dual || urls.mono) {
      job.status = 'done';
      job.progress = 100;
      job.log.push('翻译完成');
    } else {
      job.status = 'error';
      const tail = job.log.slice(-8).join('\n');
      job.error =
        code === 0
          ? 'pdf2zh 结束了，但没有找到输出 PDF。\n' + tail
          : 'pdf2zh 退出码 ' + code + '\n' + tail;
    }
    job.endedAt = Date.now();
    activePdfJob = null;
  });

  return { job: publicJob(job), output: outputUrls(key) };
}

/* ------------------------------------------------------------------ */
/* 引擎安装（uv tool install pdf2zh）                                    */
/* ------------------------------------------------------------------ */

function startInstall() {
  if (activeInstallJob && activeInstallJob.status === 'running') {
    return { job: publicJob(activeInstallJob) };
  }
  const uv = findUv();
  if (!uv) {
    throw Object.assign(
      new Error('没有找到 uv。请先安装 uv（https://docs.astral.sh/uv/），再点安装。'),
      { code: 'uv-missing' }
    );
  }

  const job = createJob('install', { uv });
  activeInstallJob = job;
  job.log.push('使用 uv：' + uv);

  const env = Object.assign({}, process.env, {
    UV_DEFAULT_INDEX: config.install.indexUrl || 'https://pypi.tuna.tsinghua.edu.cn/simple',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  });

  // pdf2zh 的两个依赖没有锁版本，最新版会破坏导入（2026-11 实测）：
  //   tencentcloud-sdk-python-tmt 3.1+ 删掉了 TextTranslateRequest
  //   bitstring 5.x 删掉了 BitStream
  // 所以装完 pdf2zh 后再把这两个钉回可用版本。
  const steps = [
    { label: '安装 pdf2zh', args: ['tool', 'install', '--python', '3.12', '--force', 'pdf2zh'] },
  ];
  // 第一步装完后这个解释器才会存在，所以路径现在就拼好、步骤照常排进去
  steps.push({
    label: '修正依赖版本',
    args: [
      'pip',
      'install',
      '--python',
      toolPythonPath(),
      'tencentcloud-sdk-python-tmt<3.1',
      'bitstring<4.2',
    ],
  });
  // 语音引擎装失败不影响 PDF 翻译，前端会自动退回浏览器朗读
  steps.push({
    label: '安装语音引擎 edge-tts',
    args: ['tool', 'install', '--python', '3.12', '--force', 'edge-tts'],
    optional: true,
  });

  const timer = setTimeout(() => {
    if (job.status !== 'running') return;
    job.log.push('安装超时（20 分钟），已终止');
    killChild(job.child);
  }, 20 * 60 * 1000);
  if (timer.unref) timer.unref();

  function finish() {
    clearTimeout(timer);
    invalidateToolCache();
    brokenWorkerPythons.clear();
    workerPreReadyFailures.clear();
    const engine = engineInfo();
    if (engine.available) {
      job.status = 'done';
      job.progress = 100;
      job.log.push('安装完成：' + engine.path);
      if (engine.tts && engine.tts.available) warmTtsWorker();
    } else {
      job.status = 'error';
      job.error = '安装结束，但仍未找到 pdf2zh\n' + job.log.slice(-8).join('\n');
    }
    job.endedAt = Date.now();
    activeInstallJob = null;
  }

  function fail(msg) {
    clearTimeout(timer);
    invalidateToolCache();
    job.status = 'error';
    job.error = msg + '\n' + job.log.slice(-8).join('\n');
    job.endedAt = Date.now();
    activeInstallJob = null;
  }

  function runStep(idx) {
    if (idx >= steps.length) {
      finish();
      return;
    }
    const step = steps[idx];
    job.log.push('> uv ' + step.args.join(' '));
    let child;
    try {
      child = cp.spawn(uv, step.args, { env, windowsHide: true });
    } catch (e) {
      fail('启动 uv 失败：' + e.message);
      return;
    }
    job.child = trackChild(child);
    child.stdout.on('data', (d) => pushLog(job, d.toString()));
    child.stderr.on('data', (d) => pushLog(job, d.toString()));
    child.on('error', (e) => fail(step.label + '失败：' + e.message));
    child.on('close', (code) => {
      if (job.status !== 'running') return;
      if (code !== 0) {
        if (step.optional) {
          job.log.push('（可跳过）' + step.label + '失败，语音会自动退回浏览器朗读');
          runStep(idx + 1);
          return;
        }
        fail(step.label + '失败（退出码 ' + code + '）');
        return;
      }
      runStep(idx + 1);
    });
  }

  runStep(0);
  return { job: publicJob(job) };
}

module.exports = {
  APP_DIR,
  PDF_CACHE_DIR,
  TTS_CACHE_DIR,
  publicConfig,
  updateConfig,
  status,
  translateTexts,
  dictLookup,
  synthesizeSpeech,
  streamSpeech,
  warmTtsWorker,
  pickVoice,
  extractPdfText,
  detectLanguage,
  detectPdfLanguage,
  startPdfTranslate,
  cachedPdf,
  currentPdfJob,
  cancelPdfJob,
  killAllChildren,
  outputUrls,
  getPdfFile,
  getJob,
  startInstall,
  engineInfo,
  findUv,
  findPdf2zh,
  findEdgeTts,
  findEdgeTtsPython,
  invalidateToolCache,
};

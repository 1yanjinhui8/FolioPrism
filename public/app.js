/* ==========================================================================
   FolioPrism（棱阅）—— 前端逻辑
   职责：把 Markdown 当文章渲染，图片与视频真实显示出来。
   ========================================================================== */

(function () {
  'use strict';

  /* ------------------------------------------------------------ 基础工具 */

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escapeAttr(s) { return escapeHtml(s); }

  const formats = window.FolioFormats;
  if (!formats) {
    throw new Error('FolioFormats 未加载：请确认 public/formats.js 已在 public/app.js 之前引入');
  }

  function extOf(p) {
    return formats.extOf(p);
  }
  function baseName(p) {
    return formats.baseNameOf(p);
  }
  function dirOf(p) {
    return formats.dirOf(p);
  }
  function kindOf(p) {
    return formats.kindOf(p);
  }
  function joinPath(dir, name) {
    return String(dir).replace(/[\\/]+$/, '') + '\\' + name;
  }

  const IMAGE_EXT = formats.IMAGE_EXT;
  const VIDEO_EXT = formats.VIDEO_EXT;
  const AUDIO_EXT = formats.AUDIO_EXT;
  const DOCX_EXT = formats.DOCX_EXT;
  const SHEET_EXT = formats.SHEET_EXT;
  const TEXT_EXT = formats.TEXT_EXT;

  /* ------------------------------------------------------------ 第三方库 */

  const lib = { marked: null, hljs: null, mammoth: null, XLSX: null, dompurify: null };

  const LIB_LABEL = {
    marked: 'Markdown 渲染',
    hljs: '代码高亮',
    mammoth: 'Word 解析',
    XLSX: 'Excel 解析',
    dompurify: 'HTML 消毒'
  };

  function grabLib(name) {
    if (name === 'marked') return window.marked || null;
    if (name === 'hljs') return window.hljs || null;
    if (name === 'mammoth') return window.mammoth || null;
    if (name === 'XLSX') return window.XLSX || null;
    if (name === 'dompurify') return window.DOMPurify || null;
    return null;
  }

  /**
   * 只认本地 vendor 里的库。
   *
   * 以前本地缺失时会去 cdn.jsdelivr.net 拉一份：既扩大供应链攻击面，
   * 又会在断网/CDN 卡住时让页面永远停在「正在载入…」。现在缺库直接报错，
   * 并提示运行 npm run setup（prepare-vendor.js 会补齐 vendor）。
   */
  async function ensureLib(names) {
    const missing = [];
    for (const n of names) {
      if (!lib[n]) lib[n] = grabLib(n);
      if (!lib[n]) missing.push(LIB_LABEL[n] || n);
    }
    if (missing.length) {
      throw new Error(
        '本地渲染库缺失（' + missing.join('、') + '）。请运行 npm run setup 后重启，' +
        '不要从 CDN 加载脚本。'
      );
    }
  }

  /* ------------------------------------------------------------ HTML 消毒 */

  /**
   * Markdown 允许内嵌原始 HTML，而 marked 从 v5 起不再消毒：
   * 一篇下载来的论文里写 <img onerror="..."> 就能在阅读器页面里执行脚本，
   * 进而同源读取任意本地文件和 API Key。所以进入 #content 之前必须过白名单。
   *
   * 优先用 DOMPurify（vendor/purify.min.js）；它没加载成功时退回下面的
   * 白名单实现，绝不允许“消毒失败就直接 innerHTML”。
   */
  const SAFE_TAGS = new Set([
    'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'cite', 'code', 'dd', 'del', 'details',
    'dfn', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'samp', 'small',
    'span', 'strike', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th',
    'thead', 'time', 'tr', 'u', 'ul', 'var', 'wbr'
  ]);

  // 不放行 id：Markdown 里的 id 可能和 #content/#toast 等应用元素重名，
  // 属于 DOM clobbering；正文锚点本来由 buildToc 在消毒之后生成
  const SAFE_ATTR = [
    'href', 'src', 'alt', 'title', 'class', 'colspan', 'rowspan', 'start', 'reversed',
    'type', 'checked', 'disabled', 'align', 'lang', 'dir', 'scope'
  ];

  const DROP_TAGS = new Set([
    'script', 'style', 'iframe', 'object', 'embed', 'form', 'textarea', 'select', 'button',
    'link', 'meta', 'base', 'svg', 'math', 'template', 'noscript', 'video', 'audio', 'source',
    'track', 'canvas', 'frame', 'frameset', 'applet', 'marquee'
  ]);

  const PURIFY_CFG = {
    ALLOWED_TAGS: Array.from(SAFE_TAGS).concat(['input']),
    ALLOWED_ATTR: SAFE_ATTR,
    FORBID_ATTR: ['style', 'srcset', 'formaction', 'xlink:href'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    KEEP_CONTENT: true
  };

  /** 只放行 http/https/mailto/tel、相对地址，以及位图 data URI */
  function sanitizeUrl(value, isImage) {
    const raw = String(value || '');
    const compact = raw.replace(/[\u0000- \u007f]+/g, '');
    if (!compact) return '';
    const m = /^([a-z][a-z0-9+.-]*):/i.exec(compact);
    if (!m) return raw;
    const scheme = m[1].toLowerCase();
    if (scheme === 'http' || scheme === 'https' || scheme === 'mailto' || scheme === 'tel') return raw;
    if (isImage && /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(compact)) return raw;
    return '';
  }

  function copyClean(src, dst) {
    Array.prototype.forEach.call(src.childNodes, (node) => {
      if (node.nodeType === 3) {
        dst.appendChild(document.createTextNode(node.nodeValue));
        return;
      }
      if (node.nodeType !== 1) return;

      const tag = String(node.localName || '').toLowerCase();
      if (DROP_TAGS.has(tag)) return;

      if (tag === 'input') {
        // GFM 任务列表只允许复选框，其他 input 一律丢掉
        if (String(node.getAttribute('type') || '').toLowerCase() !== 'checkbox') return;
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.disabled = true;
        if (node.hasAttribute('checked')) box.checked = true;
        dst.appendChild(box);
        return;
      }

      if (!SAFE_TAGS.has(tag)) {
        // 未知标签只保留内容（SVG/MathML 等已在上面整段丢掉）
        copyClean(node, dst);
        return;
      }

      const el = document.createElement(tag);
      Array.prototype.forEach.call(node.attributes, (attr) => {
        const name = String(attr.name || '').toLowerCase();
        if (SAFE_ATTR.indexOf(name) < 0) return;

        const val = String(attr.value || '');
        if (name === 'href' || name === 'src') {
          const safe = sanitizeUrl(val, tag === 'img');
          if (safe) el.setAttribute(name, safe);
        } else if (name === 'class') {
          const cls = val
            .split(/\s+/)
            .filter((c) =>
              /^(language-[\w+#.-]+|task-list-item|contains-task-list|footnotes?|footnote-ref|footnote-backref|hljs|hljs-[\w-]+)$/.test(c)
            )
            .join(' ');
          if (cls) el.className = cls;
        } else {
          el.setAttribute(name, val);
        }
      });
      copyClean(node, el);
      dst.appendChild(el);
    });
  }

  function basicSanitize(html) {
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    const out = document.createElement('div');
    if (doc.body) copyClean(doc.body, out);
    return out.innerHTML;
  }

  function sanitizeHtml(html) {
    if (window.DOMPurify && typeof window.DOMPurify.sanitize === 'function') {
      try {
        return window.DOMPurify.sanitize(String(html || ''), PURIFY_CFG);
      } catch (_) {
        /* 落到白名单实现 */
      }
    }
    return basicSanitize(html);
  }

  /* ------------------------------------------------------------ 状态 */

  const state = {
    config: null,
    root: null,
    currentFile: null,
    tocLinks: [],
    lightboxItems: [],
    lightboxIndex: 0,
    scale: 1,
    tx: 0,
    ty: 0,
    translatable: false,
    docLang: '',
    activeBlobUrl: '',
    activeBlobUrls: [],
    isWebLocalFile: false,
    systemTextScale: 1,
    pdfZoom: 100,
    onPdfZoomChanged: null,
    onPdfConfigChanged: null
  };

  const LS = {
    theme: 'media-reader/theme',
    font: 'media-reader/font',
    pdfZoom: 'media-reader/pdfZoom',
    wide: 'media-reader/wide',
    tocOff: 'media-reader/tocOff',
    lastRoot: 'media-reader/lastRoot',
    lastFile: 'media-reader/lastFile',
    scroll: 'media-reader/scroll',
    bilingual: 'media-reader/bilingualMode',
    continueFiles: 'media-reader/continueFiles',
    video: 'media-reader/videoProgress'
  };

  /** 每次 openFile 自增；异步渲染回来时用它判断自己是否已经过期 */
  let openSeq = 0;

  function registerBlobUrl(url) {
    if (url) state.activeBlobUrls.push(url);
    return url;
  }

  function revokeActiveBlobUrl() {
    if (state.activeBlobUrl) {
      try {
        if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
          URL.revokeObjectURL(state.activeBlobUrl);
        }
      } catch (_) { /* ignore */ }
      state.activeBlobUrl = '';
    }
    if (state.activeBlobUrls.length) {
      for (const u of state.activeBlobUrls) {
        try {
          if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
            URL.revokeObjectURL(u);
          }
        } catch (_) { /* ignore */ }
      }
      state.activeBlobUrls.length = 0;
    }
  }

  function cleanupActiveMedia() {
    $$('#content video, #content audio').forEach((m) => {
      try {
        if (typeof m.pause === 'function') m.pause();
        m.removeAttribute('src');
        if (typeof m.load === 'function') m.load();
      } catch (_) { /* ignore */ }
    });
    revokeActiveBlobUrl();
  }

  /* ---------------------------------------------------- 阅读位置记忆 / 相对路径 */

  const SCROLL_MAX_FILES = 200;

  function readScrollMap() {
    try {
      const m = JSON.parse(localStorage.getItem(LS.scroll) || '{}');
      return m && typeof m === 'object' ? m : {};
    } catch (_) {
      return {};
    }
  }

  /** 记下某个文件读到的位置（用比例，字号/窗口变化后仍然对得上） */
  function saveScroll(filePath) {
    if (!filePath) return;
    const doc = document.documentElement;
    const max = doc.scrollHeight - doc.clientHeight;
    const ratio = max > 0 ? Math.min(1, Math.max(0, (window.scrollY || 0) / max)) : 0;
    const map = readScrollMap();
    map[filePath] = Math.round(ratio * 1000) / 1000;
    const keys = Object.keys(map);
    if (keys.length > SCROLL_MAX_FILES) {
      // 只保留最近写入的一些，避免 localStorage 无限增长
      keys.slice(0, keys.length - SCROLL_MAX_FILES).forEach((k) => { delete map[k]; });
    }
    try { localStorage.setItem(LS.scroll, JSON.stringify(map)); } catch (_) { /* ignore */ }
    touchContinue(filePath, map[filePath]);
  }

  function restoreScroll(filePath) {
    let ratio = null;
    if (filePath) {
      const v = readScrollMap()[filePath];
      if (typeof v === 'number' && v > 0) ratio = v;
    }
    // 页面全局开了 scroll-behavior: smooth，恢复位置必须用 instant，
    // 否则会从顶部慢慢滚过去，看起来像「没恢复」
    if (ratio == null) {
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
      updateProgress();
      return 0;
    }
    const doc = document.documentElement;
    const max = doc.scrollHeight - doc.clientHeight;
    const top = Math.round(ratio * Math.max(0, max));
    window.scrollTo({ top, left: 0, behavior: 'instant' });
    updateProgress();
    return top;
  }

  /** 把 Markdown 里的相对链接解析成磁盘绝对路径（Windows 路径） */
  function resolveRelative(baseFile, ref) {
    let p = String(ref || '').replace(/\\/g, '/');
    try { p = decodeURIComponent(p); } catch (_) { /* 保留原样 */ }
    const base = dirOf(baseFile).replace(/\\/g, '/');
    const abs = p.charAt(0) === '/' ? p : base + '/' + p;
    const out = [];
    abs.split('/').forEach((seg) => {
      if (!seg || seg === '.') return;
      if (seg === '..') {
        if (out.length > 1) out.pop();
        return;
      }
      out.push(seg);
    });
    return out.join('\\');
  }

  const FONT_STEPS = [16, 17, 18, 20, 22];
  const PDF_ZOOM_STEPS = [75, 90, 100, 115, 130, 150, 175, 200];

  /** 支持的原文/译文语言（与 translator.js 保持一致） */
  const LANGS = [
    { code: 'zh-CN', name: '简体中文' },
    { code: 'zh-TW', name: '繁體中文' },
    { code: 'en', name: 'English' },
    { code: 'ja', name: '日本語' },
    { code: 'ko', name: '한국어' },
    { code: 'fr', name: 'Français' },
    { code: 'de', name: 'Deutsch' },
    { code: 'es', name: 'Español' },
    { code: 'pt', name: 'Português' },
    { code: 'ru', name: 'Русский' },
    { code: 'it', name: 'Italiano' },
    { code: 'ar', name: 'العربية' },
    { code: 'hi', name: 'हिन्दी' },
    { code: 'th', name: 'ไทย' },
    { code: 'vi', name: 'Tiếng Việt' },
    { code: 'id', name: 'Bahasa Indonesia' },
    { code: 'tr', name: 'Türkçe' },
    { code: 'nl', name: 'Nederlands' },
    { code: 'pl', name: 'Polski' }
  ];

  const VOICE_BY_LANG = {
    'zh-CN': 'zh-CN-XiaoxiaoNeural',
    'zh-TW': 'zh-TW-HsiaoChenNeural',
    en: 'en-US-AriaNeural',
    ja: 'ja-JP-NanamiNeural',
    ko: 'ko-KR-SunHiNeural',
    fr: 'fr-FR-DeniseNeural',
    de: 'de-DE-TanjaNeural',
    es: 'es-ES-ElviraNeural',
    pt: 'pt-BR-FranciscaNeural',
    ru: 'ru-RU-SvetlanaNeural',
    it: 'it-IT-ElsaNeural',
    ar: 'ar-SA-ZariyahNeural',
    hi: 'hi-IN-SwaraNeural',
    th: 'th-TH-PremwadeeNeural',
    vi: 'vi-VN-HoaiMyNeural',
    id: 'id-ID-GadisNeural',
    tr: 'tr-TR-EmelNeural',
    nl: 'nl-NL-ColetteNeural',
    pl: 'pl-PL-ZofiaNeural'
  };

  /* ------------------------------------------------------------ toast */

  function toast(msg, kind) {
    const box = $('#toast');
    const t = document.createElement('div');
    t.className = 'toast-item' + (kind ? ' ' + kind : '');
    t.textContent = msg;
    box.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 2400);
    setTimeout(() => t.remove(), 2800);
  }

  /* ------------------------------------------------------------ API */

  function buildUrl(pathname, params) {
    const u = new URL(pathname, location.origin);
    if (params) {
      Object.keys(params).forEach((k) => {
        if (params[k] !== undefined && params[k] !== null) u.searchParams.set(k, params[k]);
      });
    }
    return u;
  }

  async function api(pathname, params) {
    const u = buildUrl(pathname, params);
    let res;
    try {
      res = await fetch(u.toString());
    } catch (e) {
      const err = new Error('网络请求失败：' + e.message);
      err.requestUrl = u.toString();
      throw err;
    }
    if (!res.ok) {
      let data = null;
      let detail = '';
      try {
        data = await res.json();
        detail = JSON.stringify(data);
      } catch (_) { /* ignore */ }
      const err = new Error(
        (data && data.error) ? data.error : ('HTTP ' + res.status + (detail ? ' ' + detail : ''))
      );
      err.status = res.status;
      err.code = (data && data.code) || '';
      err.data = data;
      err.requestUrl = u.toString();
      throw err;
    }
    return res.json();
  }

  async function apiPost(pathname, body) {
    const u = buildUrl(pathname);
    let res;
    try {
      res = await fetch(u.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
      });
    } catch (e) {
      const err = new Error('网络请求失败：' + e.message);
      err.requestUrl = u.toString();
      throw err;
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
    if (!res.ok) {
      const err = new Error((data && data.error) || 'HTTP ' + res.status);
      err.status = res.status;
      err.data = data;
      err.requestUrl = u.toString();
      throw err;
    }
    return data;
  }

  function rawUrl(filePath) {
    return buildUrl('/api/raw', { path: filePath }).toString();
  }

  /** 图片/视频解析：把 Markdown 里的相对路径交给服务端翻译成磁盘绝对路径 */
  function assetUrl(filePath, ref) {
    const u = buildUrl('/api/asset', { file: filePath, ref: ref });
    return u.pathname + u.search;
  }

  /* ==========================================================================
     目录状态同步
     ========================================================================== */

  function syncRootState(dir) {
    if (!dir) return;
    state.root = dir;
    try { localStorage.setItem(LS.lastRoot, dir); } catch (_) { /* ignore */ }
    if (window.readerNative && typeof window.readerNative.setCurrentRoot === 'function') {
      try { window.readerNative.setCurrentRoot(dir); } catch (_) { /* ignore */ }
    }
  }

  /* ---------------------------------------------------- 继续阅读（最近文件 + 进度） */

  const CONTINUE_MAX = 8;

  function readContinue() {
    try {
      const list = JSON.parse(localStorage.getItem(LS.continueFiles) || '[]');
      return Array.isArray(list) ? list.filter((x) => x && x.path) : [];
    } catch (_) {
      return [];
    }
  }

  function writeContinue(list) {
    try { localStorage.setItem(LS.continueFiles, JSON.stringify(list)); } catch (_) { /* ignore */ }
  }

  /** 打开或更新一个文件在“继续阅读”里的记录；ratio 是 0~1 的滚动比例 */
  function touchContinue(filePath, ratio) {
    if (!filePath) return;
    const list = readContinue();
    const i = list.findIndex((x) => x.path === filePath);
    const rec = i >= 0 ? list.splice(i, 1)[0] : { path: filePath, at: 0, ratio: 0 };
    if (typeof ratio === 'number' && Number.isFinite(ratio)) rec.ratio = ratio;
    rec.at = Date.now();
    list.unshift(rec);
    writeContinue(list.slice(0, CONTINUE_MAX));
    renderContinue();
  }

  function renderContinue() {
    const box = $('#continue');
    if (!box) return;
    box.innerHTML = '';
    const list = readContinue().slice(0, 4);
    if (!list.length) return;

    const label = document.createElement('div');
    label.className = 'side-title side-title-pad';
    label.textContent = '继续阅读';
    box.appendChild(label);

    list.forEach((rec) => {
      const b = document.createElement('button');
      b.className = 'continue-item';
      b.title = rec.path;

      const name = document.createElement('span');
      name.className = 'continue-name';
      name.textContent = baseName(rec.path);

      const pct = document.createElement('span');
      pct.className = 'continue-pct';
      pct.textContent = rec.ratio > 0.005 ? Math.round(rec.ratio * 100) + '%' : '未读';

      b.appendChild(name);
      b.appendChild(pct);
      b.addEventListener('click', () => openContinuePath(rec.path));
      box.appendChild(b);
    });
  }

  async function openContinuePath(p) {
    syncRootState(dirOf(p));
    return openFile(p);
  }

  /* ---------------------------------------------------- 视频续播 */

  const videoSavedAt = new WeakMap();

  function readVideoMap() {
    try {
      const m = JSON.parse(localStorage.getItem(LS.video) || '{}');
      return m && typeof m === 'object' ? m : {};
    } catch (_) {
      return {};
    }
  }

  function videoKey(el) {
    const raw = String(el.currentSrc || el.src || '');
    // 端口每次启动可能不同，用 pathname+query（含 path=...）作为稳定键
    try {
      const u = new URL(raw);
      return u.pathname + u.search;
    } catch (_) {
      return raw;
    }
  }

  function saveVideoTime(video) {
    const key = videoKey(video);
    const t = video.currentTime;
    if (!key || !Number.isFinite(t) || t < 1) return;
    const map = readVideoMap();
    map[key] = { t: Math.round(t), at: Date.now() };
    const keys = Object.keys(map);
    if (keys.length > 300) {
      keys
        .sort((a, b) => (map[a].at || 0) - (map[b].at || 0))
        .slice(0, keys.length - 300)
        .forEach((k) => { delete map[k]; });
    }
    try { localStorage.setItem(LS.video, JSON.stringify(map)); } catch (_) { /* ignore */ }
  }

  /**
   * 视频是 innerHTML 动态生成的，逐个挂事件很麻烦；这里用捕获阶段统一处理。
   * error 不冒泡但能被捕获，正好用来替代“黑屏没提示”。
   */
  function initVideoProgress() {
    document.addEventListener('loadedmetadata', (e) => {
      const v = e.target;
      if (!v || v.tagName !== 'VIDEO') return;
      const rec = readVideoMap()[videoKey(v)];
      if (
        rec && typeof rec.t === 'number' && rec.t > 2 &&
        Number.isFinite(v.duration) && rec.t < v.duration - 3
      ) {
        try { v.currentTime = rec.t; } catch (_) { /* ignore */ }
      }
    }, true);

    document.addEventListener('timeupdate', (e) => {
      const v = e.target;
      if (!v || v.tagName !== 'VIDEO') return;
      const now = Date.now();
      if (now - (videoSavedAt.get(v) || 0) < 5000) return;
      videoSavedAt.set(v, now);
      saveVideoTime(v);
    }, true);

    const flush = (e) => {
      const v = e.target;
      if (!v || v.tagName !== 'VIDEO') return;
      saveVideoTime(v);
    };
    document.addEventListener('pause', flush, true);
    document.addEventListener('ended', flush, true);

    document.addEventListener('error', (e) => {
      const v = e.target;
      if (!v) return;
      if (v.tagName === 'VIDEO') {
        const frame = v.closest('.video-frame');
        if (!frame || frame.querySelector('.media-error')) return;
        const box = document.createElement('div');
        box.className = 'media-error';
        box.textContent = '视频无法播放：文件可能损坏，或编码不受支持（可尝试转码为 H.264 MP4）。';
        frame.appendChild(box);
      } else if (v.tagName === 'AUDIO') {
        const frame = v.closest('.audio-frame');
        if (!frame || frame.querySelector('.media-error')) return;
        const box = document.createElement('div');
        box.className = 'media-error';
        box.textContent = '音频无法播放：文件可能损坏，或编码不受当前浏览器支持。';
        frame.appendChild(box);
      }
    }, true);
  }

  /* ==========================================================================
     需求 2：按扩展名分流渲染（含 Web 模式本地 File API 预览）
     ========================================================================== */

  /**
   * 打开一个「外部送进来的」绝对路径：双击关联、菜单「打开文件」、拖拽都是这条。
   * 同步其所在目录供原生对话框续用，再走正常渲染流程。
   */
  function openPath(filePath) {
    const p = String(filePath || '').trim();
    if (!p) return Promise.resolve(false);
    const dir = dirOf(p);
    if (dir && dir !== state.root) {
      syncRootState(dir);
    }
    return openFile(p);
  }

  async function openFile(filePath) {
    // 快速连点两个文件时，只允许最后那次渲染结果落地；否则慢请求会把
    // 新文件的内容/state 覆盖掉，出现正文和面包屑串台
    const seq = ++openSeq;
    // 切换文件前先记住上一个文件读到哪，回来时直接落回原处
    if (state.currentFile && !state.isWebLocalFile && state.currentFile !== filePath) {
      saveScroll(state.currentFile);
    }
    stopTts();
    resetBilingual();
    cleanupActiveMedia();
    document.body.classList.remove('pdf-view');
    state.onPdfZoomChanged = null;
    state.onPdfConfigChanged = null;
    state.translatable = false;
    state.docLang = '';
    state.isWebLocalFile = false;
    state.currentFile = filePath;
    setCrumb(filePath);
    syncRootState(dirOf(filePath));
    touchContinue(filePath);
    clearFind(true);
    document.body.classList.remove('sidebar-open');

    window.__reader.ready = false;
    window.__reader.stats = null;

    const c = $('#content');
    c.innerHTML = '<div class="welcome"><h1>正在载入…</h1></div>';

    const ext = extOf(filePath);
    const kind = kindOf(filePath);
    let ok = true;
    try {
      if (kind === 'markdown') {
        await renderMarkdown(filePath, seq);
      } else if (kind === 'html') {
        await renderHtml(filePath, seq);
      } else if (kind === 'docx') {
        await renderDocx(filePath, seq);
      } else if (kind === 'sheet') {
        await renderSheet(filePath, seq);
      } else if (kind === 'pptx') {
        renderUnsupported(filePath, 'PPT 暂不支持内联预览', 'PPTX 是二进制压缩包格式，浏览器端没有可靠且轻量的渲染方案，因此这里不做内联预览。');
      } else if (kind === 'pdf') {
        renderPdf(filePath);
      } else if (kind === 'image') {
        renderImageFile(filePath);
      } else if (kind === 'video') {
        renderVideoFile(filePath);
      } else if (kind === 'audio') {
        renderAudioFile(filePath);
      } else if (kind === 'text') {
        await renderTextFile(filePath, seq);
      } else {
        renderUnsupported(filePath, '暂不支持预览此格式', '无法识别的文件类型：' + (ext ? '.' + ext : (baseName(filePath) || '(无扩展名)')) + '。你可以下载后使用其他程序打开。');
      }
    } catch (e) {
      if (seq !== openSeq) return false;
      if (e && (e.status === 413 || e.code === 'too-large')) {
        renderTooLarge(filePath, e);
        ok = false;
      } else {
        renderError(e, filePath);
        ok = false;
      }
    }

    if (seq !== openSeq) return false;

    // 先落回上次的位置（正文已就位）。图片加载会让高度变化，随后再校正一次；
    // 但如果用户已经自己滚走了，就绝不把他拉回原处。
    const restoredY = restoreScroll(filePath);

    await settleImages();
    if (seq !== openSeq) return false;
    if (Math.abs((window.scrollY || 0) - restoredY) < 2) restoreScroll(filePath);
    updateStats();
    updateProgress();
    window.__reader.ready = true;

    // 记住最后一次成功打开的文件，下次启动直接回到这里
    if (ok) {
      try { localStorage.setItem(LS.lastFile, filePath); } catch (_) { /* ignore */ }
    }

    // 记住双语模式：上一份文档是「双语/仅译文」，这份也直接用同样的模式
    if (ok && state.translatable) {
      let pref = 'off';
      try { pref = localStorage.getItem(LS.bilingual) || 'off'; } catch (_) { pref = 'off'; }
      if (pref === 'dual' || pref === 'zh') {
        // 翻译跳过判断依赖语言，检测是异步的，这里先用本地判断兜底
        if (!state.docLang) state.docLang = guessDocLang($('#content').textContent.slice(0, 2000));
        setBilingualMode(pref);
      }
    }
    return ok;
  }

  /**
   * 浏览器本地 File API 智能编码读取（与服务端 readTextSmart 对齐 UTF-8 / BOM / UTF-16 LE/BE / GBK）
   */
  async function readLocalFileTextSmart(fileObj) {
    const maxBytes = 32 * 1024 * 1024;
    const size = typeof fileObj.size === 'number' ? fileObj.size : 0;
    if (size > maxBytes) {
      const err = new Error('文件过大，暂不支持内联预览（上限 32 MB）');
      err.status = 413;
      err.code = 'too-large';
      throw err;
    }
    const ab = await fileObj.arrayBuffer();
    const buf = new Uint8Array(ab);
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      return { text: new TextDecoder('utf-8').decode(buf.subarray(3)), encoding: 'utf-8-bom', size: buf.length };
    }
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
      return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'utf-16le', size: buf.length };
    }
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
      return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'utf-16be', size: buf.length };
    }
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8', size: buf.length };
    } catch (_) {
      try {
        return { text: new TextDecoder('gbk').decode(buf), encoding: 'gbk', size: buf.length };
      } catch (_) {
        let s = '';
        for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
        return { text: s, encoding: 'latin1', size: buf.length };
      }
    }
  }

  /**
   * 纯浏览器模式（Web 模式）下通过 <input type="file"> 或拖入 File 对象直接本地预览
   */
  async function openWebLocalFile(file) {
    if (!file || typeof file.name !== 'string') return false;
    const seq = ++openSeq;
    if (state.currentFile && !state.isWebLocalFile) {
      saveScroll(state.currentFile);
    }
    stopTts();
    resetBilingual();
    cleanupActiveMedia();
    document.body.classList.remove('pdf-view');
    state.onPdfZoomChanged = null;
    state.onPdfConfigChanged = null;
    state.translatable = false;
    state.docLang = '';
    state.isWebLocalFile = true;
    const fileName = file.name;
    state.currentFile = fileName;

    const crumb = $('#crumb');
    if (crumb) {
      crumb.innerHTML =
        '<span class="crumb-cur">' + escapeHtml(fileName) + '</span>' +
        '<span class="crumb-dir"> — 浏览器本地文件预览</span>';
      crumb.title = fileName;
    }
    clearFind(true);
    document.body.classList.remove('sidebar-open');

    window.__reader.ready = false;
    window.__reader.stats = null;

    const c = $('#content');
    c.innerHTML = '<div class="welcome"><h1>正在载入…</h1></div>';

    const ext = extOf(fileName);
    const kind = kindOf(fileName);
    let ok = true;
    try {
      if (kind === 'markdown') {
        await ensureLib(['marked', 'hljs', 'dompurify']);
        const info = await readLocalFileTextSmart(file);
        if (seq !== openSeq) return false;
        renderMarkdownFromData({ path: fileName, size: info.size, encoding: info.encoding, text: info.text }, '', true);
      } else if (kind === 'html') {
        await ensureLib(['hljs', 'dompurify']);
        const info = await readLocalFileTextSmart(file);
        if (seq !== openSeq) return false;
        renderHtmlFromData({ path: fileName, size: info.size, encoding: info.encoding, text: info.text }, '', true);
      } else if (kind === 'text') {
        const info = await readLocalFileTextSmart(file);
        if (seq !== openSeq) return false;
        renderTextFromData({ path: fileName, size: info.size, encoding: info.encoding, text: info.text }, fileName);
      } else if (kind === 'docx') {
        await ensureLib(['mammoth', 'dompurify']);
        const buf = await file.arrayBuffer();
        if (seq !== openSeq) return false;
        await renderDocxBuffer(buf, fileName, seq, true);
      } else if (kind === 'sheet') {
        await ensureLib(['XLSX']);
        const buf = await file.arrayBuffer();
        if (seq !== openSeq) return false;
        renderSheetBuffer(buf, fileName);
      } else if (kind === 'image') {
        const blobUrl = URL.createObjectURL(file);
        state.activeBlobUrl = blobUrl;
        renderImageFile(fileName, blobUrl, fileName + ' · ' + (file.size || 0) + ' 字节 · 浏览器本地预览');
      } else if (kind === 'video') {
        const blobUrl = URL.createObjectURL(file);
        state.activeBlobUrl = blobUrl;
        renderVideoFile(fileName, blobUrl, fileName + ' · ' + (file.size || 0) + ' 字节 · 浏览器本地预览');
      } else if (kind === 'audio') {
        const blobUrl = URL.createObjectURL(file);
        state.activeBlobUrl = blobUrl;
        renderAudioFile(fileName, blobUrl, fileName + ' · ' + (file.size || 0) + ' 字节 · 浏览器本地预览');
      } else if (kind === 'pdf') {
        const blobUrl = URL.createObjectURL(file);
        state.activeBlobUrl = blobUrl;
        renderLocalPdfBlob(fileName, blobUrl);
      } else if (kind === 'pptx') {
        renderUnsupported(fileName, 'PPT 暂不支持内联预览', 'PPTX 是二进制压缩包格式，浏览器端没有可靠且轻量的渲染方案，因此这里不做内联预览。', true);
      } else {
        renderUnsupported(fileName, '暂不支持预览此格式', '无法识别的文件类型：' + (ext ? '.' + ext : (fileName || '(无扩展名)')) + '。', true);
      }
    } catch (e) {
      if (seq !== openSeq) return false;
      if (e && (e.status === 413 || e.code === 'too-large')) {
        renderTooLarge(fileName, e, true);
        ok = false;
      } else {
        renderError(e, fileName, () => openWebLocalFile(file));
        ok = false;
      }
    }

    if (seq !== openSeq) return false;
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    await settleImages();
    if (seq !== openSeq) return false;
    updateStats();
    updateProgress();
    window.__reader.ready = true;
    return ok;
  }

  function setCrumb(filePath) {
    const crumb = $('#crumb');
    crumb.innerHTML = '<span class="crumb-cur">' + escapeHtml(baseName(filePath)) + '</span>' +
      '<span class="crumb-dir"> — ' + escapeHtml(dirOf(filePath)) + '</span>';
    crumb.title = filePath;
  }

  /* ---------------------------------------------------------------- Markdown */

  function renderMarkdownFromData(data, filePath, isLocalPreview) {
    const parse = lib.marked ? (lib.marked.parse || lib.marked) : null;
    let html = null;
    if (parse) {
      try {
        // 消毒后再进 DOM：内嵌 HTML/事件属性/危险协议全部过滤
        html = sanitizeHtml(parse(data.text, { gfm: true, breaks: false }));
      } catch (_) {
        html = null;
      }
    }

    const c = $('#content');
    const metaLabel =
      escapeHtml(data.path) + ' · ' + data.size + ' 字节' +
      (data.encoding ? ' · ' + escapeHtml(data.encoding) : '') +
      (isLocalPreview ? ' · 浏览器本地预览' : '');
    c.innerHTML = '<div class="doc-meta">' + metaLabel + '</div>' +
      (html != null ? html : '<pre><code>' + escapeHtml(data.text) + '</code></pre>');

    rewriteImages(filePath);
    fixLinks(filePath);
    embedVideos(filePath);
    enhanceCode();
    buildToc();
    enhanceTts();
    state.translatable = true;
    detectDocLanguage(data.text, filePath || data.path);
  }

  async function renderMarkdown(filePath, seq) {
    await ensureLib(['marked', 'hljs', 'dompurify']);
    if (seq !== openSeq) return;
    const data = await api('/api/read', { path: filePath });
    if (seq !== openSeq) return;
    renderMarkdownFromData(data, filePath, false);
  }

  /* ---------------------------------------------------------------- HTML */

  /**
   * 本地 HTML 文档按「阅读模式」渲染：去掉脚本和样式，保留正文，
   * 这样也能用同一套双语对照。
   */
  function renderHtmlFromData(data, filePath, isLocalPreview) {
    const doc = new DOMParser().parseFromString(data.text, 'text/html');

    // 1) 去掉会执行代码或改变布局的标签
    $$('script, style, link, meta, iframe, object, embed, form, input, button, textarea, select, noscript', doc)
      .forEach((n) => n.remove());

    // 2) 去掉内联事件、危险协议和会影响布局的属性
    $$('*', doc).forEach((el) => {
      for (const attr of Array.from(el.attributes)) {
        if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
        if (attr.name === 'style' || attr.name === 'srcset' || attr.name === 'formaction') {
          el.removeAttribute(attr.name);
        }
        if (
          (attr.name === 'href' || attr.name === 'src') &&
          /^\s*(javascript|vbscript|data|file|blob):/i.test(attr.value) &&
          !(attr.name === 'src' && /^data:image\//i.test(attr.value))
        ) {
          el.removeAttribute(attr.name);
        }
      }
    });

    const body = doc.body;
    if (!body) throw new Error('这个 HTML 没有正文');

    // 3) 把包住标题/段落的 inline 外壳拆掉（老网页常见 <span> 包一切）
    $$('span, font, center', body).forEach((el) => {
      if (el.querySelector('h1, h2, h3, h4, h5, h6, p, div, ul, ol, table, blockquote')) {
        el.replaceWith(...Array.from(el.childNodes));
      }
    });

    // 4) 裸文本节点包成 <p>，否则双语对照收不到它
    const texts = [];
    const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const t = walker.currentNode;
      if (!t.textContent.trim() || t.textContent.trim().length < 30) continue;
      const pe = t.parentElement;
      if (pe && pe.closest('p, h1, h2, h3, h4, h5, h6, li, td, th, blockquote, figcaption, pre, code')) {
        continue;
      }
      texts.push(t);
    }
    texts.forEach((t) => {
      const p = doc.createElement('p');
      p.textContent = t.textContent.trim();
      if (t.parentNode) t.parentNode.replaceChild(p, t);
    });

    const title = (doc.title || '').trim();
    const hasH1 = !!body.querySelector('h1');
    const c = $('#content');
    // 前面的“删标签”不是消毒：style、srcset、data: 图片、远程追踪像素都还在。
    // 统一再走一次白名单，保证 HTML 文档和 Markdown 的信任边界一致。
    const safeBody = sanitizeHtml(body.innerHTML);
    const metaLabel =
      escapeHtml(data.path) + ' · ' + data.size + ' 字节' +
      (data.encoding ? ' · ' + escapeHtml(data.encoding) : '') +
      (isLocalPreview ? ' · 浏览器本地预览' : '');
    c.innerHTML =
      '<div class="doc-meta">' + metaLabel + '</div>' +
      (title && !hasH1 ? '<h1 class="html-title">' + escapeHtml(title) + '</h1>' : '') +
      safeBody;

    rewriteImages(filePath);
    fixLinks(filePath);
    enhanceCode();
    buildToc();
    enhanceTts();
    state.translatable = true;
    detectDocLanguage(body.textContent, filePath || data.path);
  }

  async function renderHtml(filePath, seq) {
    await ensureLib(['hljs', 'dompurify']);
    if (seq !== openSeq) return;
    const data = await api('/api/read', { path: filePath });
    if (seq !== openSeq) return;
    renderHtmlFromData(data, filePath, false);
  }

  /**
   * 第 1 步（最关键）：图片重写
   * 把 Markdown 里的 ../../../_images/xxx.png 交给 /api/asset 翻译成磁盘真实路径。
   */
  function rewriteImages(filePath) {
    const c = $('#content');
    state.lightboxItems = [];
    let imgIndex = 0;

    $$('img', c).forEach((img) => {
      const raw = img.getAttribute('src') || '';
      const alt = img.getAttribute('alt') || '';

      // 远程图 / 内联 base64 图不动；远程图不带 Referer，减少像素追踪泄露
      if (/^(https?:|data:)/i.test(raw)) {
        if (/^https?:/i.test(raw)) img.referrerPolicy = 'no-referrer';
        const idx = state.lightboxItems.push({ src: raw, caption: alt }) - 1;
        bindZoom(img, idx);
        return;
      }

      // 视频文件被当成图片引用时，换成播放器
      if (VIDEO_EXT.indexOf(extOf(raw)) >= 0) {
        const fig = document.createElement('figure');
        fig.className = 'video-embed';
        fig.innerHTML = '<div class="video-frame"><video controls preload="metadata" src="' +
          escapeAttr(assetUrl(filePath, raw)) + '"></video></div>';
        const p = img.closest('p');
        (p && p.childNodes.length === 1 ? p : img).replaceWith(fig);
        return;
      }

      // 包进 <figure>（若 img 独占一个 <p>，整段替换，避免非法嵌套）
      const fig = document.createElement('figure');
      fig.className = 'md-figure';
      const p = img.parentElement;
      const alone = p && p.tagName === 'P' && p.childNodes.length === 1 && p.firstChild === img;
      const anchor = alone ? p : img;
      anchor.parentNode.insertBefore(fig, anchor);
      fig.appendChild(img);
      if (alone) p.remove();

      if (alt) {
        const cap = document.createElement('figcaption');
        cap.textContent = alt;
        fig.appendChild(cap);
      }

      img.removeAttribute('width');
      img.removeAttribute('height');
      // 首屏 3 张立即加载，其余交给浏览器懒加载：长文几十张图不再同时解码
      img.loading = imgIndex++ < 3 ? 'eager' : 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';

      img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
      img.addEventListener('error', () => {
        const box = document.createElement('div');
        box.className = 'img-error';
        box.innerHTML = '图片加载失败：<code>' + escapeHtml(raw) + '</code>';
        if (fig.parentNode) fig.replaceWith(box);
      }, { once: true });

      img.src = assetUrl(filePath, raw);
      const idx = state.lightboxItems.push({ src: img.src, caption: alt }) - 1;
      bindZoom(img, idx);
    });
  }

  /** 按序号绑定：同一张图在文中出现多次时，点第二张也能从第二张开始翻 */
  function bindZoom(img, index) {
    img.addEventListener('click', () => openLightbox(index));
  }

  /**
   * 第 2 步：链接分流。
   *   外链      → 新窗口
   *   站内相对  → 直接在阅读器里打开目标文件（以前点了会跳到 file:// 或 404）
   */
  function fixLinks(filePath) {
    $$('#content a').forEach((a) => {
      const href = a.getAttribute('href') || '';
      if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href) || /^tel:/i.test(href)) {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        return;
      }
      // 危险协议不能只是“不处理”：<a href="file:///C:/..."> 仍然可点。
      // 直接摘掉 href，保留文字，让用户知道这里的东西被拦了。
      if (/^\s*(javascript|vbscript|data|file|blob):/i.test(href)) {
        a.removeAttribute('href');
        a.classList.add('link-blocked');
        a.title = '已阻止不安全的链接：' + href.slice(0, 80);
        return;
      }
      if (!href || href.charAt(0) === '#') return;
      if (!filePath) return;

      const hashAt = href.indexOf('#');
      const rawPath = hashAt >= 0 ? href.slice(0, hashAt) : href;
      const hash = hashAt >= 0 ? href.slice(hashAt + 1) : '';
      if (!rawPath) return;

      const target = resolveRelative(filePath, rawPath);
      a.removeAttribute('href');
      a.classList.add('internal-link');
      a.addEventListener('click', (ev) => {
        ev.preventDefault();
        openFile(target).then((ok) => {
          if (!ok) {
            toast('无法打开：' + target, 'err');
            return;
          }
          if (!hash) return;
          let el = null;
          try { el = document.getElementById(decodeURIComponent(hash)); } catch (_) { el = null; }
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      });
    });
  }

  /* ---------------------------------------------------------------- 第 3 步：视频自动嵌入 */

  const RE_BILI = /https?:\/\/(?:www\.)?bilibili\.com\/video\/(BV[0-9A-Za-z]+)/i;
  const RE_YT = /https?:\/\/(?:www\.)?(?:youtu\.be\/|youtube\.com\/watch\?v=)([0-9A-Za-z_-]+)/i;
  const RE_VIDEO_ANY = /https?:\/\/(?:www\.)?bilibili\.com\/video\/BV[0-9A-Za-z]+|https?:\/\/(?:www\.)?youtu\.be\/[0-9A-Za-z_-]+|https?:\/\/(?:www\.)?youtube\.com\/watch\?v=[0-9A-Za-z_-]+/i;

  function makeVideoFigure(url, label) {
    const bm = RE_BILI.exec(url);
    const ym = RE_YT.exec(url);
    let embed = '';
    if (bm) embed = 'https://player.bilibili.com/player.html?bvid=' + bm[1] + '&autoplay=0&high_quality=1&danmaku=0';
    else if (ym) embed = 'https://www.youtube.com/embed/' + ym[1];

    const fig = document.createElement('figure');
    fig.className = 'video-embed';
    fig.innerHTML =
      '<figcaption class="video-caption">' + escapeHtml(label || '视频') + '</figcaption>' +
      '<div class="video-frame"><iframe src="' + escapeAttr(embed) +
      '" allowfullscreen scrolling="no" frameborder="0"></iframe></div>' +
      '<div class="video-actions"><a href="' + escapeAttr(url) +
      '" target="_blank" rel="noopener">在新窗口打开 ↗</a></div>';
    return fig;
  }

  function embedVideos(filePath) {
    const seen = Object.create(null);

    // 3a) 段落里的视频链接（含 B 站裸 URL、Markdown 链接两种）
    $$('#content p').forEach((p) => {
      if (p.closest('.video-embed')) return;
      const text = p.textContent || '';
      const m = RE_VIDEO_ANY.exec(text);
      if (!m) return;
      const url = m[0];
      if (seen[url]) { p.remove(); return; }
      seen[url] = true;
      // 保留原文案作为说明，内容不丢
      p.replaceWith(makeVideoFigure(url, text.trim()));
    });

    // 3b) 本地视频文件链接 -> <video>
    $$('#content a').forEach((a) => {
      const href = a.getAttribute('href') || '';
      if (VIDEO_EXT.indexOf(extOf(href)) < 0) return;
      const fig = document.createElement('figure');
      fig.className = 'video-embed';
      fig.innerHTML = '<div class="video-frame"><video controls preload="metadata" src="' +
        escapeAttr(assetUrl(filePath, href)) + '"></video></div>';
      const p = a.closest('p');
      (p && p.textContent.trim() === a.textContent.trim() ? p : a).replaceWith(fig);
    });
  }

  /* ---------------------------------------------------------------- 第 4 步：代码高亮 + 复制 */

  function makeCopyButton(getText) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'code-copy';
    btn.textContent = '复制';
    btn.addEventListener('click', async () => {
      const text = getText();
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        }
        btn.textContent = '已复制 ✓';
        btn.classList.add('done');
      } catch (_) {
        btn.textContent = '复制失败';
      }
      setTimeout(() => { btn.textContent = '复制'; btn.classList.remove('done'); }, 1500);
    });
    return btn;
  }

  /** 构建代码块包装元素（不操作现有 DOM，由调用方负责挂载） */
  function wrapPre(pre, lang) {
    const wrap = document.createElement('div');
    wrap.className = 'code-block';
    const head = document.createElement('div');
    head.className = 'code-head';
    const label = document.createElement('span');
    label.className = 'code-lang';
    label.textContent = lang || 'text';
    head.appendChild(label);
    const code = pre.querySelector('code') || pre;
    head.appendChild(makeCopyButton(() => code.innerText || code.textContent || ''));
    wrap.appendChild(head);
    wrap.appendChild(pre);
    return wrap;
  }

  function enhanceCode() {
    const hljs = lib.hljs || (lib.hljs = grabLib('hljs'));
    $$('#content pre').forEach((pre) => {
      if (pre.closest('.code-block')) return;
      const code = pre.querySelector('code') || pre;
      const m = /language-([\w+-]+)/.exec(code.className || '');
      const lang = m ? m[1] : 'text';
      if (hljs) {
        try { hljs.highlightElement(code); } catch (_) { /* ignore */ }
      }
      const parent = pre.parentNode;
      const next = pre.nextSibling;
      const wrap = wrapPre(pre, lang);
      if (parent) parent.insertBefore(wrap, next);
    });
  }

  /* ---------------------------------------------------------------- 第 5 步：目录大纲 */

  function slugify(text) {
    return String(text || '')
      .trim()
      .toLowerCase()
      .replace(/[\s\u3000]+/g, '-')
      .replace(/[^\w\u4e00-\u9fa5\-]/g, '')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '');
  }

  function clearToc(hint) {
    const toc = $('#toc');
    state.tocLinks = [];
    if (!toc) return;
    toc.innerHTML = '<div class="toc-empty">' + escapeHtml(hint || '当前文档暂无标题目录') + '</div>';
  }

  function buildToc() {
    const toc = $('#toc');
    if (!toc) return;
    toc.innerHTML = '';
    state.tocLinks = [];

    const heads = $$('#content h1, #content h2, #content h3');
    if (!heads.length) {
      clearToc();
      return;
    }
    const used = Object.create(null);

    heads.forEach((h, i) => {
      let base = slugify(h.textContent) || ('section-' + i);
      let id = base;
      let n = 1;
      while (used[id]) { id = base + '-' + (++n); }
      used[id] = true;
      h.id = id;

      const a = document.createElement('a');
      a.href = '#' + id;
      a.textContent = (h.textContent || '').trim();
      a.className = 'lv' + Math.min(4, Number(h.tagName.slice(1)));
      a.addEventListener('click', (ev) => {
        ev.preventDefault();
        h.scrollIntoView({ behavior: 'smooth', block: 'start' });
        history.replaceState(null, '', '#' + id);
      });
      toc.appendChild(a);
      state.tocLinks.push({ a: a, h: h });
    });
  }

  /* ---------------------------------------------------------------- 文本 / 代码文件 */

  function renderTextFromData(data, filePath) {
    const lang = extOf(filePath) || 'text';
    const hljsLang = formats.hljsLangFor(filePath);
    const isPlain = !hljsLang;

    const c = $('#content');
    c.innerHTML =
      '<div class="doc-meta">' +
      escapeHtml(data.path) + ' · ' + data.size + ' 字节' +
      (data.encoding ? ' · ' + escapeHtml(data.encoding) : '') +
      '</div>';

    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.textContent = data.text;
    pre.appendChild(code);

    const hljs = lib.hljs || (lib.hljs = grabLib('hljs'));
    if (!isPlain && hljs) {
      if (!hljs.getLanguage || hljs.getLanguage(hljsLang)) {
        code.className = 'language-' + hljsLang;
        try { hljs.highlightElement(code); } catch (_) { /* ignore */ }
      } else {
        code.className = 'language-plaintext';
      }
    } else {
      code.className = 'language-plaintext';
      if (!isPlain && !hljs) {
        toast('代码高亮库未加载，已按纯文本显示', 'warn');
      }
    }

    const wrap = wrapPre(pre, lang);
    wrap.classList.add('file-code');
    c.appendChild(wrap);
    clearToc();
  }

  async function renderTextFile(filePath, seq) {
    const data = await api('/api/read', { path: filePath });
    if (seq !== openSeq) return;
    renderTextFromData(data, filePath);
  }

  /* ---------------------------------------------------------------- PDF */

  function effectivePdfZoom() {
    const base = Number(state.pdfZoom) || 100;
    const sys = Number(state.systemTextScale) || 1;
    return Math.max(50, Math.min(300, Math.round(base * sys)));
  }

  function buildPdfFrameUrl(baseUrl, zoomPct, bustToken) {
    const raw = String(baseUrl || '');
    if (!raw) return '';
    const z = Math.max(50, Math.min(300, Math.round(Number(zoomPct) || 100)));
    if (raw.startsWith('blob:')) {
      return raw.replace(/#.*$/, '') + '#zoom=' + z;
    }
    try {
      const u = new URL(raw, location.origin);
      u.searchParams.set('_z', String(z));
      if (bustToken) u.searchParams.set('_t', String(bustToken));
      else u.searchParams.delete('_t');
      u.hash = 'zoom=' + z;
      return u.toString();
    } catch (_) {
      return raw.replace(/#.*$/, '') + '#zoom=' + z;
    }
  }

  function renderPdf(filePath) {
    document.body.classList.add('pdf-view');
    const c = $('#content');
    const url = rawUrl(filePath);
    const initZoom = effectivePdfZoom();
    const wrap = document.createElement('div');
    wrap.className = 'pdf-wrap';
    wrap.innerHTML =
      '<div class="pdf-bar">' +
      '<span class="pdf-name">' + escapeHtml(baseName(filePath)) + '</span>' +
      '<div class="pdf-actions">' +
      '<span class="pdf-zoom-group" title="缩放 PDF（或使用 视图 → 增大/减小字号）">' +
      '<button type="button" class="btn btn-mini" id="pdf-zoom-dec" aria-label="缩小 PDF">A-</button>' +
      '<span class="pdf-zoom-val" id="pdf-zoom-val">' + initZoom + '%</span>' +
      '<button type="button" class="btn btn-mini" id="pdf-zoom-inc" aria-label="放大 PDF">A+</button>' +
      '</span>' +
      '<button class="btn btn-mini" id="pdf-read">🔊 朗读</button>' +
      '<button class="btn btn-mini btn-primary" id="pdf-translate">双语翻译</button>' +
      '<span class="pdf-modes" id="pdf-modes" hidden>' +
      '<button type="button" data-mode="src">原文</button>' +
      '<button type="button" data-mode="dual" class="active">双语</button>' +
      '<button type="button" data-mode="mono">译文</button>' +
      '</span>' +
      '<button type="button" class="btn btn-mini" id="pdf-new-window">新窗口打开</button>' +
      '</div></div>' +
      '<div class="pdf-progress" id="pdf-progress" hidden>' +
      '<div class="pdf-progress-bar"><i id="pdf-progress-fill"></i></div>' +
      '<span class="pdf-progress-text" id="pdf-progress-text">准备中…</span>' +
      '<button type="button" class="btn btn-mini" id="pdf-cancel" hidden>取消</button>' +
      '<button type="button" class="btn btn-mini" id="pdf-log-toggle">日志</button>' +
      '</div>' +
      '<pre class="pdf-log" id="pdf-log" hidden></pre>' +
      '<div class="pdf-frames" id="pdf-frames">' +
      '<iframe class="pdf-frame active" data-frame="src" data-zoom="' + initZoom + '" data-version="0" src="' + escapeAttr(buildPdfFrameUrl(url, initZoom)) + '"></iframe>' +
      '</div>';
    c.innerHTML = '';
    c.appendChild(wrap);
    clearToc();

    const frames = $('#pdf-frames');
    const btn = $('#pdf-translate');
    const readBtn = $('#pdf-read');
    if (readBtn) readBtn.addEventListener('click', startArticle);
    const zoomDecBtn = $('#pdf-zoom-dec');
    const zoomIncBtn = $('#pdf-zoom-inc');
    const zoomValEl = $('#pdf-zoom-val');
    if (zoomDecBtn) zoomDecBtn.addEventListener('click', () => stepPdfZoom(-1));
    if (zoomIncBtn) zoomIncBtn.addEventListener('click', () => stepPdfZoom(1));
    const modes = $('#pdf-modes');
    const progress = $('#pdf-progress');
    const fill = $('#pdf-progress-fill');
    const ptext = $('#pdf-progress-text');
    const log = $('#pdf-log');
    const cancelBtn = $('#pdf-cancel');
    const newWinBtn = $('#pdf-new-window');
    let current = { src: url, dual: '', mono: '' };
    let currentMode = 'src';
    let hasTranslated = false;
    let renderVersion = 0;
    let cancelled = false;
    let currentJobId = '';

    /** 用户可能已经切去别的文件，回调里别再动这份 PDF 的界面 */
    const alive = () => state.currentFile === filePath;

    /**
     * 各模式各用一个 iframe：以前切换模式会给同一个 iframe 换 src，
     * 每切一次就重新加载并跳回第一页，读到一半切回原文非常难受。
     */
    function frameFor(name) {
      const z = effectivePdfZoom();
      const targetUrl = buildPdfFrameUrl(current[name] || url, z, name === 'src' ? '' : renderVersion);
      let f = null;
      $$('.pdf-frame', frames).forEach((x) => { if (x.dataset.frame === name) f = x; });
      if (!f) {
        f = document.createElement('iframe');
        f.className = 'pdf-frame';
        f.dataset.frame = name;
        f.dataset.zoom = String(z);
        f.dataset.version = String(renderVersion);
        f.src = targetUrl;
        frames.appendChild(f);
      } else if (
        f.dataset.zoom !== String(z) ||
        (name !== 'src' && f.dataset.version !== String(renderVersion)) ||
        !(f.src || (typeof f.getAttribute === 'function' && f.getAttribute('src')))
      ) {
        f.dataset.zoom = String(z);
        f.dataset.version = String(renderVersion);
        f.src = targetUrl;
      }
      return f;
    }

    function setMode(name) {
      if (name !== 'src' && !current[name]) name = 'src';
      currentMode = name;
      const active = frameFor(name);
      $$('.pdf-frame', frames).forEach((x) => x.classList.toggle('active', x === active));
      $$('button', modes).forEach((b) => b.classList.toggle('active', b.dataset.mode === name));
    }

    state.onPdfZoomChanged = (z) => {
      if (!alive()) return;
      if (zoomValEl) zoomValEl.textContent = z + '%';
      setMode(currentMode);
    };

    $$('button', modes).forEach((b) => {
      b.addEventListener('click', () => setMode(b.dataset.mode));
    });

    $('#pdf-log-toggle').addEventListener('click', () => {
      log.hidden = !log.hidden;
    });

    function paintJob(job) {
      const pct = job.status === 'done' ? 100 : job.progress || 0;
      fill.style.width = pct + '%';
      if (job.status === 'done') ptext.textContent = '翻译完成';
      else if (job.status === 'error') ptext.textContent = '翻译失败';
      else if (pct > 0) ptext.textContent = '翻译中 ' + pct + '%';
      else ptext.textContent = '解析 PDF…（首次会下载字体，请稍候）';
      log.textContent = (job.log || []).join('\n');
      log.scrollTop = log.scrollHeight;
    }

    function finish(output, forced) {
      progress.hidden = true;
      cancelBtn.hidden = true;
      btn.disabled = false;
      btn.textContent = '重新翻译';
      hasTranslated = true;
      if (forced) renderVersion++;
      if (output) {
        current.dual = output.dual || current.dual;
        current.mono = output.mono || current.mono;
      }
      if (current.dual || current.mono) {
        modes.hidden = false;
        setMode(current.dual ? 'dual' : 'mono');
        toast('双语 PDF 已生成，可在上方切换 原文 / 双语 / 译文');
      } else {
        toast('没有拿到译文文件', 'err');
      }
    }

    async function poll(jobId, forced) {
      currentJobId = jobId || '';
      let errors = 0;
      const tick = async () => {
        if (cancelled || !alive()) return;
        try {
          const r = await api('/api/pdf-translate/status', { id: jobId });
          if (cancelled || !alive()) return;
          paintJob(r.job);
          if (r.output) {
            current.dual = r.output.dual || current.dual;
            current.mono = r.output.mono || current.mono;
          }
          if (r.job.status === 'running') {
            setTimeout(tick, 1500);
            return;
          }
          if (r.job.status === 'done') {
            finish(r.output, forced);
            return;
          }
          btn.disabled = false;
          btn.textContent = hasTranslated ? '重新翻译' : '重试翻译';
          ptext.textContent = '翻译失败';
          cancelBtn.hidden = true;
          log.hidden = false;
          toast('翻译失败：' + String(r.job.error || '未知错误').split('\n')[0], 'err');
          return;
        } catch (e) {
          if (cancelled || !alive()) return;
          errors++;
          if (errors > 3) {
            progress.hidden = true;
            cancelBtn.hidden = true;
            btn.disabled = false;
            btn.textContent = hasTranslated ? '重新翻译' : '重试翻译';
            toast('翻译状态获取失败：' + e.message, 'err');
            return;
          }
          setTimeout(tick, 2000);
        }
      };
      tick();
    }

    async function startTranslate() {
      const force = hasTranslated;
      cancelled = false;
      btn.disabled = true;
      btn.textContent = '翻译中…';
      progress.hidden = false;
      cancelBtn.hidden = false;
      cancelBtn.disabled = false;
      fill.style.width = '0%';
      ptext.textContent = '准备中…';
      log.textContent = '';
      try {
        const r = await apiPost('/api/pdf-translate', { path: filePath, force: force });
        if (!alive()) return;
        if (r.job && r.job.id) currentJobId = r.job.id;
        if (r.output) {
          current.dual = r.output.dual || '';
          current.mono = r.output.mono || '';
        }
        if (r.cached && !force) {
          paintJob(r.job);
          finish(r.output, false);
          return;
        }
        poll(r.job.id, force);
      } catch (e) {
        if (!alive()) return;
        const data = e.data || {};
        cancelBtn.hidden = true;
        if (data.code === 'engine-missing') {
          progress.hidden = true;
          btn.disabled = false;
          btn.textContent = hasTranslated ? '重新翻译' : '双语翻译';
          toast('还没安装 PDF 翻译引擎，正在打开设置…', 'warn');
          openTranslateSettings(true);
          return;
        }
        if (data.code === 'lang-mismatch') {
          progress.hidden = true;
          btn.disabled = false;
          btn.textContent = hasTranslated ? '重新翻译' : '双语翻译';
          toast(e.message, 'warn');
          openTranslateSettings(false);
          return;
        }
        if (data.code === 'busy') {
          progress.hidden = true;
          btn.disabled = false;
          btn.textContent = hasTranslated ? '重新翻译' : '双语翻译';
          toast('已有另一个 PDF 正在翻译，请等它完成后再试', 'warn');
          return;
        }
        progress.hidden = true;
        btn.disabled = false;
        btn.textContent = hasTranslated ? '重新翻译' : '重试翻译';
        toast('翻译启动失败：' + e.message, 'err');
      }
    }

    btn.addEventListener('click', startTranslate);

    // 系统浏览器没有本应用的 HttpOnly Cookie，直接打开 /api/raw 必然 401。
    // 先换一张 60 秒、单文件、用后即焚的票据再交给浏览器。
    if (newWinBtn) {
      newWinBtn.addEventListener('click', async () => {
        try {
          const r = await apiPost('/api/ticket', { path: filePath });
          if (!r || !r.url) throw new Error('没有拿到打开票据');
          if (window.readerNative && window.readerNative.openExternal) {
            window.readerNative.openExternal(r.url);
          } else {
            window.open(r.url, '_blank', 'noopener');
          }
        } catch (e) {
          toast('打开新窗口失败：' + e.message, 'err');
        }
      });
    }

    cancelBtn.addEventListener('click', async () => {
      cancelled = true;
      cancelBtn.disabled = true;
      try {
        const r = await apiPost('/api/pdf-translate/cancel', { id: currentJobId });
        // 服务端只取消 id 匹配的任务；若返回的仍是 running，说明这是别的窗口的任务
        if (r && r.job && r.job.status === 'running') {
          cancelled = false;
          cancelBtn.disabled = false;
          toast('当前翻译任务仍在进行，没有取消其他窗口的任务', 'warn');
          return;
        }
      } catch (_) {
        /* 任务可能刚好结束，忽略 */
      }
      if (!alive()) return;
      progress.hidden = true;
      cancelBtn.hidden = true;
      btn.disabled = false;
      btn.textContent = hasTranslated ? '重新翻译' : '双语翻译';
      ptext.textContent = '已取消';
      toast('已取消翻译');
    });

    function refreshPdfState() {
      current.dual = '';
      current.mono = '';
      hasTranslated = false;
      renderVersion++;
      $$('.pdf-frame', frames).forEach((x) => {
        if (x.dataset.frame !== 'src') x.remove();
      });
      modes.hidden = true;
      progress.hidden = true;
      cancelBtn.hidden = true;
      btn.disabled = false;
      btn.textContent = '双语翻译';
      setMode('src');

      // 重新打开同一份 PDF 或修改语言/服务设置后恢复现场：已完成直接给切换按钮，
      // 还在跑就接着显示进度
      api('/api/pdf-translate/current', { path: filePath })
        .then((r) => {
          if (!alive() || !r) return;
          if (r.output && (r.output.dual || r.output.mono)) {
            current.dual = r.output.dual || '';
            current.mono = r.output.mono || '';
            hasTranslated = true;
            modes.hidden = false;
            btn.textContent = '重新翻译';
            setMode(current.dual ? 'dual' : 'mono');
          }
          if (r.job && r.job.status === 'running') {
            if (r.job.id) currentJobId = r.job.id;
            btn.disabled = true;
            btn.textContent = '翻译中…';
            progress.hidden = false;
            cancelBtn.hidden = false;
            paintJob(r.job);
            poll(r.job.id, false);
          }
        })
        .catch(() => { /* 查不到状态不影响阅读 */ });
    }

    state.onPdfConfigChanged = refreshPdfState;
    refreshPdfState();
  }

  function renderLocalPdfBlob(fileName, blobUrl) {
    document.body.classList.add('pdf-view');
    const c = $('#content');
    const initZoom = effectivePdfZoom();
    const wrap = document.createElement('div');
    wrap.className = 'pdf-wrap';
    wrap.innerHTML =
      '<div class="pdf-bar">' +
      '<span class="pdf-name">' + escapeHtml(fileName) + '（浏览器本地预览）</span>' +
      '<div class="pdf-actions">' +
      '<span class="pdf-zoom-group" title="缩放 PDF（或使用 视图 → 增大/减小字号）">' +
      '<button type="button" class="btn btn-mini" id="pdf-zoom-dec" aria-label="缩小 PDF">A-</button>' +
      '<span class="pdf-zoom-val" id="pdf-zoom-val">' + initZoom + '%</span>' +
      '<button type="button" class="btn btn-mini" id="pdf-zoom-inc" aria-label="放大 PDF">A+</button>' +
      '</span>' +
      '<span class="muted">本地预览模式（如需服务端双语翻译，请使用桌面版打开该文件）</span>' +
      '</div></div>' +
      '<div class="pdf-frames" id="pdf-frames">' +
      '<iframe class="pdf-frame active" data-frame="src" data-zoom="' + initZoom + '" src="' + escapeAttr(buildPdfFrameUrl(blobUrl, initZoom)) + '"></iframe>' +
      '</div>';
    c.innerHTML = '';
    c.appendChild(wrap);
    clearToc();

    const frames = $('#pdf-frames');
    const zoomDecBtn = $('#pdf-zoom-dec');
    const zoomIncBtn = $('#pdf-zoom-inc');
    const zoomValEl = $('#pdf-zoom-val');
    if (zoomDecBtn) zoomDecBtn.addEventListener('click', () => stepPdfZoom(-1));
    if (zoomIncBtn) zoomIncBtn.addEventListener('click', () => stepPdfZoom(1));

    state.onPdfZoomChanged = (z) => {
      if (state.currentFile !== fileName) return;
      if (zoomValEl) zoomValEl.textContent = z + '%';
      const nf = document.createElement('iframe');
      nf.className = 'pdf-frame active';
      nf.dataset.frame = 'src';
      nf.dataset.zoom = String(z);
      nf.src = buildPdfFrameUrl(blobUrl, z);
      frames.innerHTML = '';
      frames.appendChild(nf);
    };
  }

  /* ---------------------------------------------------------------- Word */

  async function renderDocxBuffer(buf, filePath, seq, isLocalPreview) {
    if (!lib.mammoth) throw new Error('mammoth 库未就绪');
    const out = await lib.mammoth.convertToHtml({ arrayBuffer: buf });
    if (seq !== openSeq) return;

    const c = $('#content');
    // DOCX 是用户下载来的第三方内容：mammoth 的输出同样要过白名单，
    // 否则文档里的图片 onerror / 外链 / 样式属性会直接进入阅读器 DOM。
    const metaLabel = escapeHtml(filePath) + (isLocalPreview ? ' · 浏览器本地预览' : '');
    c.innerHTML = '<div class="doc-meta">' + metaLabel + '</div>' + sanitizeHtml(out.value);
    // Word 里的图片默认是 base64 data URI，直接可以显示；补上放大和目录
    rewriteImages(isLocalPreview ? '' : filePath);
    fixLinks(isLocalPreview ? '' : filePath);
    enhanceCode();
    buildToc();
    enhanceTts();
    state.translatable = true;
    detectDocLanguage($('#content').textContent, filePath);
  }

  async function renderDocx(filePath, seq) {
    await ensureLib(['mammoth', 'dompurify']);
    if (seq !== openSeq) return;
    if (!lib.mammoth) throw new Error('mammoth 库未就绪');
    const res = await fetch(rawUrl(filePath));
    if (!res.ok) throw Object.assign(new Error('HTTP ' + res.status), { status: res.status, requestUrl: rawUrl(filePath) });
    const buf = await res.arrayBuffer();
    if (seq !== openSeq) return;
    await renderDocxBuffer(buf, filePath, seq, false);
  }

  /* ---------------------------------------------------------------- Excel */

  const XLSX_DISPIMG_RE = /^\s*=?\s*(?:_xlfn\.)?DISPIMG\(\s*["']([^"']+)["'](?:\s*,[^)]*)?\)\s*$/i;
  const XLSX_IMAGE_MIME = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    avif: 'image/avif'
  };
  const XLSX_B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  function decodeXmlAttr(s) {
    return String(s || '')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }

  function readXmlAttr(attrs, names) {
    const list = Array.isArray(names) ? names : [names];
    for (const n of list) {
      const re = new RegExp('(?:^|\\s)' + n + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')', 'i');
      const m = re.exec(attrs || '');
      if (m) return decodeXmlAttr(m[1] != null ? m[1] : m[2]);
    }
    return '';
  }

  function normalizeZipPath(p) {
    const parts = String(p || '').replace(/\\/g, '/').split('/');
    const out = [];
    for (const seg of parts) {
      if (!seg || seg === '.') continue;
      if (seg === '..') {
        if (out.length) out.pop();
      } else {
        out.push(seg);
      }
    }
    return out.join('/');
  }

  function resolveZipRelative(baseFile, target) {
    const raw = String(target || '').replace(/\\/g, '/').trim();
    if (!raw) return '';
    if (raw.charAt(0) === '/') return normalizeZipPath(raw);
    const base = normalizeZipPath(baseFile);
    const slash = base.lastIndexOf('/');
    const dir = slash >= 0 ? base.slice(0, slash) : '';
    return normalizeZipPath((dir ? dir + '/' : '') + raw);
  }

  function relsPathForZipPart(partPath) {
    const norm = normalizeZipPath(partPath);
    const slash = norm.lastIndexOf('/');
    const dir = slash >= 0 ? norm.slice(0, slash) : '';
    const base = slash >= 0 ? norm.slice(slash + 1) : norm;
    return (dir ? dir + '/' : '') + '_rels/' + base + '.rels';
  }

  function toUint8Array(content) {
    if (!content) return null;
    if (content instanceof Uint8Array) return content;
    if (content instanceof ArrayBuffer) return new Uint8Array(content);
    if (ArrayBuffer.isView(content)) {
      return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
    }
    if (Array.isArray(content) || typeof content.length === 'number') {
      return new Uint8Array(content);
    }
    return null;
  }

  function readZipEntryText(entry) {
    if (!entry || !entry.content) return '';
    if (typeof entry.content === 'string') return entry.content;
    const bytes = toUint8Array(entry.content);
    if (!bytes || !bytes.length) return '';
    if (typeof TextDecoder !== 'undefined') {
      try {
        return new TextDecoder('utf-8').decode(bytes);
      } catch (_) { /* ignore */ }
    }
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  function parseXmlRels(xml) {
    const map = new Map();
    if (!xml) return map;
    const re = /<(?:\w+:)?Relationship\b([^>]*)\/?>/gi;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const attrs = m[1] || '';
      const mode = readXmlAttr(attrs, 'TargetMode');
      if (/^external$/i.test(mode)) continue;
      const id = readXmlAttr(attrs, 'Id');
      const target = readXmlAttr(attrs, 'Target');
      const type = readXmlAttr(attrs, 'Type');
      if (id && target) map.set(id, { target, type });
    }
    return map;
  }

  function detectXlsxImageMime(mediaPath, bytes) {
    const ext = extOf(mediaPath);
    if (ext && Object.prototype.hasOwnProperty.call(XLSX_IMAGE_MIME, ext)) {
      return XLSX_IMAGE_MIME[ext];
    }
    // 仅对无扩展名或通用二进制后缀做魔数嗅探；拒绝 .svg/.xml 等潜在脚本载体
    if (!ext || ext === 'bin' || ext === 'dat') {
      if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
        return 'image/png';
      }
      if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return 'image/jpeg';
      }
      if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
        return 'image/gif';
      }
      if (
        bytes.length >= 12 &&
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
      ) {
        return 'image/webp';
      }
      if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
        return 'image/bmp';
      }
    }
    return '';
  }

  function bytesToBase64(bytes) {
    let out = '';
    const len = bytes.length;
    for (let i = 0; i < len; i += 3) {
      const b0 = bytes[i];
      const has1 = i + 1 < len;
      const has2 = i + 2 < len;
      const b1 = has1 ? bytes[i + 1] : 0;
      const b2 = has2 ? bytes[i + 2] : 0;
      const n = (b0 << 16) | (b1 << 8) | b2;
      out += XLSX_B64_CHARS[(n >>> 18) & 63];
      out += XLSX_B64_CHARS[(n >>> 12) & 63];
      out += has1 ? XLSX_B64_CHARS[(n >>> 6) & 63] : '=';
      out += has2 ? XLSX_B64_CHARS[n & 63] : '=';
    }
    return out;
  }

  function extractXlsxImages(wb) {
    const byId = new Map();
    const bySheetCell = new Map();
    const zipMap = new Map();
    const urlCache = new Map();

    if (wb && wb.files && typeof wb.files === 'object') {
      Object.keys(wb.files).forEach((k) => {
        const norm = normalizeZipPath(k);
        if (norm && wb.files[k]) zipMap.set(norm.toLowerCase(), wb.files[k]);
      });
    }

    const readZipText = (p) => readZipEntryText(zipMap.get(normalizeZipPath(p).toLowerCase()));
    const wbRels = parseXmlRels(readZipText('xl/_rels/workbook.xml.rels'));

    // 1) WPS 嵌入式单元格图片（xl/cellimages.xml + xl/_rels/cellimages.xml.rels）
    let cellImagesPath = '';
    wbRels.forEach((rel) => {
      if (!cellImagesPath && /cellimage/i.test(rel.type || '')) {
        cellImagesPath = resolveZipRelative('xl/workbook.xml', rel.target);
      }
    });
    if (!cellImagesPath) cellImagesPath = 'xl/cellimages.xml';

    const cellImagesXml = readZipText(cellImagesPath);
    if (cellImagesXml) {
      const cellImagesRels = parseXmlRels(readZipText(relsPathForZipPart(cellImagesPath)));
      const cellImgRe = /<(?:\w+:)?cellImage\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellImage>/gi;
      let m;
      while ((m = cellImgRe.exec(cellImagesXml)) !== null) {
        const block = m[1];
        const cnv = /<(?:\w+:)?cNvPr\b([^>]*)\/?>/i.exec(block);
        const blip = /<(?:\w+:)?blip\b([^>]*)\/?>/i.exec(block);
        if (!cnv || !blip) continue;
        const id = readXmlAttr(cnv[1], 'name');
        const descr = readXmlAttr(cnv[1], 'descr');
        const embed = readXmlAttr(blip[1], ['r:embed', 'embed']);
        const rel = embed ? cellImagesRels.get(embed) : null;
        if (id && rel && rel.target) {
          byId.set(id, { mediaPath: resolveZipRelative(cellImagesPath, rel.target), descr });
        }
      }
    }

    // 兜底：部分 WPS 文件将 ID_* 图片映射放在 drawings XML 中
    zipMap.forEach((entry, lowerPath) => {
      if (!/^xl\/drawings\/[^/]+\.xml$/i.test(lowerPath)) return;
      const xml = readZipEntryText(entry);
      if (!xml) return;
      const rels = parseXmlRels(readZipText(relsPathForZipPart(lowerPath)));
      const picRe = /<(?:\w+:)?pic\b[^>]*>([\s\S]*?)<\/(?:\w+:)?pic>/gi;
      let m;
      while ((m = picRe.exec(xml)) !== null) {
        const block = m[1];
        const cnv = /<(?:\w+:)?cNvPr\b([^>]*)\/?>/i.exec(block);
        const blip = /<(?:\w+:)?blip\b([^>]*)\/?>/i.exec(block);
        if (!cnv || !blip) continue;
        const id = readXmlAttr(cnv[1], 'name');
        if (!id || byId.has(id)) continue;
        const descr = readXmlAttr(cnv[1], 'descr');
        const embed = readXmlAttr(blip[1], ['r:embed', 'embed']);
        const rel = embed ? rels.get(embed) : null;
        if (rel && rel.target) {
          byId.set(id, { mediaPath: resolveZipRelative(lowerPath, rel.target), descr });
        }
      }
    });

    // 2) 标准 Excel 浮动锚点图（worksheets -> drawings -> media）
    const wbSheets = (wb && wb.Workbook && Array.isArray(wb.Workbook.Sheets)) ? wb.Workbook.Sheets : [];
    wbSheets.forEach((s) => {
      if (!s || !s.name || s.Hidden === 2 || s.name === 'WpsReserved_CellImgList') return;
      const sheetRel = s.id ? wbRels.get(s.id) : null;
      if (!sheetRel || !sheetRel.target) return;
      const sheetXmlPath = resolveZipRelative('xl/workbook.xml', sheetRel.target);
      const sheetRels = parseXmlRels(readZipText(relsPathForZipPart(sheetXmlPath)));
      const drawingTargets = [];
      sheetRels.forEach((rel) => {
        if (/\/drawing$/i.test(rel.type || '') || /(?:^|\/)drawings\/[^/]+\.xml$/i.test(rel.target || '')) {
          drawingTargets.push(rel.target);
        }
      });
      if (!drawingTargets.length) return;

      const sheetCellMap = new Map();
      drawingTargets.forEach((target) => {
        const drawingPath = resolveZipRelative(sheetXmlPath, target);
        const drawingXml = readZipText(drawingPath);
        if (!drawingXml) return;
        const drawingRels = parseXmlRels(readZipText(relsPathForZipPart(drawingPath)));
        const anchorRe = /<(?:\w+:)?(oneCellAnchor|twoCellAnchor)\b[^>]*>([\s\S]*?)<\/(?:\w+:)?\1>/gi;
        let m;
        while ((m = anchorRe.exec(drawingXml)) !== null) {
          const block = m[2];
          const fromMatch = /<(?:\w+:)?from\b[^>]*>([\s\S]*?)<\/(?:\w+:)?from>/i.exec(block);
          const blip = /<(?:\w+:)?blip\b([^>]*)\/?>/i.exec(block);
          if (!fromMatch || !blip) continue;
          const rowM = /<(?:\w+:)?row\b[^>]*>\s*(\d+)\s*<\/(?:\w+:)?row>/i.exec(fromMatch[1]);
          const colM = /<(?:\w+:)?col\b[^>]*>\s*(\d+)\s*<\/(?:\w+:)?col>/i.exec(fromMatch[1]);
          if (!rowM || !colM) continue;
          const embed = readXmlAttr(blip[1], ['r:embed', 'embed']);
          const rel = embed ? drawingRels.get(embed) : null;
          if (!rel || !rel.target) continue;
          const cnv = /<(?:\w+:)?cNvPr\b([^>]*)\/?>/i.exec(block);
          const descr = cnv ? (readXmlAttr(cnv[1], 'descr') || readXmlAttr(cnv[1], 'name')) : '';
          const key = parseInt(rowM[1], 10) + ':' + parseInt(colM[1], 10);
          if (!sheetCellMap.has(key)) sheetCellMap.set(key, []);
          sheetCellMap.get(key).push({ mediaPath: resolveZipRelative(drawingPath, rel.target), descr });
        }
      });
      if (sheetCellMap.size) bySheetCell.set(s.name, sheetCellMap);
    });

    function getUrl(mediaPath) {
      if (!mediaPath) return '';
      const key = normalizeZipPath(mediaPath).toLowerCase();
      if (urlCache.has(key)) return urlCache.get(key);
      const entry = zipMap.get(key);
      const bytes = entry ? toUint8Array(entry.content) : null;
      if (!bytes || !bytes.length) {
        urlCache.set(key, '');
        return '';
      }
      const mime = detectXlsxImageMime(mediaPath, bytes);
      if (!mime) {
        urlCache.set(key, '');
        return '';
      }
      let url = '';
      if (typeof Blob !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
        url = registerBlobUrl(URL.createObjectURL(new Blob([bytes], { type: mime })));
      } else {
        url = 'data:' + mime + ';base64,' + bytesToBase64(bytes);
      }
      urlCache.set(key, url);
      return url;
    }

    return { byId, bySheetCell, getUrl };
  }

  function renderSheetBuffer(buf, filePath) {
    if (!lib.XLSX) throw new Error('xlsx 库未就绪');
    const input = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
    const wb = lib.XLSX.read(input, { type: 'array', bookFiles: true });
    const sheetImages = extractXlsxImages(wb);

    const hiddenMap = new Map();
    if (wb.Workbook && Array.isArray(wb.Workbook.Sheets)) {
      wb.Workbook.Sheets.forEach((s) => {
        if (s && s.name) hiddenMap.set(s.name, s.Hidden);
      });
    }
    const allSheets = wb.SheetNames || [];
    const filteredSheets = allSheets.filter((n) => hiddenMap.get(n) !== 2 && n !== 'WpsReserved_CellImgList');
    const visibleSheets = filteredSheets.length ? filteredSheets : allSheets;

    const c = $('#content');
    c.innerHTML = '<div class="doc-meta">' + escapeHtml(filePath) + '</div>';

    const tabs = document.createElement('div');
    tabs.className = 'sheet-tabs';
    const body = document.createElement('div');
    body.className = 'sheet-body';

    function show(name) {
      const ws = wb.Sheets[name];
      body.innerHTML = '';
      state.lightboxItems = [];
      let imgIndex = 0;

      const anchoredMap = sheetImages.bySheetCell.get(name) || null;
      const hasAnchored = !!(anchoredMap && anchoredMap.size);

      if (!ws || (!ws['!ref'] && !hasAnchored)) {
        body.innerHTML = '<div class="muted">此工作表没有可显示的数据</div>';
      } else {
        try {
          const XLSX = lib.XLSX;
          const baseRange = ws['!ref']
            ? XLSX.utils.decode_range(ws['!ref'])
            : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
          let maxR = baseRange.e.r;
          let maxC = baseRange.e.c;
          if (hasAnchored) {
            anchoredMap.forEach((_, k) => {
              const parts = k.split(':');
              const ar = parseInt(parts[0], 10);
              const ac = parseInt(parts[1], 10);
              if (Number.isFinite(ar) && ar > maxR && ar <= baseRange.e.r + 200) maxR = ar;
              if (Number.isFinite(ac) && ac > maxC && ac <= baseRange.e.c + 50) maxC = ac;
            });
          }

          // blankrows 必须保留：行号要和 !merges 的绝对行号对齐
          const rows = ws['!ref']
            ? XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: true })
            : [];
          const merges = Array.isArray(ws['!merges']) ? ws['!merges'] : [];
          const colCount = maxC - baseRange.s.c + 1;
          const rowCount = maxR - baseRange.s.r + 1;

          // 先记录合并区域，再逐格建 DOM。绝不把 sheet_to_html 的字符串塞进
          // innerHTML：它对 data-v 属性里的双引号不转义，可以逃逸出属性注入 HTML。
          const spans = new Map();
          const covered = new Set();
          merges.forEach((m) => {
            if (!m || !m.s || !m.e) return;
            spans.set(m.s.r + ':' + m.s.c, { rs: m.e.r - m.s.r + 1, cs: m.e.c - m.s.c + 1 });
            for (let r = m.s.r; r <= m.e.r; r++) {
              for (let col = m.s.c; col <= m.e.c; col++) {
                if (r !== m.s.r || col !== m.s.c) covered.add(r + ':' + col);
              }
            }
          });

          function appendSheetImage(td, info, caption, fallbackLabel) {
            const url = info ? sheetImages.getUrl(info.mediaPath) : '';
            if (!url) {
              const miss = document.createElement('span');
              miss.className = 'sheet-img-fallback';
              miss.textContent = '图片无法显示';
              if (fallbackLabel) miss.title = String(fallbackLabel);
              td.appendChild(miss);
              return;
            }
            td.classList.add('sheet-img-cell');
            const img = document.createElement('img');
            img.className = 'sheet-cell-img';
            img.src = url;
            img.alt = caption || '';
            img.loading = imgIndex++ < 6 ? 'eager' : 'lazy';
            img.decoding = 'async';
            img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
            img.addEventListener('error', () => {
              const miss = document.createElement('span');
              miss.className = 'sheet-img-fallback';
              miss.textContent = '图片加载失败';
              if (img.parentNode) img.replaceWith(miss);
            }, { once: true });
            const lbIdx = state.lightboxItems.push({ src: url, caption: caption || '' }) - 1;
            bindZoom(img, lbIdx);
            td.appendChild(img);
          }

          const table = document.createElement('table');
          table.className = 'sheet-table';
          for (let ri = 0; ri < rowCount; ri++) {
            const row = rows[ri];
            const rAbs = baseRange.s.r + ri;
            const tr = document.createElement('tr');
            for (let ci = 0; ci < colCount; ci++) {
              const cAbs = baseRange.s.c + ci;
              const key = rAbs + ':' + cAbs;
              if (covered.has(key)) continue;
              const td = document.createElement('td');
              const val = row ? row[ci] : '';
              const cellAddr = XLSX.utils.encode_cell({ r: rAbs, c: cAbs });
              const rawCell = ws[cellAddr];
              const dispMatch =
                (rawCell && rawCell.f && XLSX_DISPIMG_RE.exec(String(rawCell.f))) ||
                (val != null && XLSX_DISPIMG_RE.exec(String(val)));

              if (dispMatch) {
                const dispId = dispMatch[1];
                const info = sheetImages.byId.get(dispId);
                appendSheetImage(td, info, (info && info.descr) || (name + ' · ' + cellAddr), dispId);
              } else {
                td.textContent = val == null ? '' : String(val);
              }

              if (anchoredMap && anchoredMap.has(key)) {
                anchoredMap.get(key).forEach((item) => {
                  appendSheetImage(td, item, item.descr || (name + ' · ' + cellAddr), item.mediaPath);
                });
              }

              if (rAbs === baseRange.s.r) td.classList.add('sheet-head');
              const sp = spans.get(key);
              if (sp) {
                if (sp.rs > 1) td.rowSpan = sp.rs;
                if (sp.cs > 1) td.colSpan = sp.cs;
              }
              tr.appendChild(td);
            }
            table.appendChild(tr);
          }
          body.appendChild(table);
        } catch (e) {
          body.innerHTML = '<div class="muted">此工作表无法渲染：' + escapeHtml(e.message) + '</div>';
        }
      }
      $$('.sheet-tab', tabs).forEach((t) => t.classList.toggle('active', t.dataset.name === name));
    }

    visibleSheets.forEach((name) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sheet-tab';
      b.dataset.name = name;
      b.textContent = name;
      b.addEventListener('click', () => show(name));
      tabs.appendChild(b);
    });

    c.appendChild(tabs);
    c.appendChild(body);
    if (visibleSheets.length) show(visibleSheets[0]);
    clearToc();
  }

  async function renderSheet(filePath, seq) {
    await ensureLib(['XLSX']);
    if (seq !== openSeq) return;
    if (!lib.XLSX) throw new Error('xlsx 库未就绪');
    const res = await fetch(rawUrl(filePath));
    if (!res.ok) throw Object.assign(new Error('HTTP ' + res.status), { status: res.status, requestUrl: rawUrl(filePath) });
    const buf = await res.arrayBuffer();
    if (seq !== openSeq) return;
    renderSheetBuffer(buf, filePath);
  }

  /* ---------------------------------------------------------------- 图片 / 视频 / 音频 / 不支持 */

  function renderImageFile(filePath, customUrl, displayMeta) {
    const c = $('#content');
    const url = customUrl || rawUrl(filePath);
    c.innerHTML = '<div class="doc-meta">' + escapeHtml(displayMeta || filePath) + '</div>';
    const fig = document.createElement('figure');
    fig.className = 'md-figure';
    const img = document.createElement('img');
    img.src = url;
    img.alt = baseName(filePath);
    img.loading = 'eager';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
    img.addEventListener('error', () => {
      const box = document.createElement('div');
      box.className = 'img-error';
      box.textContent = '图片加载失败：' + filePath;
      if (fig.parentNode) fig.replaceWith(box);
    }, { once: true });
    fig.appendChild(img);
    c.appendChild(fig);
    state.lightboxItems = [{ src: url, caption: baseName(filePath) }];
    bindZoom(img, 0);
    clearToc();
  }

  function renderVideoFile(filePath, customUrl, displayMeta) {
    const c = $('#content');
    const url = customUrl || rawUrl(filePath);
    c.innerHTML = '<div class="doc-meta">' + escapeHtml(displayMeta || filePath) + '</div>';
    const fig = document.createElement('figure');
    fig.className = 'video-embed';
    fig.innerHTML = '<div class="video-frame"><video controls preload="metadata" src="' +
      escapeAttr(url) + '"></video></div>';
    c.appendChild(fig);
    clearToc();
  }

  function renderAudioFile(filePath, customUrl, displayMeta) {
    const c = $('#content');
    const url = customUrl || rawUrl(filePath);
    const name = baseName(filePath);
    const ext = (extOf(filePath) || 'audio').toUpperCase();
    c.innerHTML = '<div class="doc-meta">' + escapeHtml(displayMeta || filePath) + '</div>';
    const fig = document.createElement('figure');
    fig.className = 'audio-embed';
    fig.innerHTML =
      '<div class="audio-card">' +
      '<div class="audio-head">' +
      '<span class="audio-ico" aria-hidden="true">🎵</span>' +
      '<div class="audio-meta">' +
      '<div class="audio-title">' + escapeHtml(name) + '</div>' +
      '<div class="audio-sub">' + escapeHtml(ext) + ' 音频文件</div>' +
      '</div></div>' +
      '<div class="audio-frame"><audio controls preload="metadata" src="' + escapeAttr(url) + '"></audio></div>' +
      '</div>';
    c.appendChild(fig);
    clearToc();
  }

  function renderUnsupported(filePath, title, desc, isLocalPreview) {
    const c = $('#content');
    const actionsHtml = isLocalPreview
      ? '<button class="btn" id="btn-copy-path">复制文件名</button>'
      : '<a class="btn btn-primary" href="' + escapeAttr(rawUrl(filePath)) + '" download>下载文件</a>' +
        '<button class="btn" id="btn-copy-path">复制文件路径</button>';
    c.innerHTML =
      '<div class="card">' +
      '<h3>' + escapeHtml(title) + '</h3>' +
      '<p class="muted">' + escapeHtml(desc) + '</p>' +
      '<p class="muted path-mono">' + escapeHtml(filePath) + '</p>' +
      '<div class="actions">' + actionsHtml + '</div></div>';
    clearToc();
    const cp = $('#btn-copy-path');
    if (cp) {
      cp.addEventListener('click', () => {
        try {
          navigator.clipboard.writeText(filePath);
          toast('路径已复制');
        } catch (_) { toast('复制失败', 'err'); }
      });
    }
  }

  function renderTooLarge(filePath, err, isLocalPreview) {
    const msg = (err && err.data && err.data.error) || (err && err.message) || '文件超过 32 MB 内联预览上限';
    renderUnsupported(
      filePath,
      '文件过大，暂不支持内联预览',
      msg + '。为避免大文件阻塞页面渲染，超过 32 MB 的文本文件请下载或复制路径后用本地编辑器打开。',
      isLocalPreview
    );
  }

  function renderError(err, filePath, onRetry) {
    const c = $('#content');
    const lines = [];
    lines.push('文件：' + filePath);
    if (err && err.requestUrl) lines.push('请求：' + err.requestUrl);
    if (err && err.message) lines.push('原因：' + err.message);
    c.innerHTML =
      '<div class="card err-card">' +
      '<h3>载入失败</h3>' +
      '<pre>' + escapeHtml(lines.join('\n')) + '</pre>' +
      '<div class="actions"><button class="btn" id="btn-retry">重试</button></div>' +
      '</div>';
    clearToc();
    const rb = $('#btn-retry');
    if (rb) {
      rb.addEventListener('click', () => {
        if (onRetry) onRetry();
        else openFile(filePath);
      });
    }
    toast('载入失败：' + (err && err.message ? err.message : '未知错误'), 'err');
  }

  /* ==========================================================================
     双语阅读：逐句翻译，一行英文对应一行中文
     ========================================================================== */

  const bi = {
    mode: 'off', // off | dual | zh
    running: false,
    gen: 0,
    file: null,
    cache: new Map(), // 原文 -> 译文（跨文件复用）
    units: [], // 每一条待翻译的句子/段落
    originals: new Map() // 逐句重排前的原始 HTML，关闭双语时还原
  };

  function updateBilingualButton(done, total) {
    const btn = $('#btn-bilingual');
    if (!btn) return;
    btn.classList.toggle('active', bi.mode !== 'off');
    if (bi.running && total) {
      btn.textContent = '译 ' + done + '/' + total;
    } else if (bi.mode === 'dual') {
      btn.textContent = '双语 ✓';
    } else if (bi.mode === 'zh') {
      btn.textContent = '仅译文';
    } else {
      btn.textContent = '双语';
    }
  }

  function resetBilingual() {
    hideWordTip();
    clearBilingualDom();
    bi.mode = 'off';
    document.body.classList.remove('trans-dual', 'trans-zh');
    document.body.classList.add('trans-off');
    updateBilingualButton();
  }

  function setBilingualMode(mode) {
    if (mode !== 'off' && !state.translatable) {
      toast('当前文件不支持正文双语；PDF 请用页面上的「双语翻译」', 'warn');
      return;
    }
    // 双语会重排正文，正在朗读的节点会失效，先停掉
    if (tts.mode !== 'idle') stopTts();
    bi.mode = mode;
    try { localStorage.setItem(LS.bilingual, mode); } catch (_) { /* ignore */ }
    document.body.classList.remove('trans-off', 'trans-dual', 'trans-zh');
    document.body.classList.add('trans-' + mode);
    updateBilingualButton();
    if (mode === 'off') {
      clearBilingualDom();
      toast('已关闭双语对照');
      return;
    }
    if (mode === 'zh') toast('只显示译文（未翻译的句子仍保留原文）');
    translateCurrent();
  }

  /** 关闭双语时把逐句重排过的正文还原，并清掉所有译文节点 */
  function clearBilingualDom() {
    bi.gen++;
    bi.running = false;
    $$('#content .bi-lines-host').forEach((el) => {
      const html = bi.originals.get(el);
      if (html != null) el.innerHTML = html;
      el.classList.remove('bi-lines-host');
    });
    bi.originals.clear();
    $$('#content .trans-block').forEach((n) => n.remove());
    $$('#content .trans-src-text').forEach((span) => span.replaceWith(...Array.from(span.childNodes)));
    $$('#content .trans-src, #content .trans-host').forEach((el) => {
      el.classList.remove('trans-src', 'trans-host', 'has-trans');
    });
    bi.units = [];
    bi.file = null;
    // 还原后的朗读按钮是 innerHTML 重建的，事件丢了，重新挂一遍
    enhanceTts();
  }

  function wrapSource(el) {
    if (el.querySelector(':scope > .trans-src-text')) return;
    const span = document.createElement('span');
    span.className = 'trans-src-text';
    while (el.firstChild) span.appendChild(el.firstChild);
    el.appendChild(span);
  }

  const RE_KANA = /[぀-ヿ]/;
  const RE_HANGUL = /[가-힯]/;
  const RE_HAN = /[一-鿿]/;
  const RE_ARABIC = /[؀-ۿ]/;
  const RE_DEVANAGARI = /[ऀ-ॿ]/;
  const RE_THAI = /[฀-๿]/;
  const RE_CYRILLIC = /[Ѐ-ӿ]/;
  const RE_LATIN = /[A-Za-zÀ-ÿ]/;

  function hasKana(s) { return RE_KANA.test(s); }
  function hasHangul(s) { return RE_HANGUL.test(s); }
  function hasHan(s) { return RE_HAN.test(s); }
  function hasArabic(s) { return RE_ARABIC.test(s); }
  function hasDevanagari(s) { return RE_DEVANAGARI.test(s); }
  function hasThai(s) { return RE_THAI.test(s); }
  function hasCyrillic(s) { return RE_CYRILLIC.test(s); }
  function hasLatin(s) { return RE_LATIN.test(s); }

  /** 某类字符占这段文字字母总数的比例 */
  function charRatio(text, re) {
    const chars = String(text || '').match(/\p{L}/gu) || [];
    if (!chars.length) return 0;
    let n = 0;
    for (const ch of chars) if (re.test(ch)) n++;
    return n / chars.length;
  }

  function localeForText(text) {
    if (hasKana(text)) return 'ja';
    if (hasHangul(text)) return 'ko';
    if (hasHan(text)) return state.docLang && /^zh-TW/i.test(state.docLang) ? 'zh-TW' : 'zh';
    if (hasArabic(text)) return 'ar';
    if (hasDevanagari(text)) return 'hi';
    if (hasThai(text)) return 'th';
    if (hasCyrillic(text)) return 'ru';
    return state.docLang || 'en';
  }

  function targetLang() {
    return (transCfg && transCfg.targetLang) || 'zh-CN';
  }

  function sourceSetting() {
    return (transCfg && transCfg.sourceLang) || 'auto';
  }

  /**
   * 这段文字已经是目标语言时就不再翻译。
   *
   * 判断必须按「占比」而不是「出现过」：英文段落里夹一个中文词
   * （比如 "使用 Vibe Coding 来写代码"）以前会被整段跳过、永远不出译文。
   */
  function shouldSkipTranslation(text) {
    const t = String(text || '');
    const target = targetLang();
    const han = charRatio(t, RE_HAN);
    const latin = charRatio(t, RE_LATIN);

    if (/^zh/i.test(target)) {
      if (state.docLang === 'ja') return false;
      return han >= 0.5 && han > latin && !hasKana(t) && !hasHangul(t);
    }
    if (target === 'ja') return charRatio(t, RE_KANA) >= 0.2;
    if (target === 'ko') return charRatio(t, RE_HANGUL) >= 0.5;
    if (target === 'ru') return charRatio(t, RE_CYRILLIC) >= 0.5;
    if (target === 'ar') return charRatio(t, RE_ARABIC) >= 0.5;
    if (target === 'hi') return charRatio(t, RE_DEVANAGARI) >= 0.5;
    if (target === 'th') return charRatio(t, RE_THAI) >= 0.5;
    if (target === 'en') return state.docLang === 'en' && latin >= 0.5;
    // 拉丁语系之间只有文档语言正好等于目标语言才跳过
    if (latin >= 0.5) return !!state.docLang && state.docLang === target;
    return false;
  }

  function guessDocLang(text) {
    const s = String(text || '');
    if (hasKana(s)) return 'ja';
    if (hasHangul(s)) return 'ko';
    if (hasHan(s)) return 'zh';
    if (hasArabic(s)) return 'ar';
    if (hasDevanagari(s)) return 'hi';
    if (hasThai(s)) return 'th';
    if (hasCyrillic(s)) return 'ru';
    if (/[ăâđêôơư]/i.test(s)) return 'vi';
    if (/[ğışçöü]/i.test(s)) return 'tr';
    if (/[ąćęłńóśźż]/i.test(s)) return 'pl';
    if (/[äöüß]/.test(s)) return 'de';
    if (/[ãõ]/i.test(s)) return 'pt';
    if (/[ñ¿¡]/.test(s)) return 'es';
    if (/œ/.test(s)) return 'fr';
    if (/[àâçéèêëîïôùûüÿ]/.test(s)) return 'fr';
    return '';
  }

  async function detectDocLanguage(text, fileFor) {
    const targetFile = fileFor || state.currentFile || '';
    const stillCurrent = () => !targetFile || state.currentFile === targetFile;

    const src = sourceSetting();
    if (src && src !== 'auto') {
      if (stillCurrent()) state.docLang = src;
      return src;
    }
    const sample = String(text || '').replace(/\s+/g, ' ').slice(0, 2000);
    if (!sample) return '';

    // 先按文字脚本/变音符号快速判断，让朗读音色立刻正确；再用服务端检测修正
    const guess = guessDocLang(sample);
    if (guess && stillCurrent()) state.docLang = guess;

    try {
      const r = await apiPost('/api/detect', { text: sample });
      // 检测是异步的：期间用户可能已经切换文件，别把语言写到新文档上
      if (r && r.lang && stillCurrent()) state.docLang = r.lang;
    } catch (_) {
      /* 检测失败就保留本地判断 */
    }
    return state.docLang;
  }

  function collectTransBlocks() {
    const sel = '#content p, #content h1, #content h2, #content h3, #content h4, ' +
      '#content li, #content td, #content th, #content figcaption';
    return $$(sel).filter((el) => {
      if (el.closest('.trans-block')) return false;
      if (el.closest('pre, .code-block, .video-embed, .pdf-wrap, .doc-meta, .sheet-tabs, .img-error')) return false;
      if (el.tagName === 'LI' && el.querySelector('p, ul, ol')) return false;
      if (el.querySelector('img, video, iframe, pre')) return false;
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length < 2) return false;
      const letters = (t.match(/\p{L}/gu) || []).length;
      if (letters < 2) return false;
      if (shouldSkipTranslation(t)) return false;
      return true;
    });
  }

  /* ---------------------------- 逐句切分 ---------------------------- */

  /** 把一段英文切成句子，返回相对 textContent 的起止位置 */
  function splitSentences(raw) {
    const text = String(raw || '');
    if (!text.trim()) return [];

    // 先把缩写、小数、人名首字母里的句点保护起来，避免误切
    const protectedText = text
      .replace(/(\d)\.(\d)/g, '$1\u0001$2')
      .replace(/\b([A-Z])\./g, '$1\u0001')
      // 内部带点的缩写要把每个点都保护起来，否则 e.g. 会被切成 e. / g.
      .replace(/\b(e\.g|i\.e|a\.k\.a|Ph\.D)\./gi, (m) => m.replace(/\./g, '\u0001'))
      .replace(
        /\b(et al|Fig|Figs|Eq|Eqs|Sec|Secs|Dr|Mr|Mrs|Ms|vs|cf|approx|No|Ref|Refs|Tab|Alg|etc|Inc|Ltd|Corp)\./gi,
        (m) => m.slice(0, -1) + '\u0001'
      );

    const re = /[^.!?。！？؟۔।॥]+[.!?。！？؟۔।॥]+["'”’)\]]*\s*/g;
    const spans = [];
    let m;
    let last = 0;
    while ((m = re.exec(protectedText)) !== null) {
      spans.push([m.index, m.index + m[0].length]);
      last = m.index + m[0].length;
    }
    if (last < text.length) spans.push([last, text.length]);

    const out = [];
    for (const [a0, b0] of spans) {
      let a = a0;
      let b = b0;
      while (a < b && /\s/.test(text[a])) a++;
      while (b > a && /\s/.test(text[b - 1])) b--;
      if (b > a) out.push({ start: a, end: b, text: text.slice(a, b) });
    }

    // 太短的碎片（比如单独一个编号）并到上一句，避免译文碎成渣
    const merged = [];
    for (const s of out) {
      if (merged.length && (s.text.length < 15 || !/[A-Za-z0-9]/.test(s.text))) {
        const p = merged[merged.length - 1];
        p.end = s.end;
        p.text = text.slice(p.start, p.end).trim();
      } else {
        merged.push(s);
      }
    }
    return merged;
  }

  function textNodeIndex(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let pos = 0;
    while (walker.nextNode()) {
      const n = walker.currentNode;
      const len = (n.nodeValue || '').length;
      if (!len) continue;
      nodes.push({ node: n, start: pos, end: pos + len });
      pos += len;
    }
    return nodes;
  }

  function locateOffset(nodes, offset, isEnd) {
    for (let i = 0; i < nodes.length; i++) {
      const it = nodes[i];
      if (offset < it.end) return { node: it.node, offset: offset - it.start };
      if (offset === it.end) {
        if (isEnd) return { node: it.node, offset: it.node.nodeValue.length };
        if (i + 1 < nodes.length) return { node: nodes[i + 1].node, offset: 0 };
        return { node: it.node, offset: it.node.nodeValue.length };
      }
    }
    const last = nodes[nodes.length - 1];
    return last ? { node: last.node, offset: last.node.nodeValue.length } : null;
  }

  /** 把块拆成「英文行 / 中文行」交替的结构，保留链接、粗体等行内标记 */
  function buildSentenceLines(el, sentences) {
    const nodes = textNodeIndex(el);
    const frags = sentences.map((s) => {
      const a = locateOffset(nodes, s.start, false);
      const b = locateOffset(nodes, s.end, true);
      if (!a || !b) return document.createDocumentFragment();
      try {
        const r = document.createRange();
        r.setStart(a.node, a.offset);
        r.setEnd(b.node, b.offset);
        return r.cloneContents();
      } catch (_) {
        return document.createDocumentFragment();
      }
    });

    const holder = document.createElement('div');
    holder.className = 'bi-lines';
    const lines = [];
    sentences.forEach((s, i) => {
      const en = document.createElement('div');
      en.className = 'bi-en';
      en.appendChild(frags[i]);
      en.appendChild(makeTtsButton(s.text, en));
      const zh = document.createElement('div');
      zh.className = 'bi-zh';
      holder.appendChild(en);
      holder.appendChild(zh);
      lines.push({ text: s.text, zhEl: zh, enEl: en });
    });

    el.innerHTML = '';
    el.appendChild(holder);
    return lines;
  }

  /** 收集这一页所有翻译单元：多句段落拆成逐句，单句/标题保持整块 */
  function collectUnits() {
    const units = [];
    collectTransBlocks().forEach((el) => {
      const raw = el.textContent || '';
      const text = raw.replace(/\s+/g, ' ').trim();
      if (!text) return;

      const isHeading = /^H[1-4]$/.test(el.tagName);
      if (!isHeading) {
        const sentences = splitSentences(raw);
        if (sentences.length > 1) {
          const clean = el.cloneNode(true);
          $$('.tts-block-btn', clean).forEach((n) => n.remove());
          bi.originals.set(el, clean.innerHTML);
          const lines = buildSentenceLines(el, sentences);
          el.classList.add('bi-lines-host');
          lines.forEach((line) => {
            units.push({
              text: line.text,
              zh: '',
              fill: (zh) => {
                line.zhEl.textContent = zh;
                line.zhEl.classList.add('filled');
                // 「仅译文」模式只隐藏已经有译文的英文行：
                // 翻译失败/还没返回的句子仍显示原文，不会变成空白
                if (zh) line.enEl.classList.add('has-trans');
              }
            });
          });
          return;
        }
      }

      const host = el.tagName === 'LI' || el.tagName === 'TD' || el.tagName === 'TH';
      if (host) {
        el.classList.add('trans-src', 'trans-host');
        wrapSource(el);
      } else {
        el.classList.add('trans-src');
      }

      let node = null;
      units.push({
        text: text,
        zh: '',
        fill: (zh) => {
          if (!node) {
            node = document.createElement('span');
            node.className =
              'trans-block' +
              (host ? ' in-host' : '') +
              (el.tagName === 'TD' || el.tagName === 'TH' ? ' in-cell' : '');
            if (host) el.appendChild(node);
            else el.parentNode.insertBefore(node, el.nextSibling);
            el.classList.add('has-trans');
          }
          node.textContent = zh;
        }
      });
    });
    return units;
  }

  async function translateCurrent() {
    if (bi.running) return;
    if (!state.currentFile || !state.translatable) return;
    const file = state.currentFile;

    if (bi.file !== file || !bi.units.length) {
      bi.file = file;
      bi.units = collectUnits();
    }

    const units = bi.units;
    if (!units.length) {
      toast('这一页没有需要翻译的句子');
      return;
    }

    // 先把已经缓存的译文填进去（切换文件回来时立刻可见）
    units.forEach((u) => {
      if (!u.zh) u.zh = bi.cache.get(u.text) || '';
      if (u.zh) u.fill(u.zh);
    });

    const unique = [];
    const seen = Object.create(null);
    units.forEach((u) => {
      if (!seen[u.text]) {
        seen[u.text] = true;
        unique.push(u.text);
      }
    });
    const missing = unique.filter((t) => !bi.cache.has(t));
    const total = unique.length;
    let done = total - missing.length;

    if (!missing.length) {
      updateBilingualButton(total, total);
      return;
    }

    const gen = ++bi.gen;
    bi.running = true;
    updateBilingualButton(done, total);

    let failed = 0;
    try {
      const BATCH = 20;
      for (let i = 0; i < missing.length; i += BATCH) {
        if (gen !== bi.gen) return;
        const part = missing.slice(i, i + BATCH);
        const r = await apiPost('/api/translate', { texts: part });
        const trs = (r && r.translations) || [];
        let got = 0;
        part.forEach((t, j) => {
          const zh = trs[j] ? String(trs[j]).trim() : '';
          if (!zh) {
            failed++;
            return;
          }
          // 译文和原文相同通常意味着服务端没翻（纯数字/公式），不算失败
          if (zh !== t) bi.cache.set(t, zh);
          got++;
        });
        // 只按实际成功条数推进，不要用 part.length 假装全部完成
        done += got;
        if (gen !== bi.gen) return;
        units.forEach((u) => {
          if (!u.zh) u.zh = bi.cache.get(u.text) || '';
          if (u.zh) u.fill(u.zh);
        });
        updateBilingualButton(done, total);
      }
      if (gen === bi.gen) {
        if (failed) {
          toast('双语已生成，但有 ' + failed + ' 句翻译失败，可再次点击「双语」重试', 'warn');
        } else {
          toast('逐句双语已生成，共 ' + total + ' 句');
        }
      }
    } catch (e) {
      if (gen === bi.gen) toast('翻译失败：' + e.message, 'err');
    } finally {
      if (gen === bi.gen) {
        bi.running = false;
        updateBilingualButton(done, total);
      }
    }
  }

  /* ---------------------------------------------------------------- 翻译设置 */

  let transCfg = null;

  function toggleOpenAIBlock() {
    const box = $('#tm-openai');
    if (box) box.hidden = $('#tm-service').value !== 'openai';
  }

  function renderEngineStatus(engine) {
    const st = $('#tm-engine-status');
    const pathEl = $('#tm-engine-path');
    if (!st) return;
    st.className = 'tm-status ' + (engine.available ? 'ok' : 'err');
    st.textContent = engine.available ? '已安装' : '未安装';
    pathEl.textContent = engine.path || '';

    const ts = $('#tm-tts-status');
    if (ts) {
      const ok = !!(engine.tts && engine.tts.available);
      ts.className = 'tm-status ' + (ok ? 'ok' : 'err');
      ts.textContent = ok ? '已安装' : '未安装';
      ts.title = (engine.tts && engine.tts.path) || '';
    }
  }

  async function refreshEngineStatus() {
    try {
      const s = await api('/api/translate/status');
      renderEngineStatus(s.engine);
      return s;
    } catch (_) {
      return null;
    }
  }

  async function openTranslateSettings(autoInstall) {
    let st = null;
    try {
      st = await api('/api/translate/status');
    } catch (e) {
      toast('读取翻译设置失败：' + e.message, 'err');
      return;
    }
    transCfg = st.config;
    const svc = transCfg.service;
    const hasKey = !!(transCfg.openai && transCfg.openai.hasKey);
    $('#tm-service').value = svc === 'openai' || svc === 'google' ? svc : 'bing';
    $('#tm-base').value = (transCfg.openai && transCfg.openai.baseUrl) || '';
    // 接口不再回传明文 Key：留空表示沿用已保存的值
    $('#tm-key').value = '';
    $('#tm-key').placeholder = hasKey ? '已保存（留空表示保持不变）' : 'sk-…（只保存在本机）';
    if ($('#tm-key-state')) {
      $('#tm-key-state').textContent = hasKey
        ? 'Key 已保存，接口不会回传明文。'
        : 'Key 不会通过接口返回，只在本机保存。';
    }
    if ($('#tm-key-clear')) $('#tm-key-clear').disabled = !hasKey;
    $('#tm-model').value = (transCfg.openai && transCfg.openai.model) || '';
    fillLangSelects();
    $('#tm-src-lang').value = transCfg.sourceLang || 'auto';
    if (!$('#tm-src-lang').value) $('#tm-src-lang').value = 'auto';
    $('#tm-tgt-lang').value = transCfg.targetLang || 'zh-CN';
    if (!$('#tm-tgt-lang').value) $('#tm-tgt-lang').value = 'zh-CN';

    const t = transCfg.tts || {};
    $('#tm-voice-en').value = t.voiceEn || 'en-US-AriaNeural';
    if (!$('#tm-voice-en').value) $('#tm-voice-en').value = 'en-US-AriaNeural';
    $('#tm-voice-zh').value = t.voiceZh || 'zh-CN-XiaoxiaoNeural';
    if (!$('#tm-voice-zh').value) $('#tm-voice-zh').value = 'zh-CN-XiaoxiaoNeural';
    $('#tm-datadir').textContent = transCfg.dataDir || '';
    toggleOpenAIBlock();
    renderEngineStatus(st.engine);
    $('#tm-log').hidden = true;
    $('#tm-log').textContent = '';
    $('#trans-modal').hidden = false;
    if (autoInstall && !st.engine.available) startEngineInstall();
  }

  function closeTranslateSettings() {
    $('#trans-modal').hidden = true;
  }

  async function saveTranslateSettings() {
    const oldTarget = (transCfg && transCfg.targetLang) || 'zh-CN';
    const oldSource = (transCfg && transCfg.sourceLang) || 'auto';
    const oldService = (transCfg && transCfg.service) || 'bing';
    const hasKey = !!(transCfg && transCfg.openai && transCfg.openai.hasKey);
    const typedKey = ($('#tm-key').value || '').trim();

    const openaiPatch = {
      baseUrl: ($('#tm-base').value || '').trim(),
      model: ($('#tm-model').value || '').trim()
    };
    // 留空 = 不修改已保存的 Key；要清除请点「清除已保存的 Key」
    if (typedKey) openaiPatch.apiKey = typedKey;

    const patch = {
      sourceLang: $('#tm-src-lang').value || 'auto',
      targetLang: $('#tm-tgt-lang').value || 'zh-CN',
      service: $('#tm-service').value,
      openai: openaiPatch,
      tts: {
        voiceEn: $('#tm-voice-en').value,
        voiceZh: $('#tm-voice-zh').value
      }
    };
    try {
      await apiPost('/api/translate/config', patch);
      transCfg = Object.assign({}, transCfg, patch, {
        openai: {
          baseUrl: openaiPatch.baseUrl,
          model: openaiPatch.model,
          hasKey: hasKey || !!typedKey
        }
      });
      ttsCfg = Object.assign({}, ttsCfg, patch.tts);

      const changedLangOrSvc =
        patch.targetLang !== oldTarget ||
        patch.sourceLang !== oldSource ||
        patch.service !== oldService;
      if (changedLangOrSvc) {
        stopTts();
        bi.cache.clear();
        clearBilingualDom();
        bi.mode = 'off';
        document.body.classList.remove('trans-dual', 'trans-zh');
        document.body.classList.add('trans-off');
        updateBilingualButton();
        state.docLang = '';
        if (patch.sourceLang !== 'auto') state.docLang = patch.sourceLang;
        else detectDocLanguage($('#content').textContent, state.currentFile);
        if (typeof state.onPdfConfigChanged === 'function') {
          state.onPdfConfigChanged();
          toast('翻译设置已保存，请重新点「双语翻译」生成对应译文');
        } else {
          toast('语言设置已保存，重新点「双语」即可生成新译文');
        }
      } else {
        toast('翻译与语音设置已保存');
      }
      closeTranslateSettings();
    } catch (e) {
      toast('保存失败：' + e.message, 'err');
    }
  }

  async function startEngineInstall() {
    const log = $('#tm-log');
    const btn = $('#tm-install');
    const st = $('#tm-engine-status');
    btn.disabled = true;
    log.hidden = false;
    log.textContent = '正在启动安装…';
    st.className = 'tm-status';
    st.textContent = '安装中…';
    try {
      const r = await apiPost('/api/pdf-engine/install');
      pollInstall(r.job.id);
    } catch (e) {
      btn.disabled = false;
      st.className = 'tm-status err';
      st.textContent = '安装失败';
      log.textContent = e.message;
      toast('安装失败：' + e.message, 'err');
    }
  }

  async function pollInstall(jobId) {
    const log = $('#tm-log');
    const btn = $('#tm-install');
    const st = $('#tm-engine-status');
    try {
      const r = await api('/api/pdf-translate/status', { id: jobId });
      log.hidden = false;
      log.textContent = (r.job.log || []).join('\n');
      log.scrollTop = log.scrollHeight;
      if (r.job.status === 'running') {
        st.className = 'tm-status';
        st.textContent = '安装中…';
        setTimeout(() => pollInstall(jobId), 1500);
        return;
      }
      btn.disabled = false;
      if (r.job.status === 'done') {
        st.className = 'tm-status ok';
        st.textContent = '已安装';
        toast('PDF 翻译引擎安装完成');
        refreshEngineStatus();
      } else {
        st.className = 'tm-status err';
        st.textContent = '安装失败';
        toast('安装失败，详情见日志', 'err');
      }
    } catch (e) {
      btn.disabled = false;
      toast('安装状态获取失败：' + e.message, 'err');
    }
  }

  function fillLangSelects() {
    const src = $('#tm-src-lang');
    const tgt = $('#tm-tgt-lang');
    if (src && !src.options.length) {
      src.innerHTML =
        '<option value="auto">自动检测</option>' +
        LANGS.map((l) => '<option value="' + l.code + '">' + escapeHtml(l.name) + '</option>').join('');
    }
    if (tgt && !tgt.options.length) {
      tgt.innerHTML = LANGS.map(
        (l) => '<option value="' + l.code + '">' + escapeHtml(l.name) + '</option>'
      ).join('');
    }
  }

  let translateStatusPromise = null;
  function loadTranslateStatus() {
    if (!translateStatusPromise) {
      translateStatusPromise = api('/api/translate/status')
        .then((s) => {
          if (s && s.config) {
            transCfg = s.config;
            if (s.config.tts) ttsCfg = s.config.tts;
          }
          return s;
        })
        .catch(() => null);
    }
    return translateStatusPromise;
  }

  function initTranslate() {
    document.body.classList.add('trans-off');
    fillLangSelects();
    loadTranslateStatus();

    $('#btn-bilingual').addEventListener('click', () => {
      if (!state.translatable) {
        if (extOf(state.currentFile || '') === 'pdf') {
          toast('PDF 请用页面上的「双语翻译」按钮');
        } else {
          toast('当前文件不支持正文双语');
        }
        return;
      }
      const next = bi.mode === 'off' ? 'dual' : bi.mode === 'dual' ? 'zh' : 'off';
      setBilingualMode(next);
    });

    const btnTransSettings = $('#btn-translate-settings');
    if (btnTransSettings) {
      btnTransSettings.addEventListener('click', () => openTranslateSettings(false));
    }
    $('.tm-close').addEventListener('click', closeTranslateSettings);
    $('.tm-backdrop').addEventListener('click', closeTranslateSettings);
    $('#tm-service').addEventListener('change', toggleOpenAIBlock);
    $('#tm-save').addEventListener('click', saveTranslateSettings);
    $('#tm-install').addEventListener('click', startEngineInstall);

    const clearKeyBtn = $('#tm-key-clear');
    if (clearKeyBtn) {
      clearKeyBtn.addEventListener('click', async () => {
        if (clearKeyBtn.disabled) return;
        try {
          await apiPost('/api/translate/config', { openai: { apiKey: '' } });
          if (transCfg && transCfg.openai) transCfg.openai.hasKey = false;
          $('#tm-key').value = '';
          $('#tm-key').placeholder = 'sk-…（只保存在本机）';
          if ($('#tm-key-state')) $('#tm-key-state').textContent = '已清除保存的 Key。';
          clearKeyBtn.disabled = true;
          toast('已清除保存的 API Key');
        } catch (e) {
          toast('清除失败：' + e.message, 'err');
        }
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('#trans-modal').hidden) closeTranslateSettings();
      if (e.key === 'Escape') hideWordTip();
    });
  }

  /* ==========================================================================
     悬停 / 选词翻译：鼠标在同一个单词上停 2 秒，自动弹出释义
     ========================================================================== */

  const wordTip = {
    timer: null,
    hideTimer: null,
    current: '',
    seq: 0,
    data: null
  };

  function hideWordTip() {
    clearTimeout(wordTip.timer);
    clearTimeout(wordTip.hideTimer);
    wordTip.timer = null;
    wordTip.hideTimer = null;
    wordTip.current = '';
    wordTip.seq++;
    const tip = $('#word-tip');
    if (tip) tip.hidden = true;
  }

  /** 取鼠标位置下面的英文单词；不处理代码、译文和 PDF 区域 */
  function wordAtPoint(x, y) {
    if (!document.caretRangeFromPoint) return null;
    const range = document.caretRangeFromPoint(x, y);
    if (!range || !range.startContainer || range.startContainer.nodeType !== 3) return null;

    const node = range.startContainer;
    const el = node.parentElement;
    if (!el || !el.closest('#content')) return null;
    if (el.closest('pre, code, .code-block, .pdf-wrap, .trans-block, .bi-zh, .doc-meta, .sheet-body, .img-error')) {
      return null;
    }

    const text = node.nodeValue || '';
    let off = Math.max(0, Math.min(range.startOffset, text.length));
    let start = -1;
    let end = -1;
    let word = '';

    // 用 Intl.Segmenter 按语言分词：中文/日文/泰文这类没有空格的语言也能选中词
    try {
      const locale = localeForText(text);
      const seg = new Intl.Segmenter(locale, { granularity: 'word' });
      for (const part of seg.segment(text)) {
        if (part.index <= off && off < part.index + part.segment.length) {
          if (!part.isWordLike) return null;
          start = part.index;
          end = part.index + part.segment.length;
          word = part.segment;
          break;
        }
      }
    } catch (_) {
      /* 老环境没有 Intl.Segmenter，走正则兜底 */
    }

    if (start < 0) {
      const isWordChar = (ch) => /[\p{L}\p{M}'’-]/u.test(ch);
      if (!isWordChar(text[off]) && off > 0 && isWordChar(text[off - 1])) off -= 1;
      start = off;
      end = off;
      while (start > 0 && isWordChar(text[start - 1])) start--;
      while (end < text.length && isWordChar(text[end])) end++;
      word = text.slice(start, end);
    }

    word = word.replace(/^[-'’]+|[-'’]+$/g, '');
    if (!word || !/\p{L}/u.test(word)) return null;

    const r = document.createRange();
    r.setStart(node, start);
    r.setEnd(node, end);
    const rect = r.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return null;
    return { word: word, rect: rect };
  }

  function showWordTip(data, rect) {
    const tip = $('#word-tip');
    wordTip.data = data;
    $('#wt-word').textContent = data.word || '';
    $('#wt-phonetic').textContent = data.phonetic ? '/' + data.phonetic + '/' : '';

    const defs = $('#wt-defs');
    defs.innerHTML = '';
    const meanings = (data.meanings || []).filter(Boolean);
    meanings.forEach((m) => {
      const d = document.createElement('div');
      d.className = 'wt-def';
      d.textContent = m;
      defs.appendChild(d);
    });
    if (!meanings.length) {
      const d = document.createElement('div');
      d.className = 'wt-loading';
      d.textContent = '没有查到释义';
      defs.appendChild(d);
    }

    $('#wt-foot').textContent =
      (data.source === 'youdao' ? '有道词典' : '机器翻译') + ' · 悬停 / 选中 2 秒自动查词';
    tip.hidden = false;

    requestAnimationFrame(() => {
      const w = tip.offsetWidth;
      const h = tip.offsetHeight;
      let left = rect.left + rect.width / 2 - w / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
      let top = rect.bottom + 8;
      if (top + h > window.innerHeight - 8) top = Math.max(8, rect.top - h - 8);
      tip.style.left = left + 'px';
      tip.style.top = top + 'px';
    });

    clearTimeout(wordTip.hideTimer);
    wordTip.hideTimer = setTimeout(hideWordTip, 12000);
  }

  async function lookupWord(text, rect, seq) {
    try {
      const data = await api('/api/dict', { word: text });
      if (seq !== wordTip.seq) return;
      showWordTip(data, rect);
    } catch (_) {
      if (seq !== wordTip.seq) return;
      hideWordTip();
    }
  }

  function scheduleWord(text, rect) {
    if (!text) return;
    if (wordTip.current === text && wordTip.timer) return;
    clearTimeout(wordTip.timer);
    wordTip.current = text;
    const seq = ++wordTip.seq;
    wordTip.timer = setTimeout(() => {
      wordTip.timer = null;
      lookupWord(text, rect, seq);
    }, 2000);
  }

  function initWordTip() {
    const content = $('#content');

    content.addEventListener('mousemove', (e) => {
      const hit = wordAtPoint(e.clientX, e.clientY);
      if (!hit) {
        clearTimeout(wordTip.timer);
        wordTip.timer = null;
        wordTip.current = '';
        return;
      }
      if (hit.word !== wordTip.current) {
        if (!$('#word-tip').hidden) hideWordTip();
        scheduleWord(hit.word, hit.rect);
      }
    });

    content.addEventListener('mouseleave', () => {
      clearTimeout(wordTip.timer);
      wordTip.timer = null;
      wordTip.current = '';
    });

    // 选中一段文字后停 2 秒也翻译（单词或短语）
    content.addEventListener('mouseup', () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;
      const text = sel.toString().replace(/\s+/g, ' ').trim();
      if (!text || text.length > 80) return;
      let rect = null;
      try {
        rect = sel.getRangeAt(0).getBoundingClientRect();
      } catch (_) {
        rect = null;
      }
      if (!rect || (!rect.width && !rect.height)) return;
      scheduleWord(text, rect);
    });

    document.addEventListener('mousedown', (e) => {
      if (!e.target.closest('#word-tip')) hideWordTip();
    });

    window.addEventListener('scroll', hideWordTip, { passive: true });
    $('#wt-close').addEventListener('click', hideWordTip);
  }

  /* ==========================================================================
     语音朗读：单词、句子、整篇文章
     ========================================================================== */

  let ttsCfg = {
    voiceEn: 'en-US-AriaNeural',
    voiceZh: 'zh-CN-XiaoxiaoNeural',
    rate: 0
  };

  const tts = {
    segments: [],
    index: -1,
    mode: 'idle', // idle | article | single
    playing: false,
    paused: false,
    loading: false,
    audio: null,
    audioBaseRate: 1, // 当前音频是按哪个速度合成的
    utterance: null,
    seq: 0,
    rate: 1,
    lastMetric: null
  };

  let activeSpeechSettler = null;
  let prefetchAbort = null;
  let ttsLoadToken = 0;
  let sharedAudioCtx = null;

  function getSharedAudioCtx() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx || typeof fetch !== 'function' || typeof ReadableStream === 'undefined') return null;
    if (!sharedAudioCtx || sharedAudioCtx.state === 'closed') {
      try {
        sharedAudioCtx = new Ctx();
      } catch (_) {
        return null;
      }
    }
    return sharedAudioCtx;
  }

  // PDF 朗读每次都会重新抽取全文；长 PDF 首句要等很久。按路径缓存 30 分钟。
  const pdfTextCache = new Map();
  const PDF_TEXT_TTL = 30 * 60 * 1000;

  function ttsClean(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  /** 把单句拆成不超过 maxLen 的片段：先按子句标点，再按空格/字符硬切 */
  function splitLongPiece(text, maxLen) {
    const s = ttsClean(text);
    if (!s) return [];
    if (s.length <= maxLen) return [s];

    const clauseParts = s
      .split(/([,;，；：:、—]+\s*)/)
      .reduce((acc, part, idx) => {
        if (idx % 2 === 0) {
          if (part) acc.push(part);
        } else if (acc.length) {
          acc[acc.length - 1] += part;
        } else {
          acc.push(part);
        }
        return acc;
      }, [])
      .map((p) => p.trim())
      .filter(Boolean);

    const pieces = [];
    const pushSplitWords = (seg) => {
      let rest = seg.trim();
      while (rest.length > maxLen) {
        let cut = -1;
        const minCut = Math.floor(maxLen * 0.4);
        for (let i = maxLen; i >= minCut; i--) {
          if (/\s/.test(rest[i])) {
            cut = i;
            break;
          }
        }
        if (cut <= 0) cut = maxLen;
        if (cut > 1 && cut < rest.length) {
          const prevCode = rest.charCodeAt(cut - 1);
          const nextCode = rest.charCodeAt(cut);
          if (prevCode >= 0xd800 && prevCode <= 0xdbff && nextCode >= 0xdc00 && nextCode <= 0xdfff) {
            cut -= 1;
          }
        }
        if (cut === 1 && rest.length >= 2) {
          const c0 = rest.charCodeAt(0);
          const c1 = rest.charCodeAt(1);
          if (c0 >= 0xd800 && c0 <= 0xdbff && c1 >= 0xdc00 && c1 <= 0xdfff) {
            cut = 2;
          }
        }
        const head = rest.slice(0, cut).trim();
        if (head) pieces.push(head);
        rest = rest.slice(cut).trim();
      }
      if (rest) pieces.push(rest);
    };

    let buf = '';
    const joinSep = (a, b) =>
      /[A-Za-z0-9,;:\-]$/.test(a) && /^[A-Za-z0-9"'(\[]/.test(b) ? ' ' : '';
    for (const cp of clauseParts) {
      if (cp.length > maxLen) {
        if (buf) {
          pieces.push(buf);
          buf = '';
        }
        pushSplitWords(cp);
        continue;
      }
      if (!buf) {
        buf = cp;
      } else {
        const sep = joinSep(buf, cp);
        if (buf.length + sep.length + cp.length <= maxLen) {
          buf += sep + cp;
        } else {
          pieces.push(buf);
          buf = cp;
        }
      }
    }
    if (buf) pieces.push(buf);
    return pieces;
  }

  /**
   * 段落朗读分块：首块控制得更短（<= firstMax）以快速出声，
   * 后续块按句子打包（<= restMax <= 1000），避免超 1200 字触发 HTTP 400。
   */
  function splitTtsChunks(raw, firstMax, restMax) {
    const q = ttsClean(raw);
    if (!q) return [];
    const fMax = Math.max(40, Math.min(1000, firstMax || 160));
    const rMax = Math.max(80, Math.min(1000, restMax || 800));

    const sents = splitSentences(q).map((s) => ttsClean(s.text)).filter(Boolean);
    if (!sents.length) {
      const first = splitLongPiece(q, fMax);
      if (first.length <= 1) return first;
      return [first[0]].concat(splitLongPiece(first.slice(1).join(' '), rMax));
    }

    if (sents.length > 1 && sents[0].length < 25 && sents[0].length + 1 + sents[1].length <= fMax) {
      sents.splice(0, 2, sents[0] + ' ' + sents[1]);
    }

    const firstPieces = splitLongPiece(sents[0], fMax);
    const chunks = [firstPieces[0]];
    const tailQueue = firstPieces.slice(1).concat(sents.slice(1));

    const flat = [];
    tailQueue.forEach((p) => {
      splitLongPiece(p, rMax).forEach((sub) => flat.push(sub));
    });

    const joinSep = (a, b) =>
      /[A-Za-z0-9.,!?;:'")\]\-]$/.test(a) && /^[A-Za-z0-9"'(\[]/.test(b) ? ' ' : '';
    let cur = '';
    for (const part of flat) {
      if (!cur) {
        cur = part;
        continue;
      }
      const sep = joinSep(cur, part);
      if (cur.length + sep.length + part.length <= rMax) {
        cur += sep + part;
      } else {
        chunks.push(cur);
        cur = part;
      }
    }
    if (cur) chunks.push(cur);
    return chunks;
  }

  function prefetchTtsUrl(text) {
    const q = ttsClean(text);
    if (!q || q.length > 1200) return;
    if (prefetchAbort) {
      try { prefetchAbort.abort(); } catch (_) {}
      prefetchAbort = null;
    }
    try {
      const u = buildUrl('/api/tts', {
        text: q,
        voice: ttsVoiceFor(q),
        rate: ttsRatePercent(),
        lang: state.docLang || ''
      }).toString();
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      prefetchAbort = ctrl;
      fetch(u, ctrl ? { signal: ctrl.signal } : undefined)
        .catch(() => {})
        .finally(() => {
          if (prefetchAbort === ctrl) prefetchAbort = null;
        });
    } catch (_) {
      /* ignore */
    }
  }

  function ttsVoiceFor(text) {
    const s = String(text || '');
    if (hasKana(s)) return VOICE_BY_LANG.ja;
    if (hasHangul(s)) return VOICE_BY_LANG.ko;
    if (hasHan(s)) {
      if (state.docLang && /^zh-TW/i.test(state.docLang)) return VOICE_BY_LANG['zh-TW'];
      return ttsCfg.voiceZh || VOICE_BY_LANG['zh-CN'];
    }
    if (hasArabic(s)) return VOICE_BY_LANG.ar;
    if (hasDevanagari(s)) return VOICE_BY_LANG.hi;
    if (hasThai(s)) return VOICE_BY_LANG.th;
    if (hasCyrillic(s)) return VOICE_BY_LANG.ru;

    const lang = state.docLang || 'en';
    if (lang === 'en') return ttsCfg.voiceEn || VOICE_BY_LANG.en;
    return VOICE_BY_LANG[lang] || VOICE_BY_LANG.en;
  }

  function browserLangFor(text) {
    if (hasKana(text)) return 'ja-JP';
    if (hasHangul(text)) return 'ko-KR';
    if (hasHan(text)) return state.docLang && /^zh-TW/i.test(state.docLang) ? 'zh-TW' : 'zh-CN';
    if (hasArabic(text)) return 'ar-SA';
    if (hasDevanagari(text)) return 'hi-IN';
    if (hasThai(text)) return 'th-TH';
    if (hasCyrillic(text)) return 'ru-RU';
    const map = {
      en: 'en-US',
      fr: 'fr-FR',
      de: 'de-DE',
      es: 'es-ES',
      pt: 'pt-BR',
      it: 'it-IT',
      nl: 'nl-NL',
      pl: 'pl-PL',
      tr: 'tr-TR',
      vi: 'vi-VN',
      id: 'id-ID'
    };
    return map[state.docLang] || 'en-US';
  }

  function ttsRatePercent() {
    return Math.max(-50, Math.min(100, Math.round((tts.rate - 1) * 100)));
  }

  function stopPlayback() {
    tts.seq++;
    if (activeSpeechSettler) {
      const settle = activeSpeechSettler;
      activeSpeechSettler = null;
      settle('cancelled');
    }
    if (prefetchAbort) {
      try { prefetchAbort.abort(); } catch (_) {}
      prefetchAbort = null;
    }
    if (tts.audio) {
      try {
        tts.audio.pause();
        tts.audio.removeAttribute('src');
        tts.audio.load();
      } catch (_) {
        /* ignore */
      }
      tts.audio = null;
    }
    if (window.speechSynthesis) {
      try { window.speechSynthesis.cancel(); } catch (_) {}
    }
    tts.utterance = null;
    return tts.seq;
  }

  function clearTtsCurrent() {
    $$('.tts-current').forEach((el) => el.classList.remove('tts-current'));
  }

  function setTtsCurrent(el) {
    clearTtsCurrent();
    if (!el) return;
    el.classList.add('tts-current');
    const r = el.getBoundingClientRect();
    if (r.top < 80 || r.bottom > window.innerHeight - 150) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  /** 取一段可朗读的英文，去掉译文和朗读按钮 */
  function readableText(el) {
    const clone = el.cloneNode(true);
    $$('.trans-block, .bi-zh, .tts-block-btn', clone).forEach((n) => n.remove());
    return ttsClean(clone.textContent);
  }

  function speakWithBrowser(text, opts) {
    return new Promise((resolve) => {
      if (!window.speechSynthesis || typeof SpeechSynthesisUtterance === 'undefined') {
        resolve({ how: 'none' });
        return;
      }
      const u = new SpeechSynthesisUtterance(text);
      u.lang = browserLangFor(text);
      u.rate = (opts && opts.rateMultiplier) || tts.rate;
      const voices = window.speechSynthesis.getVoices() || [];
      const base = u.lang.split('-')[0].toLowerCase();
      const v = voices.find((x) => String(x.lang || '').toLowerCase().startsWith(base));
      if (v) u.voice = v;
      tts.utterance = u;
      let settled = false;
      const done = (how) => {
        if (!settled) {
          settled = true;
          resolve({ how: how });
        }
      };
      u.onstart = () => {
        if (opts && typeof opts.onStart === 'function') opts.onStart('speech');
      };
      u.onend = () => done('speech');
      u.onerror = () => done('none');
      try {
        window.speechSynthesis.speak(u);
      } catch (_) {
        done('none');
      }
    });
  }

  const MPEG1_BR = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
  const MPEG2_BR = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
  const MPEG1_SR = [44100, 48000, 32000, 0];
  const MPEG2_SR = [22050, 24000, 16000, 0];
  const MPEG25_SR = [11025, 12000, 8000, 0];

  function mp3FrameInfo(bytes, pos) {
    if (pos + 4 > bytes.length) return null;
    if (bytes[pos] !== 0xff || (bytes[pos + 1] & 0xe0) !== 0xe0) return null;
    const ver = (bytes[pos + 1] >> 3) & 0x03;
    const layer = (bytes[pos + 1] >> 1) & 0x03;
    if (ver === 1 || layer !== 1) return null;
    const brIdx = (bytes[pos + 2] >> 4) & 0x0f;
    const srIdx = (bytes[pos + 2] >> 2) & 0x03;
    const pad = (bytes[pos + 2] >> 1) & 0x01;
    if (brIdx === 0 || brIdx === 15 || srIdx === 3) return null;
    const bitrate = (ver === 3 ? MPEG1_BR[brIdx] : MPEG2_BR[brIdx]) * 1000;
    const sr = ver === 3 ? MPEG1_SR[srIdx] : ver === 2 ? MPEG2_SR[srIdx] : MPEG25_SR[srIdx];
    if (!bitrate || !sr) return null;
    const coef = ver === 3 ? 144 : 72;
    const samples = ver === 3 ? 1152 : 576;
    const size = Math.floor((coef * bitrate) / sr) + pad;
    if (size < 4) return null;
    return { size: size, durationSec: samples / sr };
  }

  function extractMp3Frames(bytes, isFinal, checkId3) {
    let pos = 0;
    if (
      checkId3 &&
      bytes.length >= 10 &&
      bytes[0] === 0x49 &&
      bytes[1] === 0x44 &&
      bytes[2] === 0x33
    ) {
      const tagSize =
        ((bytes[6] & 0x7f) << 21) |
        ((bytes[7] & 0x7f) << 14) |
        ((bytes[8] & 0x7f) << 7) |
        (bytes[9] & 0x7f);
      pos = 10 + tagSize;
      if (pos > bytes.length) return { frames: [], consumedEnd: 0, skippedId3: false };
    }
    const startAfterId3 = pos;
    const frames = [];
    while (pos + 4 <= bytes.length) {
      const info = mp3FrameInfo(bytes, pos);
      if (!info) {
        pos++;
        continue;
      }
      const end = pos + info.size;
      if (end > bytes.length) break;
      if (!isFinal) {
        if (end + 4 > bytes.length) break;
        if (!mp3FrameInfo(bytes, end)) {
          pos++;
          continue;
        }
      }
      frames.push({ start: pos, end: end, durationSec: info.durationSec });
      pos = end;
    }
    return { frames: frames, consumedEnd: pos, skippedId3: checkId3 && startAfterId3 > 0 };
  }

  function appendUint8(a, b) {
    if (!a || !a.length) return b;
    if (!b || !b.length) return a;
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  function createWebAudioTtsPlayer(ctx, url, handlers) {
    const abortCtrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let stopped = false;
    let paused = false;
    let startedPlaying = false;
    let streamDone = false;
    let decodingCount = 0;
    let hasDecodedAny = false;
    let currentRate = 1;
    let nextStartTime = 0;
    const scheduled = [];
    const pendingSegments = [];
    let activeError = null;
    let decodeChain = Promise.resolve();

    const cleanupSources = () => {
      while (scheduled.length) {
        const it = scheduled.pop();
        try { it.src.onended = null; } catch (_) {}
        try { it.src.stop(); } catch (_) {}
        try { it.src.disconnect(); } catch (_) {}
      }
      pendingSegments.length = 0;
    };

    const checkFinished = () => {
      if (
        !stopped &&
        !paused &&
        streamDone &&
        decodingCount === 0 &&
        pendingSegments.length === 0 &&
        scheduled.length === 0 &&
        hasDecodedAny
      ) {
        stopped = true;
        if (handlers.onEnded) handlers.onEnded();
      }
    };

    const scheduleSegment = async (seg) => {
      if (stopped) return;
      if (paused) {
        pendingSegments.push(seg);
        return;
      }
      if (ctx.state === 'suspended') {
        try { await ctx.resume(); } catch (_) {}
      }
      if (stopped || paused) {
        if (!stopped && paused) pendingSegments.push(seg);
        return;
      }
      const src = ctx.createBufferSource();
      src.buffer = seg.buffer;
      src.playbackRate.value = currentRate;
      src.connect(ctx.destination);
      const now = ctx.currentTime;
      const when = Math.max(now + 0.005, nextStartTime);
      nextStartTime = when + seg.playDurSec / currentRate;
      const entry = {
        src: src,
        when: when,
        rateChangedAt: when,
        playedBuf: 0,
        offset: seg.skipSec,
        dur: seg.playDurSec,
        buffer: seg.buffer,
        rate: currentRate
      };
      scheduled.push(entry);
      src.onended = () => {
        const idx = scheduled.indexOf(entry);
        if (idx >= 0) scheduled.splice(idx, 1);
        checkFinished();
      };
      try {
        src.start(when, seg.skipSec, seg.playDurSec);
      } catch (e) {
        const idx = scheduled.indexOf(entry);
        if (idx >= 0) scheduled.splice(idx, 1);
        if (!startedPlaying && !stopped) {
          activeError = e;
          stopped = true;
          cleanupSources();
          if (handlers.onFallback) handlers.onFallback(e);
        }
        return;
      }
      if (!startedPlaying) {
        startedPlaying = true;
        if (handlers.onPlaying) handlers.onPlaying();
      }
    };

    const flushPending = async () => {
      while (pendingSegments.length && !stopped && !paused) {
        await scheduleSegment(pendingSegments.shift());
      }
      checkFinished();
    };

    const enqueueDecode = (decodeInput, skipSec) => {
      decodingCount++;
      decodeChain = decodeChain.then(async () => {
        if (stopped) return;
        try {
          const ab = decodeInput.buffer.slice(
            decodeInput.byteOffset,
            decodeInput.byteOffset + decodeInput.byteLength
          );
          const audioBuf = await ctx.decodeAudioData(ab);
          if (stopped) return;
          const playDurSec = Math.max(0, audioBuf.duration - skipSec);
          if (playDurSec > 0) {
            hasDecodedAny = true;
            await scheduleSegment({ buffer: audioBuf, skipSec: skipSec, playDurSec: playDurSec });
          }
        } catch (e) {
          if (!stopped && !startedPlaying) {
            activeError = e;
            stopped = true;
            if (abortCtrl) { try { abortCtrl.abort(); } catch (_) {} }
            cleanupSources();
            if (handlers.onFallback) handlers.onFallback(e);
          }
        } finally {
          decodingCount--;
          checkFinished();
        }
      });
    };

    const applyRate = (newRate) => {
      const clamped = Math.min(4, Math.max(0.25, Number(newRate) || 1));
      if (clamped === currentRate) return;
      currentRate = clamped;
      if (stopped || !scheduled.length) return;
      const now = ctx.currentTime;
      const future = [];
      let cursor = now + 0.005;
      for (let i = 0; i < scheduled.length; i++) {
        const it = scheduled[i];
        if (it.when <= now) {
          if (now > it.rateChangedAt) {
            it.playedBuf += (now - it.rateChangedAt) * it.rate;
            it.rateChangedAt = now;
          }
          const remBuf = Math.max(0, it.dur - it.playedBuf);
          try { it.src.playbackRate.value = clamped; } catch (_) {}
          it.rate = clamped;
          cursor = Math.max(cursor, now + remBuf / clamped);
        } else {
          future.push(it);
        }
      }
      for (const it of future) {
        const idx = scheduled.indexOf(it);
        if (idx >= 0) scheduled.splice(idx, 1);
        try { it.src.onended = null; } catch (_) {}
        try { it.src.stop(); } catch (_) {}
        try { it.src.disconnect(); } catch (_) {}
      }
      nextStartTime = cursor;
      for (const it of future) {
        const src = ctx.createBufferSource();
        src.buffer = it.buffer;
        src.playbackRate.value = clamped;
        src.connect(ctx.destination);
        const when = nextStartTime;
        nextStartTime = when + it.dur / clamped;
        const entry = {
          src: src,
          when: when,
          rateChangedAt: when,
          playedBuf: 0,
          offset: it.offset,
          dur: it.dur,
          buffer: it.buffer,
          rate: clamped
        };
        scheduled.push(entry);
        src.onended = () => {
          const ix = scheduled.indexOf(entry);
          if (ix >= 0) scheduled.splice(ix, 1);
          checkFinished();
        };
        try {
          src.start(when, entry.offset, entry.dur);
        } catch (_) {
          const ix = scheduled.indexOf(entry);
          if (ix >= 0) scheduled.splice(ix, 1);
        }
      }
    };

    const player = {
      src: url,
      currentSrc: url,
      get paused() { return paused; },
      get error() { return activeError; },
      get playbackRate() { return currentRate; },
      set playbackRate(v) { applyRate(v); },
      play: async () => {
        if (stopped) return;
        paused = false;
        if (ctx.state === 'suspended') {
          try { await ctx.resume(); } catch (_) {}
        }
        await flushPending();
      },
      pause: () => {
        if (stopped) return;
        paused = true;
        if (ctx.state === 'running') {
          try { ctx.suspend(); } catch (_) {}
        }
      },
      removeAttribute: (attr) => {
        if (attr === 'src') {
          stopped = true;
          paused = true;
          if (abortCtrl) { try { abortCtrl.abort(); } catch (_) {} }
          cleanupSources();
          if (ctx.state === 'suspended') {
            try { ctx.resume(); } catch (_) {}
          }
        }
      },
      load: () => {}
    };

    (async () => {
      let resp;
      try {
        resp = await fetch(url, abortCtrl ? { signal: abortCtrl.signal } : undefined);
      } catch (e) {
        if (stopped || (e && e.name === 'AbortError')) return;
        activeError = e;
        stopped = true;
        if (handlers.onFallback) handlers.onFallback(e);
        return;
      }
      if (stopped) return;
      if (!resp.ok || !resp.body) {
        const err = new Error('HTTP ' + resp.status);
        activeError = err;
        stopped = true;
        if (handlers.onFatal) handlers.onFatal(err);
        return;
      }

      const reader = resp.body.getReader();
      let pending = new Uint8Array(0);
      let overlapBytes = new Uint8Array(0);
      let overlapSec = 0;
      let firstBatch = true;
      let checkId3 = true;

      try {
        while (!stopped) {
          const step = await reader.read();
          if (step.done) break;
          if (!step.value || !step.value.byteLength) continue;
          pending = appendUint8(pending, step.value);
          const parsed = extractMp3Frames(pending, false, checkId3);
          if (parsed.skippedId3) checkId3 = false;
          const minFrames = firstBatch ? 6 : 16;
          if (parsed.frames.length >= minFrames) {
            const firstStart = parsed.frames[0].start;
            const newSlice = pending.slice(firstStart, parsed.consumedEnd);
            const tailCount = Math.min(2, parsed.frames.length);
            const tailStart = parsed.frames[parsed.frames.length - tailCount].start;
            const nextOverlap = pending.slice(tailStart, parsed.consumedEnd);
            let nextOverlapSec = 0;
            for (let i = parsed.frames.length - tailCount; i < parsed.frames.length; i++) {
              nextOverlapSec += parsed.frames[i].durationSec;
            }
            pending = pending.slice(parsed.consumedEnd);
            checkId3 = false;
            const decodeInput = appendUint8(overlapBytes, newSlice);
            const skipSec = overlapSec;
            overlapBytes = nextOverlap;
            overlapSec = nextOverlapSec;
            firstBatch = false;
            enqueueDecode(decodeInput, skipSec);
          }
        }
      } catch (e) {
        if (stopped || (e && e.name === 'AbortError')) return;
        activeError = e;
        stopped = true;
        cleanupSources();
        if (!startedPlaying && handlers.onFallback) handlers.onFallback(e);
        else if (handlers.onFatal) handlers.onFatal(e);
        return;
      }

      if (stopped) return;
      if (pending.length) {
        const parsed = extractMp3Frames(pending, true, checkId3);
        if (parsed.frames.length) {
          const newSlice = pending.slice(parsed.frames[0].start, parsed.consumedEnd);
          const decodeInput = appendUint8(overlapBytes, newSlice);
          enqueueDecode(decodeInput, overlapSec);
        } else if (!hasDecodedAny) {
          enqueueDecode(pending, 0);
        }
      }
      streamDone = true;
      await decodeChain;
      if (!stopped && !hasDecodedAny) {
        const err = new Error('Empty decoded audio');
        activeError = err;
        stopped = true;
        if (handlers.onFallback) handlers.onFallback(err);
        return;
      }
      checkFinished();
    })();

    return player;
  }

  /** 优先用 Edge 神经语音；失败时退回浏览器自带语音 */
  function playSpeech(text, opts) {
    const o = opts || {};
    const seq = o.seq;
    const voice = o.voice || ttsVoiceFor(text);
    const rate = o.rate != null ? o.rate : ttsRatePercent();
    const onStart = typeof o.onStart === 'function' ? o.onStart : null;
    return new Promise((resolve) => {
      let settled = false;
      let started = false;
      const done = (how) => {
        if (!settled) {
          settled = true;
          if (activeSpeechSettler === done) activeSpeechSettler = null;
          resolve({ how: how });
        }
      };
      activeSpeechSettler = done;

      const fireStart = (how) => {
        if (started || settled || seq !== tts.seq || tts.paused) return;
        started = true;
        if (onStart) {
          try { onStart(how); } catch (_) {}
        }
      };

      // audio.onerror 和 play().catch 可能同时触发：必须只回退一次，
      // 否则两个 SpeechSynthesisUtterance 会同时朗读同一句。
      let fallbackStarted = false;
      const fallback = () => {
        if (fallbackStarted) return;
        fallbackStarted = true;
        if (seq !== tts.seq) {
          done('cancelled');
          return;
        }
        // 音频接口失败后不要继续拿这个 Audio 当播放器
        tts.audio = null;
        speakWithBrowser(text, { rateMultiplier: tts.rate, onStart: fireStart }).then((r) => done(r.how));
      };

      let url;
      try {
        url = buildUrl('/api/tts', {
          text: text,
          voice: voice,
          rate: rate,
          lang: state.docLang || ''
        }).toString();
      } catch (_) {
        fallback();
        return;
      }

      const startHtmlAudio = () => {
        if (settled || seq !== tts.seq) {
          done('cancelled');
          return;
        }
        const audio = new Audio(url);
        audio.preload = 'auto';
        tts.audio = audio;
        tts.audioBaseRate = tts.rate; // 后面调速时用它换算附加倍速
        audio.onplaying = () => fireStart('audio');
        audio.onended = () => done('audio');
        audio.onerror = () => {
          if (seq !== tts.seq) {
            done('cancelled');
            return;
          }
          if (tts.paused) return;
          fallback();
        };
        audio.play().catch(() => {
          if (seq !== tts.seq) {
            done('cancelled');
            return;
          }
          if (tts.paused) {
            return;
          }
          fallback();
        });
      };

      const ctx = getSharedAudioCtx();
      if (ctx) {
        tts.audioBaseRate = tts.rate;
        tts.audio = createWebAudioTtsPlayer(ctx, url, {
          onPlaying: () => fireStart('audio'),
          onEnded: () => done('audio'),
          onFallback: () => {
            if (seq !== tts.seq) {
              done('cancelled');
              return;
            }
            if (tts.paused) return;
            if (started) {
              fallback();
              return;
            }
            startHtmlAudio();
          },
          onFatal: () => {
            if (seq !== tts.seq) {
              done('cancelled');
              return;
            }
            if (tts.paused) return;
            fallback();
          }
        });
        return;
      }

      startHtmlAudio();
    });
  }

  function makeTtsButton(getText, el) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tts-block-btn';
    btn.title = '朗读这一段';
    btn.setAttribute('aria-label', '朗读这一段');
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const text = typeof getText === 'function' ? getText() : getText;
      if (text) speakOne(text, el);
    });
    return btn;
  }

  /** 给正文里的段落/标题/列表项加一个悬停朗读按钮 */
  function enhanceTts() {
    const sel = '#content h1, #content h2, #content h3, #content h4, #content p, #content li, #content figcaption';
    $$(sel).forEach((el) => {
      if (el.closest('.trans-block, .bi-zh, .doc-meta, .code-block, .video-embed, .pdf-wrap, .sheet-tabs, .img-error')) return;
      if (el.querySelector(':scope > .tts-block-btn')) return;
      if (el.querySelector('p, ul, ol, img, video, iframe, pre')) return;
      if (!readableText(el)) return;
      el.appendChild(makeTtsButton(() => readableText(el), el));
    });
  }

  /** 只读一个单词或一段话，不打开播放栏；长段落自动分块、首块开始后预取下一块 */
  async function speakOne(text, el) {
    const q = ttsClean(text);
    if (!q) return;
    const triggerAt = performance.now();
    const chunks = splitTtsChunks(q);
    if (!chunks.length) return;

    const seq = stopPlayback();
    ttsLoadToken++;
    tts.loading = false;
    tts.mode = 'single';
    tts.playing = true;
    tts.paused = false;
    tts.index = -1;
    tts.segments = [];
    tts.lastMetric = {
      mode: 'single',
      textLength: q.length,
      chunks: chunks.length,
      firstChunkLength: chunks[0].length,
      voice: ttsVoiceFor(chunks[0]),
      triggerAt: triggerAt,
      playingAt: 0,
      latencyMs: null,
      how: 'pending'
    };
    setTtsCurrent(el || null);
    const bar = $('#tts-bar');
    if (bar) bar.hidden = true;
    $('#btn-read').classList.remove('active');

    for (let k = 0; k < chunks.length; k++) {
      if (seq !== tts.seq) return;
      const nextChunk = chunks[k + 1];
      const r = await playSpeech(chunks[k], {
        seq: seq,
        onStart: (how) => {
          if (seq !== tts.seq) return;
          if (k === 0 && tts.lastMetric && !tts.lastMetric.playingAt) {
            const now = performance.now();
            tts.lastMetric.playingAt = now;
            tts.lastMetric.latencyMs = Math.round((now - tts.lastMetric.triggerAt) * 100) / 100;
            tts.lastMetric.how = how;
          }
          if (nextChunk) prefetchTtsUrl(nextChunk);
        }
      });
      if (seq !== tts.seq) return;
      if (r.how === 'cancelled') return;
      if (r.how === 'none') {
        if (tts.lastMetric && tts.lastMetric.how === 'pending') tts.lastMetric.how = 'none';
        tts.playing = false;
        clearTtsCurrent();
        toast('语音引擎不可用，请检查网络或在设置里安装语音引擎', 'err');
        return;
      }
      if (k === 0 && tts.lastMetric && tts.lastMetric.how === 'pending') {
        tts.lastMetric.how = r.how;
      }
    }

    if (seq !== tts.seq) return;
    tts.playing = false;
    clearTtsCurrent();
  }

  /** 收集当前文档的朗读分段（PDF 走文本抽取） */
  async function buildArticleSegments() {
    const file = state.currentFile;
    if (!file) return [];
    const segs = [];
    const pushSentence = (raw, extra) => {
      const maxLen = segs.length === 0 ? 160 : 800;
      splitLongPiece(raw, maxLen).forEach((piece) => {
        if (/[A-Za-z一-龥]/.test(piece)) segs.push(Object.assign({ text: piece }, extra || {}));
      });
    };

    if (extOf(file) === 'pdf') {
      let data = null;
      const cached = pdfTextCache.get(file);
      if (cached && Date.now() - cached.at < PDF_TEXT_TTL) data = cached.data;
      if (!data) {
        data = await api('/api/pdf-text', { path: file });
        pdfTextCache.set(file, { data: data, at: Date.now() });
      }
      if (data.lang) state.docLang = data.lang;
      (data.pages || []).forEach((pageText, i) => {
        const text = String(pageText || '')
          .replace(/-\s*\n\s*/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        if (!text) return;
        splitSentences(text).forEach((s) => {
          pushSentence(s.text, { page: i + 1 });
        });
      });
      return segs;
    }

    const sel = '#content h1, #content h2, #content h3, #content h4, #content p, #content li, #content figcaption';
    $$(sel).forEach((el) => {
      if (el.closest('.trans-block, .bi-zh, .doc-meta, .code-block, .video-embed, .pdf-wrap, .sheet-tabs, .img-error')) return;
      if (el.tagName === 'LI' && el.querySelector('p, ul, ol')) return;
      if (el.querySelector('img, video, iframe, pre')) return;

      if (el.classList.contains('bi-lines-host')) {
        $$('.bi-en', el).forEach((en) => {
          const t = ttsClean(en.textContent);
          if (t) pushSentence(t, { el: en });
        });
        return;
      }

      const text = readableText(el);
      if (!text) return;
      splitSentences(text).forEach((s) => {
        pushSentence(s.text, { el: el });
      });
    });
    return segs;
  }

  function updateTtsBar(seg) {
    const bar = $('#tts-bar');
    if (!bar) return;
    bar.hidden = false;
    $('#tts-caption').textContent = seg && seg.text ? seg.text.slice(0, 200) : '';
    $('#tts-count').textContent =
      tts.index >= 0
        ? '第 ' + (tts.index + 1) + ' / ' + tts.segments.length + ' 句' +
          (seg && seg.page ? ' · 第 ' + seg.page + ' 页' : '')
        : '';
    $('#tts-play').textContent = tts.paused ? '▶' : '⏸';
    $('#btn-read').classList.add('active');
  }

  function playSegment(i) {
    if (!tts.segments.length) return;
    if (i < 0 || i >= tts.segments.length) {
      finishArticle();
      return;
    }
    const triggerAt = performance.now();
    const seq = stopPlayback();
    tts.mode = 'article';
    tts.index = i;
    tts.playing = true;
    tts.paused = false;

    const seg = tts.segments[i];
    const next = tts.segments[i + 1];
    tts.lastMetric = {
      mode: 'article',
      index: i,
      textLength: seg.text.length,
      chunks: tts.segments.length,
      firstChunkLength: seg.text.length,
      voice: ttsVoiceFor(seg.text),
      triggerAt: triggerAt,
      playingAt: 0,
      latencyMs: null,
      how: 'pending'
    };

    setTtsCurrent(seg.el || null);
    updateTtsBar(seg);

    playSpeech(seg.text, {
      seq: seq,
      rate: ttsRatePercent(),
      onStart: (how) => {
        if (seq !== tts.seq) return;
        if (tts.lastMetric && !tts.lastMetric.playingAt) {
          const now = performance.now();
          tts.lastMetric.playingAt = now;
          tts.lastMetric.latencyMs = Math.round((now - tts.lastMetric.triggerAt) * 100) / 100;
          tts.lastMetric.how = how;
        }
        // 首句开始播放后再预取下一句，避免抢占首句合成带宽
        if (next) prefetchTtsUrl(next.text);
      }
    }).then((r) => {
      if (seq !== tts.seq) return;
      if (r.how === 'none') {
        if (tts.lastMetric && tts.lastMetric.how === 'pending') tts.lastMetric.how = 'none';
        toast('语音引擎不可用，请检查网络或在设置里安装语音引擎', 'err');
        stopTts();
        return;
      }
      if (tts.mode === 'article' && tts.playing && !tts.paused) {
        playSegment(i + 1);
      }
    });
  }

  function toggleTtsPause() {
    if (tts.mode !== 'article' || !tts.segments.length) {
      startArticle();
      return;
    }
    if (tts.audio) {
      if (tts.paused) {
        tts.paused = false;
        tts.playing = true;
        if (tts.audio.error) {
          playSegment(tts.index);
          return;
        }
        tts.audio.play().catch((err) => {
          if (tts.paused || (err && err.name === 'AbortError')) return;
          if (tts.index >= 0 && tts.mode === 'article') playSegment(tts.index);
        });
      } else {
        tts.paused = true;
        tts.playing = false;
        try { tts.audio.pause(); } catch (_) {}
      }
    } else if (tts.utterance && window.speechSynthesis) {
      if (tts.paused) {
        window.speechSynthesis.resume();
        tts.paused = false;
        tts.playing = true;
      } else {
        window.speechSynthesis.pause();
        tts.paused = true;
        tts.playing = false;
      }
    } else if (tts.index >= 0) {
      playSegment(tts.index);
      return;
    }
    updateTtsBar(tts.segments[tts.index] || null);
  }

  function nextTts(delta) {
    if (!tts.segments.length) return;
    const i = Math.max(0, Math.min(tts.segments.length - 1, tts.index + delta));
    playSegment(i);
  }

  function stopTts() {
    ttsLoadToken++;
    stopPlayback();
    tts.mode = 'idle';
    tts.segments = [];
    tts.index = -1;
    tts.playing = false;
    tts.paused = false;
    tts.loading = false;
    tts.lastMetric = null;
    clearTtsCurrent();
    const bar = $('#tts-bar');
    if (bar) bar.hidden = true;
    const btn = $('#btn-read');
    if (btn) btn.classList.remove('active');
  }

  function finishArticle() {
    stopTts();
    toast('朗读完成');
  }

  async function startArticle() {
    if (tts.loading) return;
    if (tts.mode === 'article' && (tts.playing || tts.paused)) {
      toggleTtsPause();
      return;
    }
    const token = stopPlayback();
    const loadToken = ++ttsLoadToken;
    tts.loading = true;
    tts.lastMetric = null;
    clearTtsCurrent();
    tts.mode = 'article';
    tts.segments = [];
    tts.index = -1;
    tts.playing = false;
    tts.paused = false;

    const bar = $('#tts-bar');
    if (bar) bar.hidden = false;
    $('#tts-caption').textContent = '正在准备语音…';
    $('#tts-count').textContent = '';
    $('#btn-read').classList.add('active');

    try {
      const segs = await buildArticleSegments();
      if (token !== tts.seq) return;
      if (!segs.length) {
        stopTts();
        toast('这一页没有可朗读的文字');
        return;
      }
      tts.segments = segs;
      playSegment(0);
    } catch (e) {
      if (token !== tts.seq) return;
      stopTts();
      if (e.status === 409) {
        toast('PDF 朗读需要先安装 PDF 引擎：顶部菜单「视图 → 翻译设置…」→ 安装 / 修复引擎', 'err');
      } else {
        toast('朗读失败：' + e.message, 'err');
      }
    } finally {
      if (loadToken === ttsLoadToken) tts.loading = false;
    }
  }

  function initTts() {
    loadTranslateStatus();

    $('#btn-read').addEventListener('click', startArticle);
    $('#tts-play').addEventListener('click', toggleTtsPause);
    $('#tts-prev').addEventListener('click', () => nextTts(-1));
    $('#tts-next').addEventListener('click', () => nextTts(1));
    $('#tts-stop').addEventListener('click', stopTts);

    $('#tts-rate').addEventListener('change', () => {
      const v = parseFloat($('#tts-rate').value) || 1;
      tts.rate = v;
      // 已合成的音频不重新请求：用 playbackRate 按比例补偿，立即生效且不打断当前句
      if (tts.audio && tts.audioBaseRate > 0) {
        try {
          tts.audio.playbackRate = Math.min(4, Math.max(0.25, v / tts.audioBaseRate));
        } catch (_) { /* ignore */ }
      }
    });

    $('#wt-speak').addEventListener('click', () => {
      const word = (wordTip.data && wordTip.data.word) || $('#wt-word').textContent;
      if (word) speakOne(word, null);
    });

    window.addEventListener('beforeunload', stopPlayback);
  }

  /* ==========================================================================
     交互：进度条 / 滚动高亮 / 灯箱 / 偏好设置
     ========================================================================== */

  function updateProgress() {
    const doc = document.documentElement;
    const max = doc.scrollHeight - doc.clientHeight;
    const ratio = max > 0 ? (window.scrollY || doc.scrollTop) / max : 0;
    const pct = Math.min(100, Math.max(0, ratio * 100));
    $('#progress > i').style.width = pct.toFixed(2) + '%';
  }

  function updateSpy() {
    if (!state.tocLinks.length) return;
    const offset = 90;
    let current = state.tocLinks[0];
    for (const item of state.tocLinks) {
      const top = item.h.getBoundingClientRect().top;
      if (top - offset <= 1) current = item;
      else break;
    }
    state.tocLinks.forEach((it) => it.a.classList.toggle('active', it === current));
  }

  function onScroll() {
    updateProgress();
    updateSpy();
  }

  /* ---------------------------------------------------------------- 灯箱 */

  function openLightbox(index) {
    if (!state.lightboxItems.length) return;
    state.lightboxIndex = Math.max(0, Math.min(index, state.lightboxItems.length - 1));
    state.scale = 1; state.tx = 0; state.ty = 0;
    paintLightbox();
    $('#lightbox').hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function paintLightbox() {
    const item = state.lightboxItems[state.lightboxIndex];
    if (!item) return;
    const img = $('#lb-img');
    img.src = item.src;
    img.alt = item.caption || '';
    img.style.transform = 'translate(' + state.tx + 'px,' + state.ty + 'px) scale(' + state.scale + ')';
    $('#lb-caption').textContent = item.caption || '';
    $('#lb-count').textContent = (state.lightboxIndex + 1) + ' / ' + state.lightboxItems.length;
  }

  function closeLightbox() {
    $('#lightbox').hidden = true;
    $('#lb-img').src = '';
    document.body.style.overflow = '';
  }

  function stepLightbox(delta) {
    if (!state.lightboxItems.length) return;
    state.lightboxIndex = (state.lightboxIndex + delta + state.lightboxItems.length) % state.lightboxItems.length;
    state.scale = 1; state.tx = 0; state.ty = 0;
    paintLightbox();
  }

  function initLightbox() {
    const lb = $('#lightbox');
    const img = $('#lb-img');

    $('.lb-backdrop', lb).addEventListener('click', closeLightbox);
    $('.lb-close', lb).addEventListener('click', closeLightbox);
    $('.lb-prev', lb).addEventListener('click', (e) => { e.stopPropagation(); stepLightbox(-1); });
    $('.lb-next', lb).addEventListener('click', (e) => { e.stopPropagation(); stepLightbox(1); });

    lb.addEventListener('wheel', (e) => {
      if (lb.hidden) return;
      e.preventDefault();
      state.scale = Math.min(6, Math.max(0.2, state.scale * (e.deltaY < 0 ? 1.12 : 0.89)));
      img.style.transform = 'translate(' + state.tx + 'px,' + state.ty + 'px) scale(' + state.scale + ')';
    }, { passive: false });

    let dragging = false, sx = 0, sy = 0;
    img.addEventListener('mousedown', (e) => {
      dragging = true; sx = e.clientX - state.tx; sy = e.clientY - state.ty;
      img.classList.add('dragging');
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      state.tx = e.clientX - sx;
      state.ty = e.clientY - sy;
      img.style.transform = 'translate(' + state.tx + 'px,' + state.ty + 'px) scale(' + state.scale + ')';
    });
    window.addEventListener('mouseup', () => {
      dragging = false;
      img.classList.remove('dragging');
    });

    document.addEventListener('keydown', (e) => {
      if (lb.hidden) return;
      if (e.key === 'Escape') closeLightbox();
      else if (e.key === 'ArrowLeft') stepLightbox(-1);
      else if (e.key === 'ArrowRight') stepLightbox(1);
    });
  }

  /* ---------------------------------------------------------------- 偏好设置 */

  function applyTheme(theme) {
    document.body.dataset.theme = theme;
    const l = $('#hljs-light'), d = $('#hljs-dark');
    if (l) l.disabled = theme === 'dark';
    if (d) d.disabled = theme !== 'dark';
    localStorage.setItem(LS.theme, theme);
  }

  function applyFont(size) {
    document.documentElement.style.setProperty('--font-size-base', size + 'px');
    const label = $('#font-label');
    if (label) label.textContent = String(size);
    localStorage.setItem(LS.font, String(size));
  }

  function applySystemTextScale(scale) {
    const n = Number(scale);
    const clamped = Number.isFinite(n) && n > 0 ? Math.max(0.8, Math.min(2.25, n)) : 1;
    state.systemTextScale = clamped;
    document.documentElement.style.setProperty('--text-scale', String(clamped));
    if (typeof state.onPdfZoomChanged === 'function') {
      state.onPdfZoomChanged(effectivePdfZoom());
    }
    return clamped;
  }

  function applyPdfZoom(pct, silent) {
    const n = parseInt(pct, 10);
    const val = PDF_ZOOM_STEPS.indexOf(n) >= 0 ? n : 100;
    state.pdfZoom = val;
    try { localStorage.setItem(LS.pdfZoom, String(val)); } catch (_) { /* ignore */ }
    if (typeof state.onPdfZoomChanged === 'function') {
      state.onPdfZoomChanged(effectivePdfZoom());
    }
    if (!silent) {
      toast('PDF 缩放：' + effectivePdfZoom() + '%');
    }
    return val;
  }

  function stepPdfZoom(delta) {
    const cur = parseInt(state.pdfZoom || 100, 10);
    const curIdx = PDF_ZOOM_STEPS.indexOf(cur);
    const baseIdx = curIdx >= 0 ? curIdx : PDF_ZOOM_STEPS.indexOf(100);
    const nextIdx = Math.max(0, Math.min(PDF_ZOOM_STEPS.length - 1, baseIdx + delta));
    const next = PDF_ZOOM_STEPS[nextIdx];
    applyPdfZoom(next, true);
    if (nextIdx === baseIdx) {
      toast((delta > 0 ? '已是最大缩放（' : '已是最小缩放（') + effectivePdfZoom() + '%）');
    } else {
      toast('PDF 缩放：' + effectivePdfZoom() + '%');
    }
    return next;
  }

  function stepFont(delta) {
    if (document.body.classList.contains('pdf-view')) {
      return stepPdfZoom(delta);
    }
    const cur = parseInt(localStorage.getItem(LS.font) || '18', 10);
    const curIdx = FONT_STEPS.indexOf(cur);
    const baseIdx = curIdx >= 0 ? curIdx : FONT_STEPS.indexOf(18);
    const nextIdx = Math.max(0, Math.min(FONT_STEPS.length - 1, baseIdx + delta));
    const next = FONT_STEPS[nextIdx];
    applyFont(next);
    if (nextIdx === baseIdx) {
      toast((delta > 0 ? '已是最大字号（' : '已是最小字号（') + next + 'px）');
    } else {
      toast('字号：' + next + 'px');
    }
    return next;
  }

  function applyWide(wide) {
    document.body.classList.toggle('wide', !!wide);
    localStorage.setItem(LS.wide, wide ? '1' : '0');
  }

  function toggleWide() {
    applyWide(!document.body.classList.contains('wide'));
    toast(document.body.classList.contains('wide') ? '已切换为全宽' : '已切换为阅读宽度');
  }

  function applyTocOff(off) {
    const isOff = !!off;
    document.body.classList.toggle('toc-off', isOff);
    localStorage.setItem(LS.tocOff, isOff ? '1' : '0');
    const btnToc = $('#btn-toc');
    if (btnToc && typeof btnToc.setAttribute === 'function') {
      btnToc.setAttribute('aria-expanded', isOff ? 'false' : 'true');
    }
    const btnExpand = $('#btn-toc-expand');
    if (btnExpand && typeof btnExpand.setAttribute === 'function') {
      btnExpand.setAttribute('aria-expanded', isOff ? 'false' : 'true');
    }
  }

  function initPrefs() {
    const theme = localStorage.getItem(LS.theme) || 'light';
    applyTheme(theme);

    let size = parseInt(localStorage.getItem(LS.font) || '18', 10);
    if (FONT_STEPS.indexOf(size) < 0) size = 18;
    applyFont(size);

    let zoom = parseInt(localStorage.getItem(LS.pdfZoom) || '100', 10);
    if (PDF_ZOOM_STEPS.indexOf(zoom) < 0) zoom = 100;
    state.pdfZoom = zoom;

    const native = window.readerNative;
    if (native && typeof native.systemTextScale === 'function') {
      Promise.resolve(native.systemTextScale())
        .then((s) => applySystemTextScale(s))
        .catch(() => {});
    }

    applyWide(localStorage.getItem(LS.wide) === '1');
    applyTocOff(localStorage.getItem(LS.tocOff) === '1');

    const btnTheme = $('#btn-theme');
    if (btnTheme) {
      btnTheme.addEventListener('click', () => {
        applyTheme(document.body.dataset.theme === 'dark' ? 'light' : 'dark');
      });
    }

    const isNarrowViewport = () => typeof window.innerWidth === 'number' && window.innerWidth <= 780;
    const btnToc = $('#btn-toc');
    if (btnToc) {
      btnToc.addEventListener('click', () => {
        if (isNarrowViewport()) document.body.classList.remove('sidebar-open');
        else applyTocOff(true);
      });
    }
    const btnTocExpand = $('#btn-toc-expand');
    if (btnTocExpand) {
      btnTocExpand.addEventListener('click', () => {
        if (isNarrowViewport()) document.body.classList.toggle('sidebar-open');
        else applyTocOff(false);
      });
    }
  }

  /* ---------------------------------------------------------------- 文件打开 / 视图菜单 */

  function setRoot(dir) {
    syncRootState(dir);
    return Promise.resolve();
  }

  function initNav() {
    const native = window.readerNative;

    // 菜单「打开文件…」、第二个实例、双击关联文件：主进程把路径推过来
    if (native && native.onOpenFile) {
      native.onOpenFile((p) => { if (p) openPath(p); });
    }

    // 菜单「视图」里的阅读控制动作（字号、宽度、翻译设置）
    if (native && native.onViewAction) {
      native.onViewAction((action) => {
        if (action === 'font-inc') stepFont(1);
        else if (action === 'font-dec') stepFont(-1);
        else if (action === 'toggle-width') toggleWide();
        else if (action === 'translate-settings') openTranslateSettings(false);
      });
    }

    // 从资源管理器直接把文件拖进窗口
    window.addEventListener('dragover', (e) => {
      if (!e.dataTransfer) return;
      // 不 preventDefault 的话 Electron 会尝试把文件当页面导航，窗口会白屏
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    window.addEventListener('drop', (e) => {
      const dt = e.dataTransfer;
      if (!dt || !dt.files || !dt.files.length) return;
      e.preventDefault();
      const file = dt.files[0];
      let p = '';
      try {
        p = native && native.pathForFile ? native.pathForFile(file) : '';
      } catch (_) {
        p = '';
      }
      if (p) {
        openPath(p);
        return;
      }
      // 纯浏览器模式无法读取真实路径，直接走本地 File API 预览
      if (file) {
        openWebLocalFile(file);
        return;
      }
      toast('无法读取拖入文件的路径，请改用「文件 → 打开文件…」', 'err');
    });

    // Electron 下「打开文件」与「视图」设置统一在原生导航栏菜单中；
    // 纯浏览器模式没有原生菜单栏，顶栏展示简洁的「打开文件」与「视图 ▾」下拉作为替代。
    const isElectron = Boolean(native && native.isElectron);
    const btnWebOpenFile = $('#btn-web-open-file');
    const webViewMenu = $('#web-view-menu');
    const btnWebViewMenu = $('#btn-web-view-menu');
    const webViewDropdown = $('#web-view-dropdown');
    const btnWebFontInc = $('#btn-web-font-inc');
    const btnWebFontDec = $('#btn-web-font-dec');
    const btnWebWidth = $('#btn-web-width');
    const btnWebTranslateSettings = $('#btn-web-translate-settings');
    const webFileInput = $('#web-file-input');

    const closeWebViewMenu = () => {
      if (webViewDropdown) webViewDropdown.hidden = true;
      if (btnWebViewMenu && typeof btnWebViewMenu.setAttribute === 'function') {
        btnWebViewMenu.setAttribute('aria-expanded', 'false');
      }
    };

    if (btnWebOpenFile) btnWebOpenFile.hidden = isElectron;
    if (webViewMenu) webViewMenu.hidden = isElectron;

    if (!isElectron) {
      if (btnWebOpenFile) {
        btnWebOpenFile.addEventListener('click', () => {
          closeWebViewMenu();
          if (webFileInput) {
            webFileInput.value = '';
            webFileInput.click();
          }
        });
      }
      if (webViewMenu && btnWebViewMenu && webViewDropdown) {
        btnWebViewMenu.addEventListener('click', (e) => {
          e.stopPropagation();
          const nextOpen = Boolean(webViewDropdown.hidden);
          webViewDropdown.hidden = !nextOpen;
          if (typeof btnWebViewMenu.setAttribute === 'function') {
            btnWebViewMenu.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
          }
        });
        if (btnWebFontInc) {
          btnWebFontInc.addEventListener('click', () => { closeWebViewMenu(); stepFont(1); });
        }
        if (btnWebFontDec) {
          btnWebFontDec.addEventListener('click', () => { closeWebViewMenu(); stepFont(-1); });
        }
        if (btnWebWidth) {
          btnWebWidth.addEventListener('click', () => { closeWebViewMenu(); toggleWide(); });
        }
        if (btnWebTranslateSettings) {
          btnWebTranslateSettings.addEventListener('click', () => {
            closeWebViewMenu();
            openTranslateSettings(false);
          });
        }
        document.addEventListener('click', (e) => {
          if (webViewDropdown.hidden) return;
          if (typeof webViewMenu.contains === 'function' && webViewMenu.contains(e.target)) return;
          closeWebViewMenu();
        });
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape' && !webViewDropdown.hidden) closeWebViewMenu();
        });
      }
    }
    if (webFileInput) {
      webFileInput.addEventListener('change', () => {
        const f = webFileInput.files && webFileInput.files[0];
        if (f) openWebLocalFile(f);
      });
    }
  }

  /* ==========================================================================
     图片加载等待 + 统计（供自动化验收使用）
     ========================================================================== */

  /**
   * 只等首屏/已经开始的图片。
   * 以前等全部图片、超时 25 秒：一张远程图挂住，整页恢复阅读位置就要卡 25 秒。
   */
  function settleImages(timeout) {
    const all = $$('#content img');
    const nearViewport = window.innerHeight * 1.5;
    const imgs = all.filter((img) => {
      if (img.loading !== 'lazy' || img.complete) return true;
      const r = img.getBoundingClientRect();
      return r.top < nearViewport;
    });
    if (!imgs.length) return Promise.resolve();
    const limit = timeout || 4000;
    return new Promise((resolve) => {
      let left = imgs.length;
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      const timer = setTimeout(finish, limit);
      const tick = () => { if (--left <= 0) { clearTimeout(timer); finish(); } };
      imgs.forEach((img) => {
        if (img.complete) { tick(); return; }
        img.addEventListener('load', tick, { once: true });
        img.addEventListener('error', tick, { once: true });
      });
    });
  }

  /* ==========================================================================
     文档内查找（Ctrl+F）
     用 CSS Custom Highlight API 标记命中，不改 DOM，因此不会干扰双语、
     朗读高亮和滚动位置。
     ========================================================================== */

  const findState = { ranges: [], index: -1, query: '' };
  let findTimer = null;

  function findSupported() {
    return typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight !== 'undefined';
  }

  function clearFind(hideBar) {
    findState.ranges = [];
    findState.index = -1;
    findState.query = '';
    if (findSupported()) {
      CSS.highlights.delete('find-all');
      CSS.highlights.delete('find-current');
    }
    const input = $('#find-input');
    if (input) input.value = '';
    const count = $('#find-count');
    if (count) count.textContent = '';
    if (hideBar) {
      const bar = $('#find-bar');
      if (bar) bar.hidden = true;
    }
  }

  function collectFindRanges(query) {
    const root = $('#content');
    const q = String(query || '').toLowerCase();
    if (!root || !q) return [];
    const ranges = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && ranges.length < 2000) {
      const pe = node.parentElement;
      if (pe && pe.closest('.bi-zh, .trans-block, .doc-meta, .tts-block-btn, .code-copy')) {
        node = walker.nextNode();
        continue;
      }
      const text = node.nodeValue || '';
      const lower = text.toLowerCase();
      let from = 0;
      for (;;) {
        const at = lower.indexOf(q, from);
        if (at < 0) break;
        const r = document.createRange();
        try {
          r.setStart(node, at);
          r.setEnd(node, at + q.length);
          ranges.push(r);
        } catch (_) {
          break;
        }
        from = at + q.length;
        if (ranges.length >= 2000) break;
      }
      node = walker.nextNode();
    }
    return ranges;
  }

  function paintFind() {
    if (!findSupported()) return;
    CSS.highlights.delete('find-all');
    CSS.highlights.delete('find-current');
    if (!findState.ranges.length) return;
    CSS.highlights.set('find-all', new Highlight(...findState.ranges));
    const cur = findState.ranges[findState.index];
    if (cur) CSS.highlights.set('find-current', new Highlight(cur));
  }

  function updateFindCount() {
    const el = $('#find-count');
    if (!el) return;
    const n = findState.ranges.length;
    el.textContent = n ? (findState.index + 1) + '/' + n : '0/0';
  }

  function scrollToFindRange(r) {
    if (!r) return;
    const rect = r.getBoundingClientRect();
    const top = window.scrollY + rect.top - window.innerHeight * 0.35;
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }

  function jumpFind(delta) {
    const n = findState.ranges.length;
    if (!n) return;
    findState.index = (findState.index + delta + n) % n;
    paintFind();
    updateFindCount();
    scrollToFindRange(findState.ranges[findState.index]);
  }

  function runFind(query) {
    findState.query = String(query || '');
    findState.ranges = collectFindRanges(findState.query);
    findState.index = findState.ranges.length ? 0 : -1;
    paintFind();
    updateFindCount();
    if (findState.index >= 0) scrollToFindRange(findState.ranges[0]);
  }

  function openFind() {
    if (!findSupported()) {
      toast('当前 Electron 版本不支持文档内高亮查找', 'err');
      return;
    }
    const bar = $('#find-bar');
    const input = $('#find-input');
    if (!bar || !input) return;
    bar.hidden = false;
    input.focus();
    input.select();
    if (input.value.trim()) runFind(input.value.trim());
  }

  function closeFind() {
    clearFind(true);
  }

  function initFind() {
    const bar = $('#find-bar');
    const input = $('#find-input');
    if (!bar || !input) return;

    input.addEventListener('input', () => {
      clearTimeout(findTimer);
      findTimer = setTimeout(() => runFind(input.value.trim()), 120);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        jumpFind(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeFind();
      }
    });

    const prev = $('#find-prev');
    const next = $('#find-next');
    const close = $('#find-close');
    if (prev) prev.addEventListener('click', () => jumpFind(-1));
    if (next) next.addEventListener('click', () => jumpFind(1));
    if (close) close.addEventListener('click', closeFind);

    document.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && String(e.key).toLowerCase() === 'f') {
        e.preventDefault();
        openFind();
        return;
      }
      if (e.key === 'F3') {
        e.preventDefault();
        if (bar.hidden) openFind();
        else jumpFind(e.shiftKey ? -1 : 1);
        return;
      }
      if (e.key === 'Escape' && !bar.hidden) closeFind();
    });
  }

  function updateStats() {
    const c = $('#content');
    const imgs = $$('img', c);
    window.__reader.stats = {
      file: state.currentFile,
      imgs: imgs.length,
      // 只把“已加载完但解码失败”算坏图；懒加载还没开始的不算
      broken: imgs.filter((i) => i.complete && i.naturalWidth === 0).length,
      pending: imgs.filter((i) => !i.complete).length,
      imgErrors: $$('.img-error', c).length,
      tocItems: $$('#toc a').length,
      codeBlocks: $$('pre', c).length,
      copyButtons: $$('button.code-copy', c).length,
      videoEmbeds: $$('iframe[src*="player.bilibili.com"], iframe[src*="youtube.com/embed"]', c).length,
      treeFiles: 0,
      mdFiles: 0,
      translations: $$('.trans-block', c).length,
      bilingualMode: bi.mode,
      progress: $('#progress > i').style.width,
      theme: document.body.dataset.theme,
      rects: {
        imgs: imgs.length,
        first: imgs.length ? { complete: imgs[0].complete, nw: imgs[0].naturalWidth, src: imgs[0].currentSrc || imgs[0].src } : null,
        last: imgs.length ? { complete: imgs[imgs.length - 1].complete, nw: imgs[imgs.length - 1].naturalWidth } : null
      }
    };
    return window.__reader.stats;
  }

  /* ==========================================================================
     启动
     ========================================================================== */

  async function boot() {
    initPrefs();
    initLightbox();
    initNav();
    initTranslate();
    initWordTip();
    initTts();
    initFind();
    initVideoProgress();
    renderContinue();

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    window.addEventListener('beforeunload', () => {
      if (state.currentFile && !state.isWebLocalFile) saveScroll(state.currentFile);
      revokeActiveBlobUrl();
    });

    // 启动时服务可能还在监听端口：失败自动重试 3 次，再给出可点击的重试按钮，
    // 而不是把页面永久停在“载入失败”。
    let configErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        state.config = await api('/api/config');
        configErr = null;
        break;
      } catch (e) {
        configErr = e;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
      }
    }
    if (configErr) {
      renderError(configErr, '(无法连接本地服务 /api/config)', () => location.reload());
      return;
    }

    let lastRoot = '';
    let lastFile = '';
    try {
      lastRoot = localStorage.getItem(LS.lastRoot) || '';
      lastFile = localStorage.getItem(LS.lastFile) || '';
    } catch (_) {
      /* 隐私模式下 localStorage 可能不可用 */
    }
    // 双击关联文件 / 右键「打开方式」/ 命令行启动带的文件，优先级最高
    let launchFile = '';
    const native = window.readerNative;
    if (native && native.initialFile) {
      try {
        launchFile = (await native.initialFile()) || '';
      } catch (_) {
        launchFile = '';
      }
    }

    if (!lastRoot && lastFile) lastRoot = dirOf(lastFile);
    if (launchFile) lastRoot = dirOf(launchFile);

    syncRootState(lastRoot || state.config.defaultRoot);
    if (!state.currentFile) state.currentFile = launchFile || lastFile || '';

    // 优先打开启动参数里的文件，否则回到上次读的文件；它不在了再退回默认文件
    const fallback = state.config.defaultFile;
    const target = launchFile || lastFile || fallback;
    if (target) {
      let opened = await openFile(target);
      if (!opened && fallback && target !== fallback) {
        try { localStorage.removeItem(LS.lastFile); } catch (_) { /* ignore */ }
        opened = await openFile(fallback);
      } else if (!opened) {
        // 上次读的文件被移走/删掉了：别再停在「载入失败」，回到欢迎页
        try { localStorage.removeItem(LS.lastFile); } catch (_) { /* ignore */ }
        showWelcome();
      }
    } else {
      showWelcome();
    }
  }

  /** 没有可打开的文件时的首页；也用于清理失效的「上次阅读」 */
  function showWelcome() {
    document.body.classList.remove('pdf-view');
    state.onPdfZoomChanged = null;
    state.onPdfConfigChanged = null;
    state.currentFile = '';
    const crumb = $('#crumb');
    if (crumb) {
      crumb.innerHTML = '';
      crumb.title = '';
    }
    clearToc('打开文档后显示目录');
    $('#content').innerHTML = '<div class="welcome"><h1>FolioPrism <span class="brand-zh">棱阅</span></h1>' +
      '<p class="muted">请通过顶部菜单「文件 → 打开文件…」（Ctrl+O）、拖拽文件到窗口，或从左侧「继续阅读」打开文档。</p></div>';
    window.__reader.ready = true;
    updateStats();
  }

  window.__reader = {
    ready: false,
    stats: null,
    state: state,
    formats: formats,
    openFile: function (p) { return openFile(p); },
    openLocalFile: function (file) { return openWebLocalFile(file); },
    reload: function () { return state.currentFile && !state.isWebLocalFile ? openFile(state.currentFile) : Promise.resolve(); },
    setRoot: function (p) { return setRoot(p); },
    refreshStats: updateStats,
    bilingual: {
      mode: function () { return bi.mode; },
      setMode: function (m) { setBilingualMode(m); },
      translate: function () { return translateCurrent(); }
    },
    openTranslateSettings: openTranslateSettings,
    stepFont: stepFont,
    stepPdfZoom: stepPdfZoom,
    applySystemTextScale: applySystemTextScale,
    tts: {
      state: tts,
      get lastMetric() { return tts.lastMetric; },
      splitChunks: splitTtsChunks,
      start: startArticle,
      stop: stopTts,
      speak: speakOne
    },
    lib: lib
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();

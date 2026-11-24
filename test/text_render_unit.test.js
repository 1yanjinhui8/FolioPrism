'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const http = require('node:http');
const vm = require('node:vm');

const ROOT_DIR = path.resolve(__dirname, '..');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmrf(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
}

function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: 'GET', agent: false },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/* ------------------------------------------------------------------ */
/* 1. 轻量 DOM 沙箱：验证 wrapPre / enhanceCode / renderTextFile       */
/* ------------------------------------------------------------------ */

function parseAttrMap(raw) {
  const attrs = {};
  const re = /([A-Za-z0-9_-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    attrs[m[1].toLowerCase()] = m[2] != null ? m[2] : m[3] != null ? m[3] : m[4] != null ? m[4] : '';
  }
  return attrs;
}

function decodeBasicEntities(s) {
  return String(s || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function createDomHarness(opts) {
  const o = opts || {};
  const formatsCode = fs.readFileSync(path.join(ROOT_DIR, 'public', 'formats.js'), 'utf8');
  const code = fs.readFileSync(path.join(ROOT_DIR, 'public', 'app.js'), 'utf8');
  const hljsCalls = [];

  class MockElement {
    constructor(tag, id) {
      this.tagName = String(tag || 'DIV').toUpperCase();
      this.id = id || '';
      this.parentNode = null;
      this.childNodes = [];
      this._text = '';
      this._classSet = new Set();
      this.style = {};
      this.dataset = {};
      this.listeners = {};
      this.hidden = false;
      this.value = '';
      this.title = '';
      this.disabled = false;
      this.options = [];
      this.attributes = {};
      this.classList = {
        add: (...cls) => cls.forEach((c) => c && this._classSet.add(c)),
        remove: (...cls) => cls.forEach((c) => this._classSet.delete(c)),
        contains: (c) => this._classSet.has(c),
        toggle: (c, f) => {
          if (f === undefined) {
            if (this._classSet.has(c)) this._classSet.delete(c);
            else this._classSet.add(c);
          } else if (f) this._classSet.add(c);
          else this._classSet.delete(c);
        },
      };
    }
    get className() {
      return Array.from(this._classSet).join(' ');
    }
    set className(val) {
      this._classSet = new Set(String(val || '').split(/\s+/).filter(Boolean));
    }
    get children() {
      return this.childNodes;
    }
    get parentElement() {
      return this.parentNode;
    }
    get nextSibling() {
      if (!this.parentNode) return null;
      const list = this.parentNode.childNodes;
      const idx = list.indexOf(this);
      return idx >= 0 && idx + 1 < list.length ? list[idx + 1] : null;
    }
    get firstChild() {
      return this.childNodes[0] || null;
    }
    get textContent() {
      if (this.childNodes.length) return this.childNodes.map((c) => c.textContent).join('');
      return this._text;
    }
    set textContent(v) {
      this.childNodes = [];
      this._text = String(v == null ? '' : v);
    }
    get innerText() {
      return this.textContent;
    }
    set innerText(v) {
      this.textContent = v;
    }
    get innerHTML() {
      return this.childNodes
        .map((c) => `<${c.tagName.toLowerCase()} class="${c.className}">${c.innerHTML}</${c.tagName.toLowerCase()}>`)
        .join('') || this._text;
    }
    set innerHTML(html) {
      this.childNodes = [];
      this._text = '';
      parseFragmentInto(this, String(html || ''));
    }
    appendChild(child) {
      if (child.parentNode) child.remove();
      child.parentNode = this;
      this.childNodes.push(child);
      return child;
    }
    insertBefore(newNode, refNode) {
      if (!refNode) return this.appendChild(newNode);
      const idx = this.childNodes.indexOf(refNode);
      if (idx < 0) return this.appendChild(newNode);
      if (newNode.parentNode) newNode.remove();
      newNode.parentNode = this;
      // refNode 可能因 newNode 在同一父节点前移而调整位置
      const nextIdx = this.childNodes.indexOf(refNode);
      this.childNodes.splice(nextIdx >= 0 ? nextIdx : this.childNodes.length, 0, newNode);
      return newNode;
    }
    remove() {
      if (!this.parentNode) return;
      const idx = this.parentNode.childNodes.indexOf(this);
      if (idx >= 0) this.parentNode.childNodes.splice(idx, 1);
      this.parentNode = null;
    }
    addEventListener(ev, fn) {
      (this.listeners[ev] = this.listeners[ev] || []).push(fn);
    }
    dispatchEvent(ev) {
      (this.listeners[ev.type] || []).forEach((fn) => fn(ev));
    }
    click() {
      this.dispatchEvent({ type: 'click', preventDefault() {}, stopPropagation() {} });
    }
    setAttribute(k, v) {
      this.attributes[k] = String(v);
      if (k === 'id') this.id = String(v);
      if (k === 'class') this.className = String(v);
    }
    getAttribute(k) {
      if (k === 'id') return this.id || null;
      if (k === 'class') return this.className || null;
      return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null;
    }
    hasAttribute(k) {
      return this.getAttribute(k) !== null;
    }
    removeAttribute(k) {
      delete this.attributes[k];
    }
    cloneNode(deep) {
      const c = new MockElement(this.tagName, this.id);
      c.className = this.className;
      c._text = this._text;
      if (deep) {
        for (const ch of this.childNodes) c.appendChild(ch.cloneNode(true));
      }
      return c;
    }
    closest(selList) {
      const parts = String(selList).split(',').map((s) => s.trim()).filter(Boolean);
      let cur = this;
      while (cur) {
        if (parts.some((p) => matchSimpleSelector(cur, p))) return cur;
        cur = cur.parentNode;
      }
      return null;
    }
    querySelectorAll(selList) {
      const out = [];
      const seen = new Set();
      const parts = String(selList).split(',').map((s) => s.trim()).filter(Boolean);
      for (const part of parts) {
        if (part.startsWith(':scope > ')) {
          const childSel = part.slice(':scope > '.length).trim();
          for (const ch of this.childNodes) {
            if (matchSimpleSelector(ch, childSel) && !seen.has(ch)) {
              seen.add(ch);
              out.push(ch);
            }
          }
          continue;
        }
        const tokens = part.split(/\s+/).filter(Boolean);
        walk(this, (node) => {
          if (node === this) return;
          if (matchDescendantChain(node, tokens, this) && !seen.has(node)) {
            seen.add(node);
            out.push(node);
          }
        });
      }
      return out;
    }
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    }
    getBoundingClientRect() {
      return { top: 100, bottom: 150 };
    }
    scrollIntoView() {}
  }

  function walk(root, fn) {
    for (const ch of root.childNodes) {
      fn(ch);
      walk(ch, fn);
    }
  }

  function matchSimpleSelector(el, sel) {
    if (!el || !sel) return false;
    let rest = sel;
    const idMatch = /#([A-Za-z0-9_-]+)/.exec(rest);
    if (idMatch) {
      if (el.id !== idMatch[1]) return false;
      rest = rest.replace(idMatch[0], '');
    }
    const classes = [];
    rest = rest.replace(/\.([A-Za-z0-9_-]+)/g, (_, cls) => {
      classes.push(cls);
      return '';
    });
    const tag = rest.trim();
    if (tag && tag !== '*' && el.tagName !== tag.toUpperCase()) return false;
    for (const cls of classes) {
      if (!el._classSet.has(cls)) return false;
    }
    return true;
  }

  function matchDescendantChain(node, tokens, scopeRoot) {
    if (!tokens.length || !matchSimpleSelector(node, tokens[tokens.length - 1])) return false;
    let ti = tokens.length - 2;
    let cur = node.parentNode;
    while (ti >= 0 && cur) {
      if (matchSimpleSelector(cur, tokens[ti])) ti--;
      if (cur === scopeRoot) break;
      cur = cur.parentNode;
    }
    return ti < 0;
  }

  function parseFragmentInto(root, html) {
    const stack = [root];
    const tokenRe = /<\/?([A-Za-z][A-Za-z0-9]*)\b([^>]*)>|([^<]+)/g;
    let m;
    while ((m = tokenRe.exec(html)) !== null) {
      const top = stack[stack.length - 1];
      if (m[3] != null) {
        const txt = decodeBasicEntities(m[3]);
        if (!top.childNodes.length) top._text += txt;
        continue;
      }
      const full = m[0];
      const tag = m[1];
      const rawAttrs = m[2] || '';
      if (full.startsWith('</')) {
        for (let i = stack.length - 1; i >= 1; i--) {
          if (stack[i].tagName === tag.toUpperCase()) {
            stack.length = i;
            break;
          }
        }
        continue;
      }
      const el = new MockElement(tag);
      const attrs = parseAttrMap(rawAttrs);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      top.appendChild(el);
      if (!/\/\s*>$/.test(full) && !/^(br|hr|img|input)$/i.test(tag)) {
        stack.push(el);
      }
    }
  }

  const rootDoc = new MockElement('HTML');
  const body = new MockElement('BODY');
  rootDoc.appendChild(body);
  const fixedIds = {
    content: new MockElement('ARTICLE', 'content'),
    toc: new MockElement('NAV', 'toc'),
    crumb: new MockElement('SPAN', 'crumb'),
    toast: new MockElement('DIV', 'toast'),
    progress: new MockElement('DIV', 'progress'),
    'root-input': new MockElement('INPUT', 'root-input'),
    tree: new MockElement('DIV', 'tree'),
    recent: new MockElement('DIV', 'recent'),
    continue: new MockElement('DIV', 'continue'),
    'font-label': new MockElement('SPAN', 'font-label'),
  };
  const progBar = new MockElement('I');
  fixedIds.progress.appendChild(progBar);
  const lightbox = new MockElement('DIV', 'lightbox');
  lightbox.hidden = true;
  ['lb-backdrop', 'lb-close', 'lb-prev', 'lb-next'].forEach((cls) => {
    const child = new MockElement('DIV');
    child.className = cls;
    lightbox.appendChild(child);
  });
  lightbox.appendChild(new MockElement('IMG', 'lb-img'));
  fixedIds.lightbox = lightbox;
  Object.values(fixedIds).forEach((el) => body.appendChild(el));

  const fallbackBySelector = new Map();
  function queryInDoc(selList) {
    const first = rootDoc.querySelector(selList);
    if (first) return first;
    if (!fallbackBySelector.has(selList)) fallbackBySelector.set(selList, new MockElement('DIV'));
    return fallbackBySelector.get(selList);
  }

  const files = o.files || {};
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    URL,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    AbortController,
    performance: { now: () => Date.now() },
    localStorage: {
      _m: new Map(),
      getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
      setItem(k, v) { this._m.set(k, String(v)); },
      removeItem(k) { this._m.delete(k); },
    },
    location: { origin: 'http://127.0.0.1:7788', reload() {} },
    document: {
      readyState: 'complete',
      body,
      documentElement: { scrollHeight: 1000, clientHeight: 800, style: { setProperty() {} } },
      querySelector: (sel) => queryInDoc(sel),
      querySelectorAll: (sel) => rootDoc.querySelectorAll(sel),
      getElementById: (id) => fixedIds[id] || null,
      createElement: (t) => new MockElement(t),
      createTreeWalker: () => ({ nextNode: () => null }),
      addEventListener: () => {},
    },
    fetch: async (url) => {
      const u = new URL(String(url));
      if (u.pathname === '/api/config') {
        return { ok: true, status: 200, json: async () => ({ defaultRoot: ROOT_DIR, defaultFile: '' }) };
      }
      if (u.pathname === '/api/translate/status') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ engine: { tts: { available: false } }, config: { service: 'bing', tts: {} } }),
        };
      }
      if (u.pathname === '/api/browse') {
        return { ok: true, status: 200, json: async () => ({ entries: [] }) };
      }
      if (u.pathname === '/api/read') {
        const p = u.searchParams.get('path');
        const rec = files[p];
        if (!rec) {
          return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
        }
        if (rec.tooLarge) {
          return {
            ok: false,
            status: 413,
            json: async () => ({
              error: '文件过大，暂不支持内联预览（上限 32 MB）',
              code: 'too-large',
              path: p,
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            path: p,
            text: rec.text,
            size: Buffer.byteLength(rec.text, 'utf8'),
            encoding: rec.encoding || 'utf-8',
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    },
    NodeFilter: { SHOW_TEXT: 4 },
    getSelection: () => null,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  };

  if (o.withHljs) {
    const supported = new Set(o.supportedLangs || ['python', 'py', 'json', 'javascript', 'js']);
    sandbox.hljs = {
      getLanguage: (lang) => (supported.has(String(lang || '').toLowerCase()) ? { name: lang } : undefined),
      highlightElement: (el) => {
        hljsCalls.push({ className: el.className, text: el.textContent });
        el.classList.add('hljs');
      },
    };
  }
  if (o.markedParse) {
    sandbox.marked = { parse: o.markedParse };
  }
  if (o.withDomPurify !== false) {
    sandbox.DOMPurify = { sanitize: (html) => html };
  }

  sandbox.window = sandbox;
  sandbox.window.addEventListener = () => {};
  sandbox.window.scrollTo = () => {};

  vm.runInNewContext(formatsCode, sandbox, { filename: 'public/formats.js' });
  vm.runInNewContext(code, sandbox, { filename: 'public/app.js' });
  return { sandbox, content: fixedIds.content, toastBox: fixedIds.toast, hljsCalls };
}

test('renderTextFile renders .txt and code files with hljs without insertBefore crash', async () => {
  const files = {
    'D:\\notes\\hello.txt': { text: '第一行文本\nSecond line', encoding: 'utf-8' },
    'D:\\notes\\main.py': { text: 'def greet():\n    return "hi"', encoding: 'utf-8' },
    'D:\\notes\\cfg.json': { text: '{"ok": true}', encoding: 'utf-8' },
    'D:\\notes\\app.ini': { text: '[main]\nport=7788', encoding: 'gbk' },
  };
  const { sandbox, content, toastBox, hljsCalls } = createDomHarness({ withHljs: true, files });
  await new Promise((r) => setTimeout(r, 20));

  const okTxt = await sandbox.__reader.openFile('D:\\notes\\hello.txt');
  assert.equal(okTxt, true);
  assert.equal(content.querySelectorAll('.err-card').length, 0);
  assert.ok(content.textContent.includes('第一行文本'));
  assert.ok(content.textContent.includes('utf-8'));
  assert.equal(content.querySelectorAll('.code-block.file-code').length, 1);
  assert.equal(content.querySelectorAll('button.code-copy').length, 1);
  assert.equal(hljsCalls.length, 0, '.txt must not invoke hljs.highlightElement');

  const okPy = await sandbox.__reader.openFile('D:\\notes\\main.py');
  assert.equal(okPy, true);
  assert.equal(content.querySelectorAll('.err-card').length, 0);
  assert.ok(content.textContent.includes('def greet():'));
  assert.equal(hljsCalls.length, 1);
  assert.ok(hljsCalls[0].className.includes('language-py'));

  const okJson = await sandbox.__reader.openFile('D:\\notes\\cfg.json');
  assert.equal(okJson, true);
  assert.equal(hljsCalls.length, 2);

  // hljs 不认识的扩展名（如未注册的 ini）应回退为 language-plaintext 而不抛错
  const okIni = await sandbox.__reader.openFile('D:\\notes\\app.ini');
  assert.equal(okIni, true);
  assert.equal(content.querySelectorAll('.err-card').length, 0);
  assert.ok(content.textContent.includes('gbk'));
  assert.equal(hljsCalls.length, 2);
  assert.equal(toastBox.childNodes.length, 0);
});

test('renderTextFile gracefully renders when window.hljs is missing', async () => {
  const files = {
    'D:\\notes\\plain.txt': { text: '纯文本降级测试', encoding: 'gbk' },
    'D:\\notes\\script.py': { text: 'print(42)', encoding: 'utf-8' },
  };
  const { sandbox, content, toastBox } = createDomHarness({ withHljs: false, files });
  await new Promise((r) => setTimeout(r, 20));

  const okTxt = await sandbox.__reader.openFile('D:\\notes\\plain.txt');
  assert.equal(okTxt, true);
  assert.equal(content.querySelectorAll('.err-card').length, 0);
  assert.ok(content.textContent.includes('纯文本降级测试'));
  assert.equal(content.querySelectorAll('.code-block.file-code').length, 1);
  assert.equal(toastBox.childNodes.length, 0, '.txt without hljs must not show warning toast');

  const okPy = await sandbox.__reader.openFile('D:\\notes\\script.py');
  assert.equal(okPy, true);
  assert.equal(content.querySelectorAll('.err-card').length, 0);
  assert.ok(content.textContent.includes('print(42)'));
  assert.equal(content.querySelectorAll('.code-block.file-code').length, 1);
  assert.equal(content.querySelectorAll('button.code-copy').length, 1);
  assert.ok(
    toastBox.childNodes.some((t) => t.className.includes('warn') && t.textContent.includes('纯文本')),
    'missing hljs for code file should show non-blocking warn toast'
  );
});

test('enhanceCode wraps Markdown fenced code block in-place preserving sibling order', async () => {
  const files = {
    'D:\\notes\\readme.md': { text: '# Title\n\nBefore\n\n```js\nconst a = 1;\n```\n\nAfter' },
  };
  const { sandbox, content, hljsCalls } = createDomHarness({
    withHljs: true,
    files,
    markedParse: () => '<p>Before</p><pre><code class="language-js">const a = 1;</code></pre><p>After</p>',
  });
  await new Promise((r) => setTimeout(r, 20));

  const ok = await sandbox.__reader.openFile('D:\\notes\\readme.md');
  assert.equal(ok, true);
  assert.equal(content.querySelectorAll('.err-card').length, 0);
  assert.equal(hljsCalls.length, 1);

  const tags = content.childNodes.map((n) => ({ tag: n.tagName, cls: n.className }));
  assert.equal(tags[0].cls, 'doc-meta');
  assert.equal(tags[1].tag, 'P');
  assert.equal(tags[2].tag, 'DIV');
  assert.ok(tags[2].cls.includes('code-block'));
  assert.equal(tags[3].tag, 'P');
  assert.equal(content.childNodes[2].querySelectorAll('button.code-copy').length, 1);
  assert.equal(content.childNodes[2].querySelectorAll('pre').length, 1);
});

test('openFile renders dotfiles, extensionless files, audio files, friendly 413 card, and Web local File objects', async () => {
  const files = {
    'D:\\repo\\.gitignore': { text: 'node_modules/\ndist/\n', encoding: 'utf-8' },
    'D:\\repo\\.env': { text: 'PORT=7788\n', encoding: 'utf-8' },
    'D:\\repo\\Makefile': { text: 'build:\n\tnode pack.js\n', encoding: 'utf-8' },
    'D:\\repo\\Dockerfile': { text: 'FROM node:22-alpine\n', encoding: 'utf-8' },
    'D:\\repo\\LICENSE': { text: 'MIT License\nCopyright (c) 2026 YJH', encoding: 'utf-8' },
    'D:\\repo\\huge.log': { tooLarge: true },
  };
  const { sandbox, content, hljsCalls } = createDomHarness({
    withHljs: true,
    supportedLangs: ['makefile', 'dockerfile', 'python', 'py', 'json', 'js'],
    files,
  });
  await new Promise((r) => setTimeout(r, 20));

  // 1. 点文件与无扩展名文件
  for (const p of ['D:\\repo\\.gitignore', 'D:\\repo\\.env', 'D:\\repo\\Makefile', 'D:\\repo\\Dockerfile', 'D:\\repo\\LICENSE']) {
    const ok = await sandbox.__reader.openFile(p);
    assert.equal(ok, true, 'openFile should succeed for ' + p);
    assert.equal(content.querySelectorAll('.err-card').length, 0);
    assert.equal(content.querySelectorAll('.code-block.file-code').length, 1);
  }
  assert.ok(hljsCalls.some((c) => c.className.includes('language-makefile')));
  assert.ok(hljsCalls.some((c) => c.className.includes('language-dockerfile')));

  // 2. 音频文件渲染
  const okAudio = await sandbox.__reader.openFile('D:\\music\\demo.mp3');
  assert.equal(okAudio, true);
  assert.equal(content.querySelectorAll('.err-card').length, 0);
  assert.equal(content.querySelectorAll('.audio-embed').length, 1);
  assert.equal(content.querySelectorAll('audio').length, 1);

  // 3. >32MB HTTP 413 渲染友好卡片（不含 .err-card 与无效 #btn-retry）
  const okHuge = await sandbox.__reader.openFile('D:\\repo\\huge.log');
  assert.equal(okHuge, false);
  assert.equal(content.querySelectorAll('.err-card').length, 0, '413 must NOT render red .err-card');
  assert.equal(content.querySelectorAll('#btn-retry').length, 0, '413 must NOT render useless retry button');
  assert.equal(content.querySelectorAll('.card').length, 1, '413 must render friendly info card');
  assert.ok(content.textContent.includes('32 MB'));

  // 4. Web 模式本地 File 对象预览（不污染 lastFile）
  const prevLastFile = sandbox.localStorage.getItem('media-reader/lastFile');
  const fakeLocalFile = {
    name: 'local_note.txt',
    size: 18,
    arrayBuffer: async () => Buffer.from('本地文件预览测试', 'utf8'),
  };
  const okLocal = await sandbox.__reader.openLocalFile(fakeLocalFile);
  assert.equal(okLocal, true);
  assert.equal(content.querySelectorAll('.code-block.file-code').length, 1);
  assert.ok(content.textContent.includes('本地文件预览测试'));
  assert.equal(sandbox.localStorage.getItem('media-reader/lastFile'), prevLastFile, 'Web local File must not overwrite LS.lastFile');
});

/* ------------------------------------------------------------------ */
/* 2. server.js /api/read 多编码读取验证                               */
/* ------------------------------------------------------------------ */

test('server /api/read decodes UTF-8, UTF-8 BOM, UTF-16 LE/BE, and GBK cleanly', async () => {
  const tmpRoot = makeTempDir('fp-read-enc-');
  const fakeLocalAppData = path.join(tmpRoot, 'localappdata');
  fs.mkdirSync(fakeLocalAppData, { recursive: true });

  const utf8File = path.join(tmpRoot, 'utf8.txt');
  const bomFile = path.join(tmpRoot, 'bom.txt');
  const u16leFile = path.join(tmpRoot, 'u16le.txt');
  const u16beFile = path.join(tmpRoot, 'u16be.txt');
  const gbkFile = path.join(tmpRoot, 'gbk.txt');

  fs.writeFileSync(utf8File, 'UTF-8 中文测试', 'utf8');
  fs.writeFileSync(bomFile, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('BOM 中文测试', 'utf8')]));
  fs.writeFileSync(u16leFile, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('UTF16LE 中文', 'utf16le')]));
  const u16beBody = Buffer.from('UTF16BE 中文', 'utf16le');
  u16beBody.swap16();
  fs.writeFileSync(u16beFile, Buffer.concat([Buffer.from([0xfe, 0xff]), u16beBody]));
  // 0xd6d0 0xcec4 0xb2e2 0xcad4 => "中文测试" (GBK)
  fs.writeFileSync(gbkFile, Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4]));

  const port = 7950 + (process.pid % 200);
  const token = 'test-read-token-1234';
  const harnessPath = path.join(tmpRoot, 'run_server.js');
  fs.writeFileSync(
    harnessPath,
    [
      `'use strict';`,
      `process.argv.push('--port=${port}', '--token=${token}', '--no-open');`,
      `const server = require(${JSON.stringify(path.join(ROOT_DIR, 'server.js'))});`,
      `server.start({ port: ${port}, root: ${JSON.stringify(tmpRoot)}, openBrowser: false }).then((p) => {`,
      `  process.stdout.write(JSON.stringify({ ready: true, port: p }) + '\\n');`,
      `});`,
      `process.stdin.setEncoding('utf8');`,
      `process.stdin.on('data', (d) => { if (d.includes('shutdown')) { server.shutdown(); setTimeout(() => process.exit(0), 50); } });`,
    ].join('\n'),
    'utf8'
  );

  const srv = cp.spawn(process.execPath, [harnessPath], {
    cwd: ROOT_DIR,
    windowsHide: true,
    env: Object.assign({}, process.env, { LOCALAPPDATA: fakeLocalAppData }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderr = '';
  srv.stderr.on('data', (d) => { stderr += d.toString(); });

  try {
    await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error('server start timeout: ' + stderr)), 10000);
      srv.stdout.on('data', (d) => {
        buf += d.toString();
        if (buf.includes('"ready":true')) {
          clearTimeout(timer);
          resolve();
        }
      });
      srv.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error('server exited early code=' + code + ' stderr=' + stderr));
      });
    });

    const cases = [
      { file: utf8File, expectText: 'UTF-8 中文测试', expectEnc: 'utf-8' },
      { file: bomFile, expectText: 'BOM 中文测试', expectEnc: 'utf-8-bom' },
      { file: u16leFile, expectText: 'UTF16LE 中文', expectEnc: 'utf-16le' },
      { file: u16beFile, expectText: 'UTF16BE 中文', expectEnc: 'utf-16be' },
      { file: gbkFile, expectText: '中文测试', expectEnc: 'gbk' },
    ];
    for (const c of cases) {
      const res = await httpGet(port, '/api/read?token=' + token + '&path=' + encodeURIComponent(c.file));
      assert.equal(res.status, 200, 'HTTP 200 expected for ' + c.file);
      const json = JSON.parse(res.body.toString('utf8'));
      assert.equal(json.text, c.expectText);
      assert.equal(json.encoding, c.expectEnc);
      assert.ok(!json.text.includes('\uFEFF'), 'BOM must be stripped for ' + c.file);
    }
  } finally {
    try { srv.stdin.write('shutdown\n'); } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));
    if (srv.exitCode === null) {
      try { cp.spawnSync('taskkill', ['/pid', String(srv.pid), '/T', '/F'], { windowsHide: true }); } catch (_) {}
    }
    rmrf(tmpRoot);
  }
});

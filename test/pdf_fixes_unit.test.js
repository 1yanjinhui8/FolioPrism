'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const vm = require('node:vm');

const ROOT_DIR = path.resolve(__dirname, '..');
const translator = require('../src/translator');
const { readSystemTextScale } = require('../src/main');

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

function createPdfDomHarness(opts) {
  const o = opts || {};
  const formatsCode = fs.readFileSync(path.join(ROOT_DIR, 'src', 'shared', 'formats.js'), 'utf8');
  const appCode = fs.readFileSync(path.join(ROOT_DIR, 'src', 'renderer', 'app.js'), 'utf8');

  const cssVars = {};
  const postCalls = [];
  const getCalls = [];

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
      this.src = '';
      this.classList = {
        add: (...cls) => cls.forEach((c) => c && this._classSet.add(c)),
        remove: (...cls) => cls.forEach((c) => c && this._classSet.delete(c)),
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
    get children() { return this.childNodes; }
    get parentElement() { return this.parentNode; }
    get textContent() {
      if (this.childNodes.length) return this.childNodes.map((c) => c.textContent).join('');
      return this._text;
    }
    set textContent(v) {
      this.childNodes = [];
      this._text = String(v == null ? '' : v);
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
      const val = String(v);
      this.attributes[k] = val;
      if (k === 'id') this.id = val;
      else if (k === 'class') this.className = val;
      else if (k === 'src') this.src = val;
      else if (k === 'hidden') this.hidden = true;
      else if (k.startsWith('data-')) {
        const key = k.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
        this.dataset[key] = val;
      }
    }
    getAttribute(k) {
      if (k === 'id') return this.id || null;
      if (k === 'class') return this.className || null;
      if (k === 'src') return this.src || null;
      return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null;
    }
    hasAttribute(k) { return this.getAttribute(k) !== null; }
    cloneNode(deep) {
      const c = new MockElement(this.tagName, this.id);
      c.className = this.className;
      c._text = this._text;
      if (deep) {
        for (const ch of this.childNodes) c.appendChild(ch.cloneNode(true));
      }
      return c;
    }
    closest() { return null; }
    querySelectorAll(selList) {
      const out = [];
      const seen = new Set();
      const parts = String(selList).split(',').map((s) => s.trim()).filter(Boolean);
      const walk = (root, fn) => {
        for (const ch of root.childNodes) {
          fn(ch);
          walk(ch, fn);
        }
      };
      const matchSimple = (el, sel) => {
        let rest = sel;
        const attrs = [];
        rest = rest.replace(/\[([A-Za-z0-9_-]+)(?:=["']?([^"'\]]*)["']?)?\]/g, (_, k, v) => {
          attrs.push([k, v]);
          return '';
        });
        const idM = /#([A-Za-z0-9_-]+)/.exec(rest);
        if (idM) {
          if (el.id !== idM[1]) return false;
          rest = rest.replace(idM[0], '');
        }
        const classes = [];
        rest = rest.replace(/\.([A-Za-z0-9_-]+)/g, (_, cls) => {
          classes.push(cls);
          return '';
        });
        const tag = rest.trim();
        if (tag && tag !== '*' && el.tagName !== tag.toUpperCase()) return false;
        if (!classes.every((cls) => el._classSet.has(cls))) return false;
        return attrs.every(([k, v]) => {
          const got = el.getAttribute(k);
          if (got === null && k.startsWith('data-')) {
            const dk = k.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
            return v === undefined ? el.dataset[dk] != null : el.dataset[dk] === v;
          }
          return v === undefined ? got !== null : got === v;
        });
      };
      for (const part of parts) {
        const tokens = part.split(/\s+/).filter(Boolean);
        walk(this, (node) => {
          if (node === this || !matchSimple(node, tokens[tokens.length - 1])) return;
          let ti = tokens.length - 2;
          let cur = node.parentNode;
          while (ti >= 0 && cur) {
            if (matchSimple(cur, tokens[ti])) ti--;
            if (cur === this) break;
            cur = cur.parentNode;
          }
          if (ti < 0 && !seen.has(node)) {
            seen.add(node);
            out.push(node);
          }
        });
      }
      return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
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
    continue: new MockElement('DIV', 'continue'),
    'btn-bilingual': new MockElement('BUTTON', 'btn-bilingual'),
    'tm-service': new MockElement('SELECT', 'tm-service'),
    'tm-base': new MockElement('INPUT', 'tm-base'),
    'tm-key': new MockElement('INPUT', 'tm-key'),
    'tm-model': new MockElement('INPUT', 'tm-model'),
    'tm-src-lang': new MockElement('SELECT', 'tm-src-lang'),
    'tm-tgt-lang': new MockElement('SELECT', 'tm-tgt-lang'),
    'tm-voice-en': new MockElement('SELECT', 'tm-voice-en'),
    'tm-voice-zh': new MockElement('SELECT', 'tm-voice-zh'),
    'tm-save': new MockElement('BUTTON', 'tm-save'),
    'tm-install': new MockElement('BUTTON', 'tm-install'),
    'trans-modal': new MockElement('DIV', 'trans-modal'),
  };
  fixedIds.progress.appendChild(new MockElement('I'));
  const lightbox = new MockElement('DIV', 'lightbox');
  lightbox.hidden = true;
  ['lb-backdrop', 'lb-close', 'lb-prev', 'lb-next'].forEach((cls) => {
    const ch = new MockElement('DIV');
    ch.className = cls;
    lightbox.appendChild(ch);
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

  let currentOutput = o.initialOutput || null;
  let jobSeq = 0;

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    URL,
    TextDecoder,
    Uint8Array,
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
      documentElement: {
        scrollHeight: 1000,
        clientHeight: 800,
        style: {
          setProperty(k, v) { cssVars[k] = v; },
        },
      },
      querySelector: (sel) => queryInDoc(sel),
      querySelectorAll: (sel) => rootDoc.querySelectorAll(sel),
      getElementById: (id) => fixedIds[id] || null,
      createElement: (t) => new MockElement(t),
      createTreeWalker: () => ({ nextNode: () => null }),
      addEventListener: () => {},
    },
    readerNative: o.systemTextScale != null
      ? { isElectron: true, systemTextScale: async () => o.systemTextScale }
      : undefined,
    fetch: async (url, init) => {
      const u = new URL(String(url));
      const method = (init && init.method) || 'GET';
      const bodyObj = init && init.body ? JSON.parse(init.body) : null;
      if (method === 'POST') postCalls.push({ pathname: u.pathname, body: bodyObj });
      else getCalls.push(u.pathname + u.search);

      if (u.pathname === '/api/config') {
        return { ok: true, status: 200, json: async () => ({ defaultRoot: ROOT_DIR, defaultFile: '' }) };
      }
      if (u.pathname === '/api/translate/status') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            engine: { available: true, tts: { available: false } },
            config: { service: 'bing', sourceLang: 'auto', targetLang: 'zh-CN', openai: {}, tts: {} },
          }),
        };
      }
      if (u.pathname === '/api/pdf-translate/current') {
        return { ok: true, status: 200, json: async () => ({ job: null, output: currentOutput }) };
      }
      if (u.pathname === '/api/pdf-translate' && method === 'POST') {
        const id = 'job-' + (++jobSeq);
        const out = { dual: '/api/pdf-result?key=abcd1234&kind=dual', mono: '/api/pdf-result?key=abcd1234&kind=mono' };
        currentOutput = out;
        if (!bodyObj.force && o.cachedOnFirst) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ job: { id, status: 'done', progress: 100, log: ['cached'] }, output: out, cached: true }),
          };
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ job: { id, status: 'running', progress: 0, log: [] }, output: out }),
        };
      }
      if (u.pathname === '/api/pdf-translate/status') {
        const id = u.searchParams.get('id');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            job: { id, status: 'done', progress: 100, log: ['done'] },
            output: currentOutput,
          }),
        };
      }
      if (u.pathname === '/api/read') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ path: u.searchParams.get('path'), text: 'hello', size: 5, encoding: 'utf-8' }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
    },
    NodeFilter: { SHOW_TEXT: 4 },
    getSelection: () => null,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  };

  sandbox.window = sandbox;
  sandbox.window.addEventListener = () => {};
  sandbox.window.scrollTo = () => {};
  sandbox.DOMPurify = { sanitize: (html) => html };

  vm.runInNewContext(formatsCode, sandbox, { filename: 'src/shared/formats.js' });
  vm.runInNewContext(appCode, sandbox, { filename: 'src/renderer/app.js' });

  return { sandbox, body, content: fixedIds.content, cssVars, postCalls, getCalls };
}

test('body.pdf-view toggles on PDF open and clears on non-PDF open; stepFont & systemTextScale drive PDF zoom', async () => {
  const { sandbox, body, content, cssVars } = createPdfDomHarness({ systemTextScale: 1.25 });
  await new Promise((r) => setTimeout(r, 30));

  // 系统文本缩放比例应写入 --text-scale，且 --font-size-base 保持基线字号
  assert.equal(cssVars['--text-scale'], '1.25');
  assert.equal(cssVars['--font-size-base'], '18px');

  const okPdf = await sandbox.__reader.openFile('D:\\papers\\demo.pdf');
  assert.equal(okPdf, true);
  assert.equal(body.classList.contains('pdf-view'), true, 'opening PDF must add body.pdf-view');

  const frame1 = content.querySelector('.pdf-frame.active');
  assert.ok(frame1, 'active PDF iframe must exist');
  assert.ok(frame1.src.includes('#zoom=125'), 'initial PDF iframe must reflect systemTextScale 125%, got ' + frame1.src);

  // 在 PDF 视图下调用「增大字号（stepFont(1)）」应联动放大 PDF 缩放而不是只改无效的 DOM 字号
  sandbox.__reader.stepFont(1);
  const frameAfterInc = content.querySelector('.pdf-frame.active');
  // 115% * 1.25 = 143.75 -> 144%
  assert.ok(frameAfterInc.src.includes('#zoom=144'), 'stepFont(1) in pdf-view must scale PDF to 144%, got ' + frameAfterInc.src);
  assert.equal(content.querySelector('#pdf-zoom-val').textContent, '144%');

  // 切换到非 PDF 文件后必须移除 body.pdf-view，恢复文章阅读流
  const okTxt = await sandbox.__reader.openFile('D:\\papers\\notes.txt');
  assert.equal(okTxt, true);
  assert.equal(body.classList.contains('pdf-view'), false, 'opening non-PDF must remove body.pdf-view');
});

test('clicking 重新翻译 after PDF translation sends force=true and busts iframe version', async () => {
  const { sandbox, content, postCalls } = createPdfDomHarness({ cachedOnFirst: true });
  await new Promise((r) => setTimeout(r, 30));

  await sandbox.__reader.openFile('D:\\papers\\paper.pdf');
  const transBtn = content.querySelector('#pdf-translate');
  assert.ok(transBtn);

  // 首次点击「双语翻译」：force 应为 false，命中缓存后按钮变为「重新翻译」
  transBtn.click();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(postCalls.length, 1);
  assert.equal(postCalls[0].pathname, '/api/pdf-translate');
  assert.equal(postCalls[0].body.force, false);
  assert.equal(transBtn.textContent, '重新翻译');

  const dualBefore = content.querySelector('.pdf-frame[data-frame="dual"]');
  assert.ok(dualBefore && dualBefore.src.includes('kind=dual'));

  // 再次点击「重新翻译」：必须传 force: true 并刷新译文 iframe URL
  transBtn.click();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(postCalls.length, 2);
  assert.equal(postCalls[1].pathname, '/api/pdf-translate');
  assert.equal(postCalls[1].body.force, true);

  const dualAfter = content.querySelector('.pdf-frame[data-frame="dual"]');
  assert.ok(dualAfter && dualAfter.src.includes('_t='), 're-translated dual iframe must carry cache-busting _t param');
});

test('validatePdfLanguages blocks same-language and mismatched source/target pairs', () => {
  const same = translator.validatePdfLanguages('zh-CN', 'en', 'zh-CN');
  assert.equal(same.ok, false);

  const mismatch = translator.validatePdfLanguages('zh-CN', 'en', 'en');
  assert.equal(mismatch.ok, false);
  assert.ok(mismatch.error.includes('自动检测'));

  const autoSame = translator.validatePdfLanguages('auto', 'zh-CN', 'zh-CN');
  assert.equal(autoSame.ok, false);

  const valid = translator.validatePdfLanguages('auto', 'en', 'zh-CN');
  assert.equal(valid.ok, true);
  assert.equal(valid.sourceCode, 'en');
  assert.equal(valid.targetCode, 'zh');
});

test('readSystemTextScale resolves to a bounded positive number', async () => {
  const s = await readSystemTextScale();
  assert.equal(typeof s, 'number');
  assert.ok(s >= 0.8 && s <= 2.25, 'unexpected systemTextScale: ' + s);
});

test('PDF2ZH_WRAPPER_SCRIPT splits >1000-char paragraphs without truncation or splitting {v*} placeholders', () => {
  const py = translator.findPdf2zhPython();
  if (!py) return; // 未安装 pdf2zh 时跳过 Python 侧验证

  const longPara =
    'The biggest successes in natural-language-related machine learning have been statistical speech recognition and statistical machine translation. ' +
    'The reason for these successes is not that these tasks are easier than other tasks; they are in fact much harder than tasks such as document classification. ' +
    'The reason is that translation is a natural task routinely done every day for a real human need (think of the European Union or news agencies). ' +
    'In other words, a large training set of the input-output behavior {v10} is available to us. ' +
    'In contrast, traditional natural language processing problems such as document classification, part-of-speech tagging, named-entity recognition, or parsing are not routine tasks, ' +
    'so they have no large corpus available in the wild. Instead, a corpus for these tasks requires skilled human annotation. ' +
    'Such annotation is not only slow and expensive to acquire but also difficult for experts to agree on, being bedeviled by many of the difficulties we discuss later in relation to the Semantic Web. ' +
    'The first lesson of Web-scale learning is to use available large-scale data rather than hoping for annotated data that is not available. ' +
    'For instance, we find that useful semantic relationships can be automatically learned from the statistics of search queries and Web tables {v12} in both cases without needing any manually annotated data.';

  const script =
    'import json, sys\n' +
    'ns = {}\n' +
    'exec(compile(sys.stdin.read(), "wrapper", "exec"), ns)\n' +
    'chunks = ns["_fp_split_chunks"](sys.argv[1], 900)\n' +
    'print("__CHUNKS__:" + json.dumps(chunks))\n';

  const res = cp.spawnSync(py, ['-c', script, longPara], {
    input: translator.PDF2ZH_WRAPPER_SCRIPT,
    encoding: 'utf8',
    windowsHide: true,
    // Windows 上 Python 默认按 GBK 解码 stdin，含非 ASCII 的脚本会直接抛
    // UnicodeEncodeError；强制 UTF-8 才能与生产环境（-u 子进程）一致。
    env: Object.assign({}, process.env, { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }),
  });
  assert.equal(res.status, 0, res.stderr);
  const line = res.stdout.split(/\r?\n/).find((l) => l.startsWith('__CHUNKS__:'));
  assert.ok(line, 'missing __CHUNKS__ output: ' + res.stdout);
  const chunks = JSON.parse(line.slice('__CHUNKS__:'.length));
  assert.ok(chunks.length >= 2, '1200+ char paragraph must split into >=2 chunks');
  for (const ch of chunks) {
    assert.ok(ch.length <= 900, 'each chunk must stay <= 900 chars, got ' + ch.length);
  }
  assert.equal(chunks.join(''), longPara, 'joining chunks must preserve 100% of original text');
  assert.ok(chunks.some((c) => c.includes('{v10}')), '{v10} placeholder must stay intact');
  assert.ok(chunks.some((c) => c.includes('{v12}')), '{v12} placeholder must stay intact');
});

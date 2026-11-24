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

function httpRequest(port, urlPath, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method: o.method || 'GET',
        headers: o.headers || {},
        agent: false,
      },
      (res) => {
        const chunks = [];
        let firstByteAt = 0;
        const startAt = o.startAt || Date.now();
        res.on('data', (c) => {
          if (!firstByteAt) firstByteAt = Date.now();
          chunks.push(c);
          if (typeof o.onChunk === 'function') o.onChunk(c, req, res);
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
            ttfbMs: (firstByteAt || Date.now()) - startAt,
            totalMs: Date.now() - startAt,
          });
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    if (o.body) req.write(o.body);
    req.end();
  });
}

/* ------------------------------------------------------------------ */
/* 1. translator.js: 懒加载 which() 缓存 + 本地语言检测                   */
/* ------------------------------------------------------------------ */

test('tool discovery caches results and avoids eager where.exe when direct path exists', () => {
  const tmpLocal = makeTempDir('fp-toolcache-');
  const prevLocal = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = tmpLocal;

  const origExecFileSync = cp.execFileSync;
  const whereCalls = [];
  cp.execFileSync = function patchedExecFileSync(file, args, opts) {
    if (String(file).toLowerCase().includes('where')) {
      whereCalls.push(args && args[0]);
    }
    return origExecFileSync.apply(this, arguments);
  };

  // 清除 require 缓存确保加载最新并命中 patched execFileSync
  const translatorPath = require.resolve('../translator');
  delete require.cache[translatorPath];
  const translator = require('../translator');

  try {
    translator.invalidateToolCache();
    whereCalls.length = 0;

    const edgeExe = translator.findEdgeTts();
    const expectedUvEdge = path.join(
      process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      'uv', 'tools', 'edge-tts', 'Scripts', 'edge-tts.exe'
    );
    if (fs.existsSync(expectedUvEdge)) {
      assert.equal(edgeExe, expectedUvEdge);
      assert.equal(
        whereCalls.filter((x) => x === 'edge-tts').length,
        0,
        'findEdgeTts should not invoke where.exe when uv direct path exists'
      );
    }

    // 连续多次调用 status() 应复用缓存，不重复触发 where.exe
    const s1 = translator.status();
    const callsAfterFirstStatus = whereCalls.length;
    const t0 = Date.now();
    for (let i = 0; i < 10; i++) {
      translator.status();
    }
    const elapsed = Date.now() - t0;
    assert.equal(whereCalls.length, callsAfterFirstStatus, 'repeated status() calls must hit cache');
    assert.ok(elapsed < 50, 'cached 10x status() should take < 50ms, got ' + elapsed + 'ms');
    assert.equal(typeof s1.engine.tts.available, 'boolean');
  } finally {
    cp.execFileSync = origExecFileSync;
    delete require.cache[translatorPath];
    process.env.LOCALAPPDATA = prevLocal;
    rmrf(tmpLocal);
  }
});

test('detectLanguage with localOnly resolves script and Latin languages without blocking', async () => {
  const translator = require('../translator');
  const t0 = Date.now();
  const zh = await translator.detectLanguage('这是一个中文测试段落，用于验证本地语言识别。', { localOnly: true });
  const ja = await translator.detectLanguage('これは日本語のテストです。', { localOnly: true });
  const en = await translator.detectLanguage('The quick brown fox jumps over the lazy dog and this is English.', { localOnly: true });
  const fr = await translator.detectLanguage('Le chat est sur la table pour les amis avec du pain.', { localOnly: true });
  const de = await translator.detectLanguage('Der Hund und die Katze sind auf der Straße mit dem Mann.', { localOnly: true });
  const ms = Date.now() - t0;

  assert.equal(zh.lang, 'zh');
  assert.equal(ja.lang, 'ja');
  assert.equal(en.lang, 'en');
  assert.equal(fr.lang, 'fr');
  assert.equal(de.lang, 'de');
  assert.ok(ms < 100, 'localOnly detection must be instant (<100ms), got ' + ms + 'ms');
});

/* ------------------------------------------------------------------ */
/* 2. server.js + translator.js: 持久化 worker 流式 / 缓存 / 错误 / 清理  */
/* ------------------------------------------------------------------ */

test('server /api/tts streams progressively from persistent worker, caches atomically, handles errors and shutdown', async (t) => {
  const realPy = path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'uv', 'tools', 'edge-tts', 'Scripts', 'python.exe'
  );
  if (!fs.existsSync(realPy)) {
    t.skip('uv edge-tts python.exe not installed on host');
    return;
  }

  const tmpRoot = makeTempDir('fp-tts-int-');
  const fakeLocalAppData = path.join(tmpRoot, 'localapp');
  const appDir = path.join(fakeLocalAppData, 'folioprism');
  const fakeToolsDir = path.join(tmpRoot, 'fake-tools');
  const fakeSiteDir = path.join(tmpRoot, 'fake-site');
  const fakeEdgePkg = path.join(fakeSiteDir, 'edge_tts');
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(fakeToolsDir, { recursive: true });
  fs.mkdirSync(fakeEdgePkg, { recursive: true });

  // 复制真实 python.exe 到临时目录（避免修改全局环境），但其实 uv venv python.exe 需要 pyvenv.cfg；
  // 更简单稳妥：把 sibling python.exe 放在真实 venv 的话会找到真实 edge_tts，
  // 因此这里用 .cmd/.bat? 不行，spawn 不走 shell。我们把 fake-site 放进 PYTHONPATH，
  // 并在 fake_edge_tts 中实现异步流式 yield（块1在 20ms，块2在 350ms），
  // 通过在 fake-tools 创建 python.exe? 注意 Windows venv python.exe 可从标准 Python 或复制 python3.dll。
  // 验证 PYTHONPATH 是否能覆盖真实 venv 的 edge_tts：
  const countFile = path.join(tmpRoot, 'synth_count.txt');
  fs.writeFileSync(
    path.join(fakeEdgePkg, '__init__.py'),
    [
      'import asyncio, os, pathlib',
      'class Communicate:',
      '    def __init__(self, text, voice="en-US-AriaNeural", rate="+0%", connector=None):',
      '        self.text = text',
      '        self.voice = voice',
      '        self.rate = rate',
      '        self.connector = connector',
      '    async def stream(self):',
      '        cnt_path = pathlib.Path(' + JSON.stringify(countFile) + ')',
      '        prev = int(cnt_path.read_text()) if cnt_path.exists() else 0',
      '        cnt_path.write_text(str(prev + 1))',
      '        if "__FAIL_BEFORE_AUDIO__" in self.text:',
      '            raise RuntimeError("simulated upstream failure")',
      '        await asyncio.sleep(0.02)',
      '        yield {"type": "audio", "data": b"ID3\\x03\\x00\\x00\\x00\\x00\\x00\\x00" + (b"A" * 120)}',
      '        await asyncio.sleep(0.35)',
      '        if "__FAIL_MID_STREAM__" in self.text:',
      '            raise RuntimeError("simulated mid-stream failure")',
      '        yield {"type": "audio", "data": b"B" * 200}',
    ].join('\n'),
    'utf8'
  );

  // 配置 tts.edgeTtsPath 指向真实 uv edge-tts.exe（同目录有 python.exe），
  // 并把 fakeSiteDir 放在 PYTHONPATH 最前，使 worker 里的 `import edge_tts` 加载可控的 fake edge_tts
  const realEdgeExe = path.join(path.dirname(realPy), 'edge-tts.exe');
  fs.writeFileSync(
    path.join(appDir, 'config.json'),
    JSON.stringify({ tts: { edgeTtsPath: realEdgeExe } }),
    'utf8'
  );

  const port = 7895;
  const token = 'test-tts-token-1234';
  const childCode = `
    const server = require(${JSON.stringify(path.join(ROOT_DIR, 'server.js'))});
    const translator = require(${JSON.stringify(path.join(ROOT_DIR, 'translator.js'))});
    server.start({ port: ${port}, root: ${JSON.stringify(ROOT_DIR)}, openBrowser: false }).then(async (p) => {
      await translator.warmTtsWorker();
      process.stdout.write(JSON.stringify({ ready: true, port: p, token: server.getToken() }) + '\\n');
    });
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => {
      if (d.includes('shutdown')) {
        server.shutdown();
        setTimeout(() => process.exit(0), 100);
      }
    });
  `;

  // 通过命令行 --token 启动，并把子进程放进独立脚本执行
  const harnessPath = path.join(tmpRoot, 'run_server.js');
  fs.writeFileSync(
    harnessPath,
    [
      `'use strict';`,
      `process.argv.push('--port=${port}', '--token=${token}', '--no-open');`,
      childCode,
    ].join('\n'),
    'utf8'
  );

  const srv = cp.spawn(process.execPath, [harnessPath], {
    cwd: ROOT_DIR,
    windowsHide: true,
    env: Object.assign({}, process.env, {
      LOCALAPPDATA: fakeLocalAppData,
      PYTHONPATH: fakeSiteDir,
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderr = '';
  srv.stderr.on('data', (d) => { stderr += d.toString(); });

  try {
    await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error('server start timeout: ' + stderr)), 15000);
      srv.stdout.on('data', (d) => {
        buf += d.toString();
        const line = buf.split('\n').find((l) => l.includes('"ready":true'));
        if (line) {
          clearTimeout(timer);
          resolve();
        }
      });
      srv.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error('server exited early code=' + code + ' stderr=' + stderr));
      });
    });

    // 确认 python worker 确实在启动后已常驻（warmTtsWorker 完成）
    await new Promise((r) => setTimeout(r, 150));

    // A. 验证流式 TTFB 显著小于总响应时间（chunk 1 @20ms，chunk 2 @370ms）
    const startA = Date.now();
    const r1 = await httpRequest(
      port,
      '/api/tts?token=' + token + '&text=' + encodeURIComponent('Progressive streaming test sentence.'),
      { startAt: startA }
    );
    assert.equal(r1.status, 200);
    assert.equal(r1.headers['content-type'], 'audio/mpeg');
    assert.equal(r1.headers['accept-ranges'], 'none');
    assert.equal(r1.headers['x-tts-voice'], 'en-US-AriaNeural');
    assert.ok(r1.headers['server-timing'], 'Server-Timing header should be present');
    assert.equal(r1.body.length, 330);
    assert.ok(r1.ttfbMs < 220, 'stream TTFB should arrive before chunk 2 (<220ms), got ' + r1.ttfbMs + 'ms');
    assert.ok(r1.totalMs >= 300, 'full synthesis spans chunk 2 (>=300ms), got ' + r1.totalMs + 'ms');
    assert.ok(r1.ttfbMs + 100 < r1.totalMs, 'TTFB must beat full synthesis time');

    // 等后台缓存原子落盘完成
    await new Promise((r) => setTimeout(r, 100));
    const cacheDir = path.join(appDir, 'cache', 'tts');
    const cachedFiles = fs.readdirSync(cacheDir).filter((f) => f.endsWith('.mp3') && !f.includes('.tmp.'));
    assert.equal(cachedFiles.length, 1, 'clean completion should persist 1 cached mp3');

    // B. 缓存命中支持 200 Content-Length 与 206 Range
    const rHit = await httpRequest(
      port,
      '/api/tts?token=' + token + '&text=' + encodeURIComponent('Progressive streaming test sentence.')
    );
    assert.equal(rHit.status, 200);
    assert.equal(rHit.headers['accept-ranges'], 'bytes');
    assert.equal(Number(rHit.headers['content-length']), 330);

    const rRange = await httpRequest(
      port,
      '/api/tts?token=' + token + '&text=' + encodeURIComponent('Progressive streaming test sentence.'),
      { headers: { Range: 'bytes=0-49' } }
    );
    assert.equal(rRange.status, 206);
    assert.equal(rRange.body.length, 50);

    // C. 并发请求同一个未缓存文本应共享 ttsPending，只触发一次上游合成
    const countBefore = parseInt(fs.readFileSync(countFile, 'utf8'), 10);
    const sharedText = encodeURIComponent('Concurrent deduplication check.');
    const [c1, c2] = await Promise.all([
      httpRequest(port, '/api/tts?token=' + token + '&text=' + sharedText),
      httpRequest(port, '/api/tts?token=' + token + '&text=' + sharedText),
    ]);
    assert.equal(c1.status, 200);
    assert.equal(c2.status, 200);
    assert.equal(c1.body.length, 330);
    assert.equal(c2.body.length, 330);
    const countAfter = parseInt(fs.readFileSync(countFile, 'utf8'), 10);
    assert.equal(countAfter - countBefore, 1, 'ttsPending should deduplicate concurrent requests');

    // D. 中途取消不能留下污染的缓存文件
    await new Promise((r) => setTimeout(r, 100));
    const filesBeforeAbort = fs.readdirSync(cacheDir).length;
    await assert.rejects(() =>
      httpRequest(
        port,
        '/api/tts?token=' + token + '&text=' + encodeURIComponent('Abort mid stream test.'),
        {
          onChunk: (_chunk, req) => {
            req.destroy(new Error('client_aborted'));
          },
        }
      )
    );
    await new Promise((r) => setTimeout(r, 150));
    const filesAfterAbort = fs.readdirSync(cacheDir).filter((f) => !f.includes('.tmp.'));
    const tmpLeftovers = fs.readdirSync(cacheDir).filter((f) => f.includes('.tmp.'));
    assert.equal(filesAfterAbort.length, filesBeforeAbort, 'aborted stream must NOT commit to cache');
    assert.equal(tmpLeftovers.length, 0, 'aborted stream must clean up .tmp.mp3');

    // E. 首字节前失败返回 502 JSON，超过 1200 字返回 400 JSON
    const rFail = await httpRequest(
      port,
      '/api/tts?token=' + token + '&text=' + encodeURIComponent('__FAIL_BEFORE_AUDIO__')
    );
    assert.equal(rFail.status, 502);
    const failJson = JSON.parse(rFail.body.toString('utf8'));
    assert.ok(failJson.error.includes('simulated upstream failure'));

    const tooLong = 'a'.repeat(1201);
    const rLong = await httpRequest(
      port,
      '/api/tts?token=' + token + '&text=' + encodeURIComponent(tooLong)
    );
    assert.equal(rLong.status, 400);
    assert.equal(JSON.parse(rLong.body.toString('utf8')).code, 'bad-request');

    // F. shutdown 清理 worker 进程验证（通过子进程调用 shutdown 确认无报错且退出）
    const rHealth = await httpRequest(port, '/api/health');
    assert.equal(rHealth.status, 200);
  } finally {
    try { srv.stdin.write('shutdown\n'); srv.stdin.end(); } catch (_) {}
    await new Promise((r) => setTimeout(r, 350));
    if (srv.exitCode === null) {
      try { cp.spawnSync('taskkill', ['/pid', String(srv.pid), '/T', '/F'], { windowsHide: true }); } catch (_) {}
    }
    try { srv.stdout.destroy(); } catch (_) {}
    try { srv.stderr.destroy(); } catch (_) {}
    rmrf(tmpRoot);
  }
});

test('translator.killAllChildren terminates persistent TTS worker cleanly', async (t) => {
  const realPy = path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'uv', 'tools', 'edge-tts', 'Scripts', 'python.exe'
  );
  if (!fs.existsSync(realPy)) {
    t.skip('uv edge-tts python.exe not installed on host');
    return;
  }
  const translatorPath = require.resolve('../translator');
  delete require.cache[translatorPath];
  const translator = require('../translator');

  const w = await translator.warmTtsWorker();
  assert.ok(w && w.proc && w.proc.pid, 'warmTtsWorker should spawn persistent worker');
  const workerPid = w.proc.pid;

  translator.killAllChildren();
  await new Promise((r) => setTimeout(r, 400));

  let alive = true;
  try {
    process.kill(workerPid, 0);
  } catch (_) {
    alive = false;
  }
  assert.equal(alive, false, 'worker process should be terminated after killAllChildren()');
  delete require.cache[translatorPath];
});

/* ------------------------------------------------------------------ */
/* 3. public/app.js: 分块、暂停防误回退、快速切段、去重 status 请求        */
/* ------------------------------------------------------------------ */

function loadFrontendHarness() {
  const formatsCode = fs.readFileSync(path.join(ROOT_DIR, 'public', 'formats.js'), 'utf8');
  const code = fs.readFileSync(path.join(ROOT_DIR, 'public', 'app.js'), 'utf8');
  const fetchCalls = [];
  const audioInstances = [];
  const speechCalls = [];
  let audioPlayBehavior = 'resolve'; // 'resolve' | 'abort-on-pause'

  class FakeElement {
    constructor(tag) {
      this.tagName = String(tag || 'DIV').toUpperCase();
      this.classList = {
        _set: new Set(),
        add: (...cls) => cls.forEach((c) => this.classList._set.add(c)),
        remove: (...cls) => cls.forEach((c) => this.classList._set.delete(c)),
        contains: (c) => this.classList._set.has(c),
        toggle: (c, f) => (f === undefined ? (this.classList._set.has(c) ? this.classList._set.delete(c) : this.classList._set.add(c)) : f ? this.classList._set.add(c) : this.classList._set.delete(c)),
      };
      this.style = {};
      this.dataset = {};
      this.listeners = {};
      this.children = [];
      this.hidden = false;
      this.value = '';
      this.textContent = '';
      this.innerHTML = '';
      this.options = [];
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
    appendChild(c) { this.children.push(c); return c; }
    remove() {}
    querySelector(s) { return getEl(s); }
    querySelectorAll() { return []; }
    closest() { return null; }
    setAttribute() {}
    getAttribute() { return ''; }
    getBoundingClientRect() { return { top: 100, bottom: 150 }; }
    scrollIntoView() {}
    cloneNode() { return new FakeElement(this.tagName); }
  }

  const elementsBySelector = new Map();
  const getEl = (sel) => {
    if (!elementsBySelector.has(sel)) elementsBySelector.set(sel, new FakeElement('div'));
    return elementsBySelector.get(sel);
  };

  class FakeAudio {
    constructor(src) {
      this.src = src;
      this.preload = '';
      this.paused = false;
      this.error = null;
      this.playbackRate = 1;
      this._rejectPlay = null;
      audioInstances.push(this);
    }
    play() {
      this.paused = false;
      if (audioPlayBehavior === 'abort-on-pause') {
        return new Promise((resolve, reject) => {
          this._resolvePlay = resolve;
          this._rejectPlay = reject;
        });
      }
      return Promise.resolve();
    }
    pause() {
      this.paused = true;
      if (this._rejectPlay) {
        const rej = this._rejectPlay;
        this._rejectPlay = null;
        const err = new Error('The play() request was interrupted by a call to pause().');
        err.name = 'AbortError';
        rej(err);
      }
    }
    removeAttribute(k) { if (k === 'src') this.src = ''; }
    load() {}
  }

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    URL,
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
      body: new FakeElement('body'),
      documentElement: { scrollHeight: 1000, clientHeight: 800, style: { setProperty() {} } },
      querySelector: (s) => getEl(s),
      querySelectorAll: () => [],
      createElement: (t) => new FakeElement(t),
      addEventListener: () => {},
    },
    Audio: FakeAudio,
    SpeechSynthesisUtterance: function (text) {
      this.text = text;
      this.lang = '';
      this.rate = 1;
    },
    speechSynthesis: {
      getVoices: () => [],
      speak: (u) => { speechCalls.push(u.text); },
      cancel: () => {},
      pause: () => {},
      resume: () => {},
    },
    fetch: async (url) => {
      const u = String(url);
      fetchCalls.push(u);
      if (u.includes('/api/translate/status')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            engine: { tts: { available: true } },
            config: { service: 'bing', tts: { voiceEn: 'en-US-AriaNeural', voiceZh: 'zh-CN-XiaoxiaoNeural', rate: 0 } },
          }),
        };
      }
      if (u.includes('/api/config')) {
        return { ok: true, status: 200, json: async () => ({ defaultRoot: ROOT_DIR, defaultFile: '' }) };
      }
      if (u.includes('/api/browse')) {
        return { ok: true, status: 200, json: async () => ({ entries: [] }) };
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
  sandbox.setPlayBehavior = (b) => { audioPlayBehavior = b; };

  vm.runInNewContext(formatsCode, sandbox, { filename: 'public/formats.js' });
  vm.runInNewContext(code, sandbox, { filename: 'public/app.js' });
  return { sandbox, fetchCalls, audioInstances, speechCalls, getEl };
}

test('splitTtsChunks splits short, >1200-char, unpunctuated, and CJK paragraphs cleanly', async () => {
  const { sandbox } = loadFrontendHarness();
  await new Promise((r) => setTimeout(r, 20));
  const split = sandbox.__reader.tts.splitChunks;

  // 短句不拆分；极短首片段（如编号）与下一句合并以保证自然停顿
  assert.deepStrictEqual(Array.from(split('Hello world.')), ['Hello world.']);
  assert.deepStrictEqual(
    Array.from(split('Step 1. Click the start button to listen.')),
    ['Step 1. Click the start button to listen.']
  );

  // 长英文段落：首块 <= 200，所有块 <= 1000，不丢失文本
  const sents = [];
  for (let i = 1; i <= 18; i++) {
    sents.push('Sentence number ' + i + ' explains why streaming neural speech synthesis dramatically reduces wait time.');
  }
  const longPara = sents.join(' ');
  assert.ok(longPara.length > 1600);
  const chunks = split(longPara);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks[0].length <= 200, 'first chunk should be <= 200 chars, got ' + chunks[0].length);
  for (const c of chunks) {
    assert.ok(c.length > 0 && c.length <= 1000, 'chunk length must be <= 1000, got ' + c.length);
  }
  assert.ok(chunks.join(' ').includes('Sentence number 18'));

  // 无标点长英文
  const unpunctuatedEn = Array.from({ length: 240 }, (_, i) => 'word' + i).join(' ');
  assert.ok(unpunctuatedEn.length > 1400);
  const enNoPunctChunks = split(unpunctuatedEn);
  assert.ok(enNoPunctChunks[0].length <= 200);
  for (const c of enNoPunctChunks) assert.ok(c.length <= 1000);

  // 中文带标点与无标点超长文本
  const zhLong = '这是一个用于测试中文长段落自动分块的句子，保证第一块足够短且每块不超过上限。'.repeat(40);
  const zhChunks = split(zhLong);
  assert.ok(zhChunks[0].length <= 200);
  for (const c of zhChunks) assert.ok(c.length <= 1000);

  const zhNoPunct = '中文无标点长文本测试'.repeat(160);
  const zhNoPunctChunks = split(zhNoPunct);
  assert.ok(zhNoPunctChunks[0].length <= 200);
  for (const c of zhNoPunctChunks) assert.ok(c.length <= 1000);
});

test('boot deduplicates /api/translate/status and pause-while-buffering does not trigger speechSynthesis', async () => {
  const { sandbox, fetchCalls, audioInstances, speechCalls, getEl } = loadFrontendHarness();

  await new Promise((r) => setTimeout(r, 30));
  const statusCalls = fetchCalls.filter((u) => u.includes('/api/translate/status'));
  assert.equal(statusCalls.length, 1, 'boot should only call /api/translate/status once');

  // 测试缓冲期暂停不触发 speechSynthesis 兜底
  sandbox.setPlayBehavior('abort-on-pause');
  sandbox.__reader.tts.state.segments = [
    { text: 'First segment buffering test.' },
    { text: 'Second segment for prefetch.' },
  ];
  sandbox.__reader.tts.state.mode = 'article';
  // 直接通过点击 #tts-play 触发 playSegment(0) -> pause
  sandbox.__reader.tts.state.index = 0;
  getEl('#tts-play').click(); // tts.audio is null -> calls playSegment(0)
  assert.equal(audioInstances.length, 1);

  // 在 audio.play() 尚未 resolve 时立刻点击暂停
  getEl('#tts-play').click();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sandbox.__reader.tts.state.paused, true);
  assert.equal(speechCalls.length, 0, 'AbortError during pause-while-buffering must NOT invoke speechSynthesis');

  // 恢复播放并完成，且验证预取只发生在 onplaying 之后
  const prefetchBeforePlaying = fetchCalls.filter((u) => u.includes('/api/tts'));
  assert.equal(prefetchBeforePlaying.length, 0, 'next segment must NOT prefetch before current audio starts playing');

  sandbox.setPlayBehavior('resolve');
  getEl('#tts-play').click(); // resume
  audioInstances[0].onplaying();
  await new Promise((r) => setTimeout(r, 20));
  const prefetchAfterPlaying = fetchCalls.filter((u) => u.includes('/api/tts'));
  assert.equal(prefetchAfterPlaying.length, 1, 'next segment should prefetch after current audio fires playing');
});

test('speakOne rapid A->B switch cancels A and starts B cleanly with post-start prefetch', async () => {
  const { sandbox, fetchCalls, audioInstances } = loadFrontendHarness();
  await new Promise((r) => setTimeout(r, 20));
  const ttsFetchBefore = fetchCalls.filter((u) => u.includes('/api/tts')).length;

  const paraA = 'Paragraph A first sentence. Paragraph A second sentence that is long enough to be chunked separately if needed. ' +
    'Paragraph A third sentence adds more length so total exceeds two hundred characters easily.';
  const paraB = 'Paragraph B first sentence. Paragraph B second sentence.';

  sandbox.__reader.tts.speak(paraA, null);
  assert.equal(audioInstances.length, 1);
  const audioA = audioInstances[0];

  // 快速切到 B
  sandbox.__reader.tts.speak(paraB, null);
  assert.equal(audioA.paused, true, 'paragraph A audio must be stopped on switch');
  assert.equal(audioInstances.length, 2);
  const textB = new URL(audioInstances[1].src).searchParams.get('text') || '';
  assert.ok(textB.includes('Paragraph B'), 'expected Paragraph B in audio src, got: ' + textB);

  // 触发 B 的 onplaying -> 应当记录 lastMetric，并在 playing 后才预取 B 的第 2 块
  assert.equal(fetchCalls.filter((u) => u.includes('/api/tts')).length, ttsFetchBefore);
  audioInstances[1].onplaying();
  await new Promise((r) => setTimeout(r, 10));
  const m = sandbox.__reader.tts.lastMetric;
  assert.ok(m && m.how === 'audio' && m.latencyMs >= 0, 'lastMetric should record playing latency');
  const prefetched = fetchCalls.filter((u) => u.includes('/api/tts'));
  assert.equal(prefetched.length, ttsFetchBefore + 1, 'chunk 1 should prefetch only after chunk 0 starts playing');

  audioInstances[1].onended();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(audioInstances.length, 3, 'chunk 1 should play after chunk 0 ends');
  audioInstances[2].onended();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sandbox.__reader.tts.state.playing, false);
});

test('splitTtsChunks preserves UTF-16 surrogate pairs and ASCII clause punctuation spaces', async () => {
  const { sandbox } = loadFrontendHarness();
  await new Promise((r) => setTimeout(r, 20));
  const split = sandbox.__reader.tts.splitChunks;

  // 1. Surrogate pair at chunk 0 boundary (index 199..200) and rest chunk boundary (799..800)
  const emoji199 = 'a'.repeat(199) + '😀' + 'b'.repeat(300);
  const c1 = Array.from(split(emoji199, 200, 800));
  assert.equal(c1.length, 2);
  assert.equal(c1[0], 'a'.repeat(199));
  assert.ok(c1[1].startsWith('😀'));
  for (const ch of c1) {
    assert.doesNotThrow(() => encodeURIComponent(ch), 'chunk must be valid UTF-16');
    const encoded = new URLSearchParams({ text: ch }).toString();
    assert.equal(encoded.includes('%EF%BF%BD'), false, 'must not contain U+FFFD replacement: ' + encoded);
  }
  assert.equal(c1.join('').replace(/\s+/g, ''), emoji199);

  const emoji799 = 'a'.repeat(150) + '. ' + 'b'.repeat(799) + '😀' + 'c'.repeat(200);
  const c2 = Array.from(split(emoji799, 200, 800));
  assert.ok(c2.length >= 3);
  for (const ch of c2) {
    assert.doesNotThrow(() => encodeURIComponent(ch), 'rest chunk must be valid UTF-16');
    assert.equal(new URLSearchParams({ text: ch }).toString().includes('%EF%BF%BD'), false);
  }

  // 2. Preserves space after ASCII clause punctuation [,;:-] when merging clauses
  const clauseText = 'Alpha, beta; gamma: delta - epsilon, ' + 'word '.repeat(60);
  const c3 = Array.from(split(clauseText, 200, 800));
  assert.ok(c3[0].includes('Alpha, beta; gamma: delta - epsilon,'), 'expected spaces after clause punctuation, got: ' + c3[0]);
  assert.equal(c3[0].includes('Alpha,beta'), false);
  assert.equal(c3[0].includes('beta;gamma'), false);
});

test('frontend state machine guards unexpected AbortError, start->stop->start loading race, and stopTts lastMetric', async () => {
  const { sandbox, audioInstances, speechCalls, getEl } = loadFrontendHarness();
  await new Promise((r) => setTimeout(r, 20));

  // Make mocked speechSynthesis settle via onend so fallback completes deterministically
  const origSpeak = sandbox.speechSynthesis.speak;
  sandbox.speechSynthesis.speak = (u) => {
    origSpeak(u);
    setImmediate(() => { if (typeof u.onend === 'function') u.onend(); });
  };

  // 1. Unexpected AbortError when !tts.paused must settle tts.playing (not hang true)
  sandbox.setPlayBehavior('abort-on-pause');
  sandbox.__reader.tts.speak('Unexpected abort test sentence.', null);
  assert.equal(sandbox.__reader.tts.state.playing, true);
  assert.equal(sandbox.__reader.tts.state.paused, false);
  assert.equal(audioInstances.length, 1);
  // Trigger AbortError without setting tts.paused = true
  audioInstances[0].pause();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(speechCalls.length, 1, 'unexpected AbortError while !paused must invoke fallback');
  assert.equal(sandbox.__reader.tts.state.playing, false, 'unexpected AbortError while !paused must settle tts.playing to false');

  // 2. stopTts() clears stale lastMetric
  sandbox.setPlayBehavior('resolve');
  sandbox.__reader.tts.speak('Metric reset check.', null);
  audioInstances[1].onplaying();
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(sandbox.__reader.tts.lastMetric && sandbox.__reader.tts.lastMetric.playingAt > 0);
  sandbox.__reader.tts.stop();
  assert.equal(sandbox.__reader.tts.lastMetric, null, 'stopTts must clear stale lastMetric');

  // 3. startArticle() -> stop() -> startArticle() race must not clear loading prematurely
  let pdfReqCount = 0;
  const pdfResolvers = [];
  sandbox.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/pdf-text')) {
      pdfReqCount++;
      return new Promise((resolve) => {
        pdfResolvers.push(() =>
          resolve({
            ok: true,
            status: 200,
            json: async () => ({ path: 'a.pdf', pages: ['First page sentence.'], lang: 'en', mtime: pdfReqCount }),
          })
        );
      });
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  sandbox.__reader.state.currentFile = 'doc1.pdf';
  const p1 = sandbox.__reader.tts.start();
  assert.equal(sandbox.__reader.tts.state.loading, true);
  sandbox.__reader.tts.stop();
  assert.equal(sandbox.__reader.tts.state.loading, false);
  sandbox.__reader.state.currentFile = 'doc2.pdf';
  const p2 = sandbox.__reader.tts.start();
  assert.equal(sandbox.__reader.tts.state.loading, true);

  // Resolve the first (cancelled) request while the second is still pending
  pdfResolvers[0]();
  await p1;
  assert.equal(sandbox.__reader.tts.state.loading, true, 'first cancelled startArticle must NOT clear second startArticle loading flag');

  // Resolve the second request
  pdfResolvers[1]();
  await p2;
  assert.equal(sandbox.__reader.tts.state.loading, false, 'second startArticle must clear loading once finished');
  getEl('#tts-stop').click();
});

test('WebAudio streaming player decodes MP3 frames, handles rate/pause/fallback cleanly', async () => {
  const { sandbox, audioInstances } = loadFrontendHarness();
  await new Promise((r) => setTimeout(r, 20));

  const startedNodes = [];
  let ctxState = 'running';
  let decodeShouldReject = false;

  // Build valid 24kHz 48kbps MPEG-2 Layer III frames (header 0xFF 0xF3 0x64 0xC4 -> 144 bytes/frame)
  const frameCount = 12;
  const mp3Bytes = new Uint8Array(frameCount * 144);
  for (let f = 0; f < frameCount; f++) {
    const off = f * 144;
    mp3Bytes[off] = 0xff;
    mp3Bytes[off + 1] = 0xf3;
    mp3Bytes[off + 2] = 0x64;
    mp3Bytes[off + 3] = 0xc4;
  }

  sandbox.ReadableStream = function () {};
  sandbox.AudioContext = function () {
    return {
      get state() { return ctxState; },
      currentTime: 10,
      destination: {},
      resume: async () => { ctxState = 'running'; },
      suspend: async () => { ctxState = 'suspended'; },
      decodeAudioData: async (ab) => {
        if (decodeShouldReject) throw new Error('decode failed');
        const approxFrames = Math.max(1, Math.round(ab.byteLength / 144));
        return { duration: approxFrames * 0.024, length: approxFrames * 1152, sampleRate: 48000 };
      },
      createBufferSource: () => {
        const node = {
          buffer: null,
          playbackRate: { value: 1 },
          onended: null,
          connect() {},
          disconnect() {},
          start(when, offset, dur) {
            startedNodes.push({ node, when, offset, dur, rate: node.playbackRate.value });
          },
          stop() {},
        };
        return node;
      },
    };
  };

  sandbox.fetch = async (url) => {
    if (String(url).includes('/api/tts')) {
      let idx = 0;
      const parts = [mp3Bytes.slice(0, 6 * 144), mp3Bytes.slice(6 * 144)];
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: async () => (idx < parts.length ? { done: false, value: parts[idx++] } : { done: true, value: undefined }),
          }),
        },
      };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const p = sandbox.__reader.tts.speak('WebAudio streaming test.', null);
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(startedNodes.length >= 1, 'WebAudio should start BufferSourceNode playback');
  assert.equal(sandbox.__reader.tts.lastMetric.how, 'audio');
  assert.equal(audioInstances.length, 0, 'should not use HTMLAudioElement when WebAudio succeeds');

  // Dynamic rate change updates playbackRate
  sandbox.__reader.tts.state.audio.playbackRate = 1.3;
  assert.equal(sandbox.__reader.tts.state.audio.playbackRate, 1.3);

  // Pause/resume suspends/resumes context
  sandbox.__reader.tts.state.audio.pause();
  assert.equal(ctxState, 'suspended');
  await sandbox.__reader.tts.state.audio.play();
  assert.equal(ctxState, 'running');

  // Finish playback
  for (const entry of startedNodes) {
    if (typeof entry.node.onended === 'function') entry.node.onended();
  }
  await p;
  assert.equal(sandbox.__reader.tts.state.playing, false);

  // Fallback to HTMLAudioElement if decodeAudioData fails before playback starts
  decodeShouldReject = true;
  sandbox.__reader.tts.speak('WebAudio fallback test.', null);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(audioInstances.length, 1, 'should fall back to HTMLAudioElement when decodeAudioData fails');
  sandbox.__reader.tts.stop();
});

test('translator worker tolerates intentional kill & transient pre-ready failures and passes --text= in CLI fallback', async () => {
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const tmpLocal = makeTempDir('fp-worker-guard-');
  const prevLocal = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = tmpLocal;

  const fakeExe = path.join(tmpLocal, 'edge-tts.exe');
  const fakePy = path.join(tmpLocal, 'python.exe');
  fs.writeFileSync(fakeExe, 'stub', 'utf8');
  fs.writeFileSync(fakePy, 'stub', 'utf8');
  fs.mkdirSync(path.join(tmpLocal, 'folioprism'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpLocal, 'folioprism', 'config.json'),
    JSON.stringify({ tts: { edgeTtsPath: fakeExe } }),
    'utf8'
  );

  const origSpawn = cp.spawn;
  const spawnedCmds = [];
  let pythonBehavior = 'exit-1'; // 'exit-1' | 'ready' | 'hang'

  cp.spawn = function patchedSpawn(cmd, args) {
    spawnedCmds.push({ cmd, args: args ? args.slice() : [] });
    const proc = new EventEmitter();
    proc.pid = 90000 + spawnedCmds.length;
    proc.killed = false;
    proc.exitCode = null;
    proc.stdin = new PassThrough();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.kill = () => {
      proc.killed = true;
      proc.exitCode = 1;
      setImmediate(() => proc.emit('close', 1));
    };

    if (cmd === fakePy) {
      if (pythonBehavior === 'exit-1') {
        setImmediate(() => {
          proc.exitCode = 1;
          proc.emit('close', 1);
        });
      } else if (pythonBehavior === 'ready') {
        setImmediate(() => {
          proc.stdout.write(JSON.stringify({ type: 'ready' }) + '\n');
        });
      }
    } else if (cmd === fakeExe) {
      setImmediate(() => {
        proc.stdout.write(Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00' + 'A'.repeat(120)));
        proc.exitCode = 0;
        proc.emit('close', 0);
      });
    }
    return proc;
  };

  const translatorPath = require.resolve('../translator');
  delete require.cache[translatorPath];
  const translator = require('../translator');

  try {
    // 1. Intentional killAllChildren() before ready must NOT blacklist python.exe
    pythonBehavior = 'hang';
    const pWarm = translator.warmTtsWorker();
    translator.killAllChildren();
    const wKilled = await pWarm;
    assert.equal(wKilled, null);

    // Next attempt with healthy ready succeeds (was not blacklisted!)
    pythonBehavior = 'ready';
    const wOk = await translator.warmTtsWorker();
    assert.ok(wOk && wOk.ready === true, 'intentional pre-ready kill must NOT blacklist python');
    translator.killAllChildren();

    // 2. Two unexpected pre-ready failures must NOT permanently blacklist; 3rd ready succeeds & resets count
    pythonBehavior = 'exit-1';
    assert.equal(await translator.warmTtsWorker(), null);
    assert.equal(await translator.warmTtsWorker(), null);
    pythonBehavior = 'ready';
    const wRecovered = await translator.warmTtsWorker();
    assert.ok(wRecovered && wRecovered.ready === true, '2 pre-ready failures must not blacklist python');
    translator.killAllChildren();

    // 3. Three consecutive unexpected pre-ready failures DO blacklist python, falling back to CLI with --text=
    pythonBehavior = 'exit-1';
    assert.equal(await translator.warmTtsWorker(), null);
    assert.equal(await translator.warmTtsWorker(), null);
    assert.equal(await translator.warmTtsWorker(), null);
    const pyCallsBefore = spawnedCmds.filter((c) => c.cmd === fakePy).length;
    assert.equal(await translator.warmTtsWorker(), null);
    assert.equal(spawnedCmds.filter((c) => c.cmd === fakePy).length, pyCallsBefore, 'blacklisted python should not respawn');

    // CLI fallback passes --text=--help as single flag-safe argument
    const stream = await translator.streamSpeech('--help', { voice: 'en-US-AriaNeural', rate: 0 });
    await new Promise((resolve, reject) => {
      const unsub = stream.subscribe({
        onChunk: () => {},
        onEnd: () => { unsub(); resolve(); },
        onError: reject,
      });
    });
    const cliCall = spawnedCmds.find((c) => c.cmd === fakeExe);
    assert.ok(cliCall, 'CLI fallback should be invoked');
    assert.ok(cliCall.args.includes('--text=--help'), 'CLI fallback must pass --text=--help, got: ' + JSON.stringify(cliCall.args));
  } finally {
    translator.killAllChildren();
    cp.spawn = origSpawn;
    delete require.cache[translatorPath];
    process.env.LOCALAPPDATA = prevLocal;
    rmrf(tmpLocal);
  }
});

test('server shutdown closes HTTP socket and HEAD /api/tts synchronous replay unsubscribes cleanly', async (t) => {
  const realPy = path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'uv', 'tools', 'edge-tts', 'Scripts', 'python.exe'
  );
  if (!fs.existsSync(realPy)) {
    t.skip('uv edge-tts python.exe not installed on host');
    return;
  }

  const tmpRoot = makeTempDir('fp-srv-hard-');
  const fakeLocalAppData = path.join(tmpRoot, 'localapp');
  const appDir = path.join(fakeLocalAppData, 'folioprism');
  const fakeSiteDir = path.join(tmpRoot, 'fake-site');
  const fakeEdgePkg = path.join(fakeSiteDir, 'edge_tts');
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(fakeEdgePkg, { recursive: true });
  fs.writeFileSync(
    path.join(fakeEdgePkg, '__init__.py'),
    [
      'import asyncio',
      'class Communicate:',
      '    def __init__(self, text, voice="en-US-AriaNeural", rate="+0%", connector=None):',
      '        self.text = text',
      '    async def stream(self):',
      '        await asyncio.sleep(0.02)',
      '        yield {"type": "audio", "data": b"ID3\\x03\\x00\\x00\\x00\\x00\\x00\\x00" + (b"A" * 120)}',
      '        await asyncio.sleep(0.35)',
      '        yield {"type": "audio", "data": b"B" * 200}',
    ].join('\n'),
    'utf8'
  );
  const realEdgeExe = path.join(path.dirname(realPy), 'edge-tts.exe');
  fs.writeFileSync(path.join(appDir, 'config.json'), JSON.stringify({ tts: { edgeTtsPath: realEdgeExe } }), 'utf8');

  const port = 7896;
  const token = 'hardening-token-1234';
  const harnessPath = path.join(tmpRoot, 'srv_hard.js');
  fs.writeFileSync(
    harnessPath,
    [
      `'use strict';`,
      `process.argv.push('--port=${port}', '--token=${token}', '--no-open');`,
      `const server = require(${JSON.stringify(path.join(ROOT_DIR, 'server.js'))});`,
      `const translator = require(${JSON.stringify(path.join(ROOT_DIR, 'translator.js'))});`,
      `server.start({ port: ${port}, root: ${JSON.stringify(ROOT_DIR)}, openBrowser: false }).then(async () => {`,
      `  await translator.warmTtsWorker();`,
      `  process.stdout.write('READY\\n');`,
      `});`,
      `process.stdin.setEncoding('utf8');`,
      `process.stdin.on('data', (d) => { if (d.includes('shutdown')) { server.shutdown(); setTimeout(() => process.exit(0), 250); } });`,
    ].join('\n'),
    'utf8'
  );

  const srv = cp.spawn(process.execPath, [harnessPath], {
    cwd: ROOT_DIR,
    windowsHide: true,
    env: Object.assign({}, process.env, { LOCALAPPDATA: fakeLocalAppData, PYTHONPATH: fakeSiteDir }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  try {
    await new Promise((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error('timeout')), 15000);
      srv.stdout.on('data', (d) => {
        out += d.toString();
        if (out.includes('READY')) { clearTimeout(timer); resolve(); }
      });
    });

    // Start GET request so job buffers chunk 1 while still in-flight, then issue HEAD /api/tts on same text
    const txt = encodeURIComponent('Synchronous replay HEAD test.');
    const getPromise = httpRequest(port, '/api/tts?token=' + token + '&text=' + txt);
    await new Promise((r) => setTimeout(r, 120));
    const headRes = await httpRequest(port, '/api/tts?token=' + token + '&text=' + txt, { method: 'HEAD' });
    assert.equal(headRes.status, 200);
    assert.equal(headRes.body.length, 0);
    const getRes = await getPromise;
    assert.equal(getRes.status, 200);
    assert.equal(getRes.body.length, 330);

    // Trigger server.shutdown() and verify HTTP listening socket is closed immediately
    srv.stdin.write('shutdown\n');
    srv.stdin.end();
    await new Promise((r) => setTimeout(r, 120));
    await assert.rejects(() => httpRequest(port, '/api/health'));
  } finally {
    if (srv.exitCode === null) {
      try { cp.spawnSync('taskkill', ['/pid', String(srv.pid), '/T', '/F'], { windowsHide: true }); } catch (_) {}
    }
    rmrf(tmpRoot);
  }
});

test('playSpeech onFallback does not auto-play HTMLAudioElement while tts.paused and recovers on resume', async () => {
  const { sandbox, audioInstances, speechCalls, getEl } = loadFrontendHarness();
  await new Promise((r) => setTimeout(r, 20));

  const frameCount = 12;
  const mp3Bytes = new Uint8Array(frameCount * 144);
  for (let f = 0; f < frameCount; f++) {
    const off = f * 144;
    mp3Bytes[off] = 0xff;
    mp3Bytes[off + 1] = 0xf3;
    mp3Bytes[off + 2] = 0x64;
    mp3Bytes[off + 3] = 0xc4;
  }

  let rejectDecode;
  let decodeShouldReject = true;
  sandbox.ReadableStream = function () {};
  sandbox.AudioContext = function () {
    return {
      state: 'running',
      currentTime: 10,
      destination: {},
      resume: async () => {},
      suspend: async () => {},
      decodeAudioData: () => {
        if (!decodeShouldReject) {
          return Promise.resolve({ duration: 0.288, length: 13824, sampleRate: 48000 });
        }
        return new Promise((_, rej) => {
          rejectDecode = () => rej(new Error('corrupt mp3'));
        });
      },
      createBufferSource: () => ({
        buffer: null,
        playbackRate: { value: 1 },
        onended: null,
        connect() {},
        disconnect() {},
        start() {},
        stop() {},
      }),
    };
  };

  sandbox.fetch = async (url) => {
    if (String(url).includes('/api/tts')) {
      let idx = 0;
      const parts = [mp3Bytes];
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: async () => (idx < parts.length ? { done: false, value: parts[idx++] } : { done: true, value: undefined }),
          }),
        },
      };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  sandbox.__reader.tts.state.segments = [{ text: 'Pause fallback regression sentence.' }];
  sandbox.__reader.tts.state.mode = 'article';
  sandbox.__reader.tts.state.index = 0;

  // 1. Start segment 0 while decodeAudioData is pending, then pause via #tts-play
  getEl('#tts-play').click();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(typeof rejectDecode, 'function', 'decodeAudioData should be in flight');

  getEl('#tts-play').click();
  assert.equal(sandbox.__reader.tts.state.paused, true);
  assert.equal(sandbox.__reader.tts.state.playing, false);

  // 2. Reject decodeAudioData while paused -> onFallback MUST NOT start HTMLAudioElement or speechSynthesis
  rejectDecode();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(audioInstances.length, 0, 'HTMLAudioElement must NOT be constructed/played while tts.paused === true');
  assert.equal(speechCalls.length, 0, 'speechSynthesis must NOT run while tts.paused === true');
  assert.equal(sandbox.__reader.tts.state.paused, true);
  assert.ok(sandbox.__reader.tts.state.audio && sandbox.__reader.tts.state.audio.error, 'activeError should be retained for resume recovery');

  // 3. Resume via #tts-play -> toggleTtsPause detects error and replays segment cleanly
  decodeShouldReject = false;
  getEl('#tts-play').click();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(sandbox.__reader.tts.state.paused, false);
  assert.equal(sandbox.__reader.tts.state.playing, true);
  assert.equal(audioInstances.length, 0);
  sandbox.__reader.tts.stop();
});

test('createWebAudioTtsPlayer applyRate prevents segment overlap across multiple rate changes', async () => {
  const { sandbox } = loadFrontendHarness();
  await new Promise((r) => setTimeout(r, 20));

  const startLog = [];
  let mockTime = 10.0;
  let decodeIdx = 0;

  // Build two 16-frame MPEG-2 Layer III batches so both seg0 and seg1 enqueue cleanly
  const makeBatch = (count) => {
    const b = new Uint8Array(count * 144);
    for (let f = 0; f < count; f++) {
      const off = f * 144;
      b[off] = 0xff;
      b[off + 1] = 0xf3;
      b[off + 2] = 0x64;
      b[off + 3] = 0xc4;
    }
    return b;
  };
  const batch0 = makeBatch(6);
  const batch1 = makeBatch(16);

  sandbox.ReadableStream = function () {};
  sandbox.AudioContext = function () {
    return {
      state: 'running',
      get currentTime() { return mockTime; },
      destination: {},
      resume: async () => {},
      suspend: async () => {},
      decodeAudioData: async () => {
        const idx = decodeIdx++;
        // Give seg0 dur=1.0s (after skipSec=0) and seg1 dur=1.048s (skipSec=0.048 -> playDurSec=1.0)
        return idx === 0
          ? { duration: 1.0, length: 48000, sampleRate: 48000 }
          : { duration: 1.048, length: 50304, sampleRate: 48000 };
      },
      createBufferSource: () => {
        const node = {
          buffer: null,
          playbackRate: { value: 1 },
          onended: null,
          connect() {},
          disconnect() {},
          start(when, offset, dur) {
            startLog.push({ node, when, offset, dur, rate: node.playbackRate.value });
          },
          stop() {},
        };
        return node;
      },
    };
  };

  sandbox.fetch = async (url) => {
    if (String(url).includes('/api/tts')) {
      let idx = 0;
      const parts = [batch0, batch1];
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: async () => (idx < parts.length ? { done: false, value: parts[idx++] } : { done: true, value: undefined }),
          }),
        },
      };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  sandbox.__reader.tts.speak('Double rate change overlap regression test.', null);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(startLog.length, 2, 'expected initial scheduling of seg0 and seg1');
  assert.ok(Math.abs(startLog[0].when - 10.005) < 1e-6);
  assert.ok(Math.abs(startLog[1].when - 11.005) < 1e-6);

  // First rate change at t=10.205: 0.2s played at 1.0x -> 0.8s remaining at 2.0x -> seg0 ends at 10.605
  mockTime = 10.205;
  sandbox.__reader.tts.state.audio.playbackRate = 2.0;
  assert.equal(startLog.length, 3);
  assert.ok(Math.abs(startLog[2].when - 10.605) < 1e-6, 'first reschedule should place seg1 at 10.605, got ' + startLog[2].when);

  // Second rate change at t=10.405: +0.2s played at 2.0x (=0.4s buf, total 0.6s buf) -> 0.4s remaining at 0.5x -> seg0 ends at 11.205
  mockTime = 10.405;
  sandbox.__reader.tts.state.audio.playbackRate = 0.5;
  assert.equal(startLog.length, 4);
  const seg1When = startLog[3].when;
  const seg0ActualEnd = 10.405 + (1.0 - (0.2 * 1.0 + 0.2 * 2.0)) / 0.5; // 11.205
  assert.ok(
    seg1When >= seg0ActualEnd - 1e-9,
    'seg1 rescheduled when (' + seg1When + ') must be >= seg0 actual end (' + seg0ActualEnd + ')'
  );
  sandbox.__reader.tts.stop();
});

test('TTS_WORKER_SCRIPT closes all non-winning WS on dual-completion/cancel, partitions standby_pool atomically, and avoids bad-IP mark on non-speakable NoAudioReceived', async (t) => {
  const realPy = path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'uv', 'tools', 'edge-tts', 'Scripts', 'python.exe'
  );
  if (!fs.existsSync(realPy)) {
    t.skip('uv edge-tts python.exe not installed on host');
    return;
  }

  const tmpRoot = makeTempDir('fp-ws-races-');
  const tmpLocal = path.join(tmpRoot, 'localapp');
  const appDir = path.join(tmpLocal, 'folioprism');
  fs.mkdirSync(appDir, { recursive: true });
  const realEdgeExe = path.join(path.dirname(realPy), 'edge-tts.exe');
  fs.writeFileSync(path.join(appDir, 'config.json'), JSON.stringify({ tts: { edgeTtsPath: realEdgeExe } }), 'utf8');

  // Extract the exact TTS_WORKER_SCRIPT string via warmTtsWorker() spawn interception
  const origSpawn = cp.spawn;
  const prevLocal = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = tmpLocal;
  let capturedWorkerScript = '';
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  cp.spawn = function captureSpawn(cmd, args) {
    if (args && args[0] === '-u' && args[1] === '-c') {
      capturedWorkerScript = args[2];
    }
    const p = new EventEmitter();
    p.pid = 99999;
    p.killed = false;
    p.exitCode = null;
    p.stdin = new PassThrough();
    p.stdout = new PassThrough();
    p.stderr = new PassThrough();
    p.kill = () => { p.killed = true; p.exitCode = 0; setImmediate(() => p.emit('close', 0)); };
    setImmediate(() => p.stdout.write(JSON.stringify({ type: 'ready' }) + '\n'));
    return p;
  };
  const translatorPath = require.resolve('../translator');
  delete require.cache[translatorPath];
  const translator = require('../translator');
  try {
    await translator.warmTtsWorker();
  } finally {
    translator.killAllChildren();
    cp.spawn = origSpawn;
    delete require.cache[translatorPath];
    process.env.LOCALAPPDATA = prevLocal;
  }
  assert.ok(capturedWorkerScript.includes('stream_part_hedged'), 'captured TTS_WORKER_SCRIPT');

  const workerFile = path.join(tmpRoot, 'worker_script.py');
  fs.writeFileSync(workerFile, capturedWorkerScript, 'utf8');

  const pyHarness = path.join(tmpRoot, 'run_ws_races.py');
  fs.writeFileSync(
    pyHarness,
    [
      'import asyncio, json, os, re, sys, threading, time',
      'from aiohttp import web',
      'import aiohttp',
      '',
      'server_port = 0',
      'server_ready = threading.Event()',
      'server_loop_box = [None]',
      'ws_records = {}',
      'server_ws_by_cid = {}',
      'ssml_by_cid = {}',
      'dual_gate = None',
      'burst_stale_cid = None',
      '',
      'def make_audio_frame():',
      '    hdr = b"X-RequestId:abc\\r\\nContent-Type:audio/mpeg\\r\\nPath:audio"',
      '    return (2 + len(hdr)).to_bytes(2, "big") + hdr + b"\\r\\n" + (b"\\xff\\xf3\\x64\\xc4" + b"\\x00" * 140)',
      '',
      'def make_turn_end():',
      '    return "X-RequestId:abc\\r\\nContent-Type:application/json; charset=utf-8\\r\\nPath:turn.end\\r\\n\\r\\n{}"',
      '',
      'async def ws_handler(request):',
      '    global dual_gate',
      '    cid = int(request.headers.get("X-Test-Cid", "0"))',
      '    ws = web.WebSocketResponse()',
      '    await ws.prepare(request)',
      '    server_ws_by_cid[cid] = ws',
      '    ssml_by_cid[cid] = []',
      '    try:',
      '        async for msg in ws:',
      '            if msg.type == aiohttp.WSMsgType.TEXT:',
      '                if "Path:ssml" in msg.data:',
      '                    m = re.search(r"<prosody[^>]*>(.*?)</prosody>", msg.data, re.S)',
      '                    txt = m.group(1) if m else msg.data',
      '                    ssml_by_cid[cid].append(txt)',
      '                    if "DUAL_HEDGE" in txt:',
      '                        if dual_gate is None:',
      '                            dual_gate = asyncio.Event()',
      '                            await asyncio.wait_for(dual_gate.wait(), timeout=4.0)',
      '                        else:',
      '                            dual_gate.set()',
      '                        await ws.send_bytes(make_audio_frame())',
      '                        await asyncio.sleep(0.01)',
      '                        await ws.send_str(make_turn_end())',
      '                    elif "CANCEL_HEDGE" in txt:',
      '                        await asyncio.sleep(3.0)',
      '                    elif "NON_SPEAKABLE" in txt or txt.strip() == "...":',
      '                        await ws.send_str(make_turn_end())',
      '                    else:',
      '                        await ws.send_bytes(make_audio_frame())',
      '                        await ws.send_str(make_turn_end())',
      '    except Exception:',
      '        pass',
      '    return ws',
      '',
      'def run_server():',
      '    global server_port',
      '    loop = asyncio.new_event_loop()',
      '    asyncio.set_event_loop(loop)',
      '    server_loop_box[0] = loop',
      '    app = web.Application()',
      '    app.router.add_get("/ws", ws_handler)',
      '    runner = web.AppRunner(app)',
      '    loop.run_until_complete(runner.setup())',
      '    site = web.TCPSite(runner, "127.0.0.1", 0)',
      '    loop.run_until_complete(site.start())',
      '    server_port = site._server.sockets[0].getsockname()[1]',
      '    server_ready.set()',
      '    loop.run_forever()',
      '',
      't = threading.Thread(target=run_server, daemon=True)',
      't.start()',
      'server_ready.wait(timeout=5.0)',
      '',
      'captured_connectors = []',
      'orig_init = aiohttp.ClientSession.__init__',
      'def hooked_init(self, *args, **kwargs):',
      '    if kwargs.get("connector") is not None:',
      '        captured_connectors.append(kwargs["connector"])',
      '    return orig_init(self, *args, **kwargs)',
      'aiohttp.ClientSession.__init__ = hooked_init',
      '',
      'cid_counter = [0]',
      'orig_ws_connect = aiohttp.ClientSession.ws_connect',
      'async def hooked_ws_connect(self, url, **kwargs):',
      '    cid_counter[0] += 1',
      '    cid = cid_counter[0]',
      '    hdrs = dict(kwargs.get("headers") or {})',
      '    hdrs["X-Test-Cid"] = str(cid)',
      '    kwargs["headers"] = hdrs',
      '    kwargs.pop("ssl", None)',
      '    local_url = f"ws://127.0.0.1:{server_port}/ws?cid={cid}"',
      '    ws = await orig_ws_connect(self, local_url, **kwargs)',
      '    ws_records[cid] = {"cid": cid, "closed": False, "ws": ws}',
      '    orig_close = ws.close',
      '    async def tracked_close(*a, **kw):',
      '        if cid == burst_stale_cid:',
      '            await asyncio.sleep(0.08)',
      '        try:',
      '            return await orig_close(*a, **kw)',
      '        finally:',
      '            ws_records[cid]["closed"] = True',
      '    ws.close = tracked_close',
      '    return ws',
      'aiohttp.ClientSession.ws_connect = hooked_ws_connect',
      '',
      'r_in, w_in = os.pipe()',
      'r_out, w_out = os.pipe()',
      'orig_stdin = sys.stdin',
      'orig_stdout = sys.stdout',
      'sys.stdin = os.fdopen(r_in, "r", encoding="utf-8", buffering=1)',
      'sys.stdout = os.fdopen(w_out, "w", encoding="utf-8", buffering=1)',
      'cmd_writer = os.fdopen(w_in, "w", encoding="utf-8", buffering=1)',
      'ev_reader = os.fdopen(r_out, "r", encoding="utf-8", buffering=1)',
      '',
      'events = []',
      'events_lock = threading.Lock()',
      'ready_ev = threading.Event()',
      'job_done_evs = {}',
      'def read_events():',
      '    for line in ev_reader:',
      '        line = line.strip()',
      '        if not line:',
      '            continue',
      '        obj = json.loads(line)',
      '        with events_lock:',
      '            events.append(obj)',
      '        if obj.get("type") == "ready":',
      '            ready_ev.set()',
      '        jid = obj.get("id")',
      '        if jid in job_done_evs and obj.get("type") in ("end", "error", "pong"):',
      '            job_done_evs[jid].set()',
      '',
      'threading.Thread(target=read_events, daemon=True).start()',
      '',
      'def send_cmd(obj):',
      '    jid = obj.get("id")',
      '    if jid is not None and obj.get("type") in ("synth", "ping"):',
      '        job_done_evs[jid] = threading.Event()',
      '    cmd_writer.write(json.dumps(obj) + "\\n")',
      '    cmd_writer.flush()',
      '',
      'driver_err = [None]',
      'def driver():',
      '    global burst_stale_cid',
      '    try:',
      '        _run_driver()',
      '    except BaseException as exc:',
      '        driver_err[0] = exc',
      '        import traceback',
      '        traceback.print_exc()',
      '        try:',
      '            cmd_writer.close()',
      '        except Exception:',
      '            pass',
      '',
      'def _run_driver():',
      '    global burst_stale_cid',
      '    ready_ev.wait(timeout=5.0)',
      '    # Wait for initial standby pool (4 connections) to populate',
      '    deadline = time.monotonic() + 3.0',
      '    while len(ws_records) < 4 and time.monotonic() < deadline:',
      '        time.sleep(0.02)',
      '    assert len(ws_records) >= 4, f"expected 4 standby ws, got {len(ws_records)}"',
      '',
      '    # 1. Non-speakable NoAudioReceived must NOT mark IP bad',
      '    send_cmd({"type": "synth", "id": 10, "text": "...", "voice": "en-US-AriaNeural", "rate": "+0%"})',
      '    assert job_done_evs[10].wait(timeout=5.0)',
      '    err_10 = [e for e in events if e.get("id") == 10 and e.get("type") == "error"]',
      '    assert len(err_10) == 1 and "No audio" in err_10[0].get("error", ""), f"unexpected err_10: {err_10}"',
      '    assert len(captured_connectors[0]._ip_penalty) == 0, f"IP penalized on non-speakable NoAudioReceived: {captured_connectors[0]._ip_penalty}"',
      '',
      '    # 2. Dual-completion in stream_part_hedged (t1 and t2 resolve together) -> zero WS leak',
      '    send_cmd({"type": "synth", "id": 11, "text": "DUAL_HEDGE test sentence.", "voice": "en-US-AriaNeural", "rate": "+0%"})',
      '    assert job_done_evs[11].wait(timeout=5.0)',
      '    ev_11 = [e for e in events if e.get("id") == 11]',
      '    assert any(e.get("type") == "end" for e in ev_11), f"job 11 failed: {ev_11}"',
      '    dual_cids = [cid for cid, texts in ssml_by_cid.items() if any("DUAL_HEDGE" in t for t in texts)]',
      '    assert len(dual_cids) == 2, f"expected 2 hedged WS, got {dual_cids}"',
      '    time.sleep(0.05)',
      '    for cid in dual_cids:',
      '        assert ws_records[cid]["closed"] or ws_records[cid]["ws"].closed, f"dual-hedge WS {cid} leaked!"',
      '',
      '    # 3. CancelledError mid-wait in stream_part_hedged -> zero WS leak',
      '    send_cmd({"type": "synth", "id": 12, "text": "CANCEL_HEDGE test sentence.", "voice": "en-US-AriaNeural", "rate": "+0%"})',
      '    time.sleep(0.85)',
      '    send_cmd({"type": "cancel", "id": 12})',
      '    time.sleep(0.15)',
      '    cancel_cids = [cid for cid, texts in ssml_by_cid.items() if any("CANCEL_HEDGE" in t for t in texts)]',
      '    assert len(cancel_cids) >= 2, f"expected >=2 cancel-hedge WS, got {cancel_cids}"',
      '    for cid in cancel_cids:',
      '        assert ws_records[cid]["closed"] or ws_records[cid]["ws"].closed, f"cancelled hedge WS {cid} leaked!"',
      '',
      '    # 4. Staggered burst + stale eviction in checkout_ws/prune_standby -> no stranded or double-used WS',
      '    deadline = time.monotonic() + 3.0',
      '    while sum(1 for r in ws_records.values() if not r["closed"] and not r["ws"].closed) < 4 and time.monotonic() < deadline:',
      '        time.sleep(0.02)',
      '    open_cids = [cid for cid, r in ws_records.items() if not r["closed"] and not r["ws"].closed]',
      '    burst_stale_cid = open_cids[0]',
      '    fut = asyncio.run_coroutine_threadsafe(server_ws_by_cid[burst_stale_cid].close(), server_loop_box[0])',
      '    fut.result(timeout=2.0)',
      '    time.sleep(0.05)',
      '    for b in range(5):',
      '        send_cmd({"type": "synth", "id": 20 + b, "text": f"BURST_{b} test.", "voice": "en-US-AriaNeural", "rate": "+0%"})',
      '        time.sleep(0.015)',
      '    for b in range(5):',
      '        assert job_done_evs[20 + b].wait(timeout=5.0)',
      '        assert any(e.get("id") == 20 + b and e.get("type") == "end" for e in events)',
      '    for cid, texts in ssml_by_cid.items():',
      '        assert len(texts) <= 1, f"WS {cid} double-checked-out for {texts}"',
      '',
      '    # Shutdown worker and verify every opened WS is closed cleanly',
      '    cmd_writer.close()',
      '',
      'threading.Thread(target=driver, daemon=True).start()',
      'with open(' + JSON.stringify(workerFile) + ', "r", encoding="utf-8") as f:',
      '    exec(f.read(), {"__name__": "__main__"})',
      'time.sleep(0.05)',
      'if driver_err[0] is not None:',
      '    raise driver_err[0]',
      'unclosed = [cid for cid, r in ws_records.items() if not r["closed"] and not r["ws"].closed]',
      'assert not unclosed, f"WS leaked after shutdown: {unclosed}"',
      'orig_stdout.write(json.dumps({"ok": True, "total_ws": len(ws_records)}) + "\\n")',
      'orig_stdout.flush()',
    ].join('\n'),
    'utf8'
  );

  try {
    const res = cp.spawnSync(realPy, [pyHarness], {
      cwd: tmpRoot,
      encoding: 'utf8',
      timeout: 25000,
      windowsHide: true,
    });
    assert.equal(res.status, 0, 'Python WS race harness failed (status=' + res.status + '): stderr=' + res.stderr + ' stdout=' + res.stdout);
    const parsed = JSON.parse(res.stdout.trim().split('\n').pop());
    assert.equal(parsed.ok, true);
    assert.ok(parsed.total_ws >= 10, 'expected >=10 mock WS opened, got ' + parsed.total_ws);
  } finally {
    rmrf(tmpRoot);
  }
});

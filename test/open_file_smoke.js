'use strict';

/**
 * 真实 Electron 窗口打开文本 / 代码 / Markdown 文件冒烟测试
 *
 * 用法：
 *   node test/open_file_smoke.js              # 源码版（electron .）
 *   node test/open_file_smoke.js --packaged   # 打包版（dist/FolioPrism-win32-x64/FolioPrism.exe）
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const http = require('node:http');
const assert = require('node:assert/strict');

const ROOT_DIR = path.resolve(__dirname, '..');
const APP_EXE = path.join(ROOT_DIR, 'dist', 'FolioPrism-win32-x64', 'FolioPrism.exe');
const PACKAGED = process.argv.includes('--packaged');
const CDP_PORT = 9800 + (process.pid % 200);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      const fns = this.listeners.get(msg.method);
      if (fns) for (const fn of fns) fn(msg.params);
    });
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
  send(method, params) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error('page eval failed: ' + JSON.stringify(r.exceptionDetails));
    }
    return r.result && r.result.value;
  }
  close() {
    try {
      this.ws.close();
    } catch (_) {}
  }
}

async function run() {
  let exePath;
  let spawnArgs;
  let spawnCwd;
  if (PACKAGED) {
    if (!fs.existsSync(APP_EXE)) {
      throw new Error('packaged exe not found: ' + APP_EXE);
    }
    exePath = APP_EXE;
    spawnArgs = [];
    spawnCwd = path.dirname(APP_EXE);
  } else {
    exePath = require('electron');
    spawnArgs = ['.'];
    spawnCwd = ROOT_DIR;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-open-smoke-'));
  const userDataDir = path.join(tmpDir, 'userdata');
  const fixturesDir = path.join(tmpDir, 'fixtures');
  fs.mkdirSync(fixturesDir, { recursive: true });

  const utf8Txt = path.join(fixturesDir, 'utf8.txt');
  const utf8BomTxt = path.join(fixturesDir, 'utf8_bom.txt');
  const gbkTxt = path.join(fixturesDir, 'gbk.txt');
  const u16leTxt = path.join(fixturesDir, 'utf16le.txt');
  const u16beTxt = path.join(fixturesDir, 'utf16be.txt');
  const samplePy = path.join(fixturesDir, 'sample.py');
  const sampleJson = path.join(fixturesDir, 'sample.json');
  const sampleIni = path.join(fixturesDir, 'sample.ini');
  const sampleMd = path.join(fixturesDir, 'sample.md');

  fs.writeFileSync(utf8Txt, 'UTF-8 提交说明：Hello FolioPrism\n第二行正文', 'utf8');
  fs.writeFileSync(
    utf8BomTxt,
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('UTF-8 BOM 测试内容', 'utf8')])
  );
  // 0xd6d0 0xcec4 0xb2e2 0xcad4 => "中文测试", 0xc4da 0xc8dd => "内容" (GBK)
  fs.writeFileSync(
    gbkTxt,
    Buffer.concat([
      Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4]),
      Buffer.from(' GBK ', 'ascii'),
      Buffer.from([0xc4, 0xda, 0xc8, 0xdd]),
    ])
  );
  fs.writeFileSync(
    u16leTxt,
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('UTF-16 LE 中文内容', 'utf16le')])
  );
  const u16beBuf = Buffer.from('UTF-16 BE 中文内容', 'utf16le');
  u16beBuf.swap16();
  fs.writeFileSync(u16beTxt, Buffer.concat([Buffer.from([0xfe, 0xff]), u16beBuf]));
  fs.writeFileSync(samplePy, 'def hello_prism(name):\n    return f"hi {name}"\n', 'utf8');
  fs.writeFileSync(sampleJson, '{\n  "name": "FolioPrism",\n  "ok": true\n}\n', 'utf8');
  fs.writeFileSync(sampleIni, '[reader]\nport = 7788\nmode = local\n', 'utf8');
  fs.writeFileSync(
    sampleMd,
    [
      '# Open Smoke Markdown',
      '',
      'Before fenced code block.',
      '',
      '```js',
      'const prism = "ok";',
      '```',
      '',
      'After fenced code block.',
      '',
    ].join('\n'),
    'utf8'
  );

  let appProc = null;
  let cdp = null;
  const consoleErrors = [];
  const pageExceptions = [];

  try {
    appProc = cp.spawn(
      exePath,
      [...spawnArgs, '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + userDataDir],
      { cwd: spawnCwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );

    let targets = null;
    for (let i = 0; i < 120; i++) {
      try {
        targets = await httpGetJson('http://127.0.0.1:' + CDP_PORT + '/json/list');
        if (Array.isArray(targets) && targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)) break;
      } catch (_) {}
      await sleep(250);
    }
    const pageTarget = targets && targets.find((t) => t.type === 'page');
    assert.ok(pageTarget && pageTarget.webSocketDebuggerUrl, 'Electron page target not found');

    cdp = new CdpClient(pageTarget.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Runtime.enable');

    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error') consoleErrors.push(JSON.stringify(p.args));
    });
    cdp.on('Runtime.exceptionThrown', (p) => {
      pageExceptions.push(JSON.stringify(p.exceptionDetails));
    });

    let ready = false;
    for (let i = 0; i < 100; i++) {
      ready = await cdp.eval('Boolean(window.__reader && window.__reader.ready)');
      if (ready) break;
      await sleep(100);
    }
    assert.equal(ready, true, 'window.__reader must become ready');

    const textCases = [
      { path: utf8Txt, expect: 'UTF-8 提交说明：Hello FolioPrism', expectEnc: 'utf-8', label: 'UTF-8 .txt' },
      { path: utf8BomTxt, expect: 'UTF-8 BOM 测试内容', expectEnc: 'utf-8-bom', label: 'UTF-8 BOM .txt' },
      { path: gbkTxt, expect: '中文测试 GBK 内容', expectEnc: 'gbk', label: 'GBK .txt' },
      { path: u16leTxt, expect: 'UTF-16 LE 中文内容', expectEnc: 'utf-16le', label: 'UTF-16 LE .txt' },
      { path: u16beTxt, expect: 'UTF-16 BE 中文内容', expectEnc: 'utf-16be', label: 'UTF-16 BE .txt' },
      { path: samplePy, expect: 'def hello_prism(name):', expectEnc: 'utf-8', label: 'Python .py' },
      { path: sampleJson, expect: '"name": "FolioPrism"', expectEnc: 'utf-8', label: 'JSON .json' },
      { path: sampleIni, expect: 'port = 7788', expectEnc: 'utf-8', label: 'INI .ini' },
    ];

    for (const tc of textCases) {
      const res = await cdp.eval(`
        (async () => {
          const ok = await window.__reader.openFile(${JSON.stringify(tc.path)});
          const c = document.querySelector('#content');
          return {
            ok,
            ready: Boolean(window.__reader.ready),
            errCards: c.querySelectorAll('.err-card').length,
            fileCodeBlocks: c.querySelectorAll('.code-block.file-code').length,
            copyButtons: c.querySelectorAll('button.code-copy').length,
            text: c.textContent || '',
            meta: (c.querySelector('.doc-meta') || {}).textContent || '',
          };
        })()
      `);
      assert.equal(res.ok, true, tc.label + ': openFile must return true');
      assert.equal(res.ready, true, tc.label + ': window.__reader.ready must be true');
      assert.equal(res.errCards, 0, tc.label + ': must not render .err-card');
      assert.equal(res.fileCodeBlocks, 1, tc.label + ': must render 1 .code-block.file-code');
      assert.equal(res.copyButtons, 1, tc.label + ': must render 1 copy button');
      assert.ok(res.text.includes(tc.expect), tc.label + ': missing expected text');
      assert.ok(!res.text.includes('\uFEFF'), tc.label + ': BOM char should be stripped');
      assert.ok(res.meta.includes(tc.expectEnc), tc.label + ': doc-meta should show encoding ' + tc.expectEnc);
      console.log('PASS [' + (PACKAGED ? 'packaged' : 'source') + '] ' + tc.label);
    }

    // Markdown 围栏代码块回归检查（wrapPre/enhanceCode 拆分后保持原位替换）
    const mdRes = await cdp.eval(`
      (async () => {
        const ok = await window.__reader.openFile(${JSON.stringify(sampleMd)});
        const c = document.querySelector('#content');
        const tags = Array.from(c.children).map((el) => el.tagName + (el.className ? '.' + el.className.split(' ').join('.') : ''));
        return {
          ok,
          ready: Boolean(window.__reader.ready),
          errCards: c.querySelectorAll('.err-card').length,
          headings: c.querySelectorAll('h1').length,
          paras: c.querySelectorAll('p').length,
          codeBlocks: c.querySelectorAll('.code-block').length,
          copyButtons: c.querySelectorAll('button.code-copy').length,
          tags,
          text: c.textContent || '',
        };
      })()
    `);
    assert.equal(mdRes.ok, true, 'Markdown openFile must return true');
    assert.equal(mdRes.ready, true, 'Markdown ready must be true');
    assert.equal(mdRes.errCards, 0, 'Markdown must not render .err-card');
    assert.equal(mdRes.headings, 1, 'Markdown must render h1');
    assert.equal(mdRes.paras, 2, 'Markdown must render 2 paragraphs');
    assert.equal(mdRes.codeBlocks, 1, 'Markdown must render 1 .code-block');
    assert.equal(mdRes.copyButtons, 1, 'Markdown must render 1 copy button');
    assert.ok(mdRes.text.includes('const prism = "ok";'));
    const codeIdx = mdRes.tags.findIndex((t) => t.includes('code-block'));
    assert.ok(codeIdx > 1 && mdRes.tags[codeIdx - 1] === 'P' && mdRes.tags[codeIdx + 1] === 'P',
      'Markdown fenced block must remain between paragraphs, got ' + JSON.stringify(mdRes.tags));
    console.log('PASS [' + (PACKAGED ? 'packaged' : 'source') + '] Markdown fenced code block');

    assert.equal(pageExceptions.length, 0, 'no uncaught page exceptions: ' + pageExceptions.join('; '));
    assert.equal(consoleErrors.length, 0, 'no console errors: ' + consoleErrors.join('; '));
  } finally {
    if (cdp) cdp.close();
    if (appProc && !appProc.killed) {
      try {
        appProc.kill();
      } catch (_) {}
      await sleep(400);
      if (appProc.exitCode === null) {
        try {
          cp.spawnSync('taskkill', ['/pid', String(appProc.pid), '/T', '/F'], { windowsHide: true });
        } catch (_) {}
      }
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

run().catch((e) => {
  console.error('\nOPEN FILE SMOKE FAILED:', (e && e.stack) || e);
  process.exit(1);
});

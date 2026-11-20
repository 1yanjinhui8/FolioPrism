'use strict';

/**
 * 打包产物冒烟测试（Packaged App Smoke Test）
 *
 * 单测和 e2e 都是跑「源码 + node server.js」，验证不了 dist 里的 app.asar。
 * 这个脚本直接启动 dist\FolioPrism-win32-x64\FolioPrism.exe，通过 CDP 驱动真实窗口，
 * 检查打包后这些新功能是否仍然可用：
 *
 *   1. 应用能起来，窗口加载完成、window.__reader 就绪
 *   2. 服务端工具探测正常（edge-tts 可用，路径指向 uv 工具目录）
 *   3. 未缓存段落朗读走 Edge 神经语音（how === 'audio'），首句 < 3000ms
 *   4. /api/tts 响应是 200 流式且带 X-TTS-Voice
 *   5. 长段落（>1200 字）自动分块，不再 400
 *   6. 缓存命中复播 < 500ms
 *   7. 无 console error / 未捕获异常
 *
 * 用法：先 `npm run dist`，再 `node test/packaged_smoke.js`
 * 没有 dist 产物时自动跳过（exit 0），便于在 CI 里无条件调用。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const http = require('node:http');
const assert = require('node:assert/strict');

const ROOT_DIR = path.resolve(__dirname, '..');
const APP_EXE = path.join(ROOT_DIR, 'dist', 'FolioPrism-win32-x64', 'FolioPrism.exe');
const CDP_PORT = 9600 + (process.pid % 200);

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
  if (!fs.existsSync(APP_EXE)) {
    console.log('[skip] dist 产物不存在，先运行 npm run dist：' + APP_EXE);
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-packaged-'));
  const userDataDir = path.join(tmpDir, 'userdata');
  const runId = Date.now().toString(36);
  const sampleMd = path.join(tmpDir, 'packaged_sample_' + runId + '.md');

  const pShort = `Packaged ${runId}. The bundled build must still stream neural speech quickly.`;
  const pLong =
    `Packaged long ${runId}. ` +
    Array.from(
      { length: 16 },
      (_, i) =>
        `Clause ${i + 1} confirms long paragraphs beyond twelve hundred characters still stream without a 400 error.`
    ).join(' ');
  assert.ok(pLong.length > 1200, 'long sample must exceed 1200 chars: ' + pLong.length);

  fs.writeFileSync(sampleMd, ['# Packaged Smoke ' + runId, '', pShort, '', pLong, ''].join('\n'), 'utf8');

  let appProc = null;
  let cdp = null;
  const consoleErrors = [];
  const pageExceptions = [];
  const ttsResponses = [];
  const metrics = [];

  try {
    appProc = cp.spawn(
      APP_EXE,
      ['--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + userDataDir],
      { cwd: path.dirname(APP_EXE), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
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
    assert.ok(pageTarget && pageTarget.webSocketDebuggerUrl, 'packaged app page target not found (app failed to start?)');

    cdp = new CdpClient(pageTarget.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');

    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error') consoleErrors.push(JSON.stringify(p.args));
    });
    cdp.on('Runtime.exceptionThrown', (p) => {
      pageExceptions.push(JSON.stringify(p.exceptionDetails));
    });
    cdp.on('Network.responseReceived', (p) => {
      if (p.response && p.response.url.includes('/api/tts')) {
        ttsResponses.push({
          status: p.response.status,
          mimeType: p.response.mimeType,
          voice: p.response.headers['x-tts-voice'] || p.response.headers['X-TTS-Voice'] || '',
          serverTiming: p.response.headers['server-timing'] || p.response.headers['Server-Timing'] || '',
        });
      }
    });

    // 1. 前端就绪
    let ready = false;
    for (let i = 0; i < 100; i++) {
      ready = await cdp.eval('Boolean(window.__reader && window.__reader.ready)');
      if (ready) break;
      await sleep(100);
    }
    assert.equal(ready, true, 'window.__reader must become ready inside the packaged app');

    // 2. 引擎状态（打包版里 translator.js 来自 app.asar，工具探测逻辑必须照常工作）
    const statusJson = await cdp.eval(`fetch('/api/translate/status').then(r => r.json())`);
    assert.equal(statusJson.engine.tts.available, true, 'edge-tts must be available in packaged app');
    assert.ok(
      String(statusJson.engine.tts.path).toLowerCase().includes('edge-tts'),
      'packaged app must still resolve the edge-tts engine: ' + statusJson.engine.tts.path
    );

    // 3. 打开样本并确认渲染
    await cdp.eval(`window.__reader.openFile(${JSON.stringify(sampleMd)})`);
    for (let i = 0; i < 60; i++) {
      const ok = await cdp.eval('Boolean(window.__reader.ready)');
      if (ok) break;
      await sleep(100);
    }
    const stats = await cdp.eval('window.__reader.refreshStats()');
    const paras = await cdp.eval(`document.querySelectorAll('#content p').length`);
    assert.ok(paras >= 2, 'sample markdown should render at least 2 paragraphs, got ' + paras);
    assert.ok(stats && stats.tocItems >= 1, 'sample should produce a TOC entry: ' + JSON.stringify(stats));

    const waitPlayed = async (timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const ok = await cdp.eval(
          'Boolean(window.__reader.tts.lastMetric && window.__reader.tts.lastMetric.playingAt > 0)'
        );
        if (ok) return true;
        await sleep(50);
      }
      return false;
    };

    const clickParagraph = async (idx, label, maxMs) => {
      // 先清空 lastMetric，避免读到上一段的指标
      await cdp.eval('window.__reader.tts.stop()');
      await sleep(120);
      const started = Date.now();
      await cdp.eval(`
        (() => {
          const btns = document.querySelectorAll('#content p .tts-block-btn');
          if (!btns[${idx}]) throw new Error('paragraph tts button #${idx} missing');
          btns[${idx}].click();
        })()
      `);
      const played = await waitPlayed(10000);
      const wallMs = Date.now() - started;
      const metric = await cdp.eval('window.__reader.tts.lastMetric');
      assert.ok(played, label + ': audio never started playing');
      assert.ok(metric, label + ': lastMetric missing');
      assert.equal(metric.how, 'audio', label + ': must use Edge TTS audio, got ' + metric.how);
      assert.ok(
        metric.latencyMs < maxMs,
        `${label}: latency ${metric.latencyMs}ms must be < ${maxMs}ms`
      );
      metrics.push({ label, len: metric.textLength, chunks: metric.chunks, ms: metric.latencyMs, wallMs });
      await cdp.eval('window.__reader.tts.stop()');
      await sleep(100);
      return metric;
    };

    // 4. 未缓存短段落
    await clickParagraph(0, 'Packaged Uncached Short EN', 3000);
    // 5. 长段落（>1200 字，分块）
    const longMetric = await clickParagraph(1, 'Packaged Long EN (>1200 chars)', 5000);
    assert.ok(longMetric.chunks >= 2, 'long paragraph must be split into multiple chunks, got ' + longMetric.chunks);
    // 6. 缓存命中复播
    await clickParagraph(0, 'Packaged Cached Replay Short EN', 500);

    // 7. 没有任何 /api/tts 请求失败
    const bad = ttsResponses.filter((r) => r.status >= 400);
    assert.equal(bad.length, 0, 'no /api/tts request should fail: ' + JSON.stringify(bad));
    assert.ok(ttsResponses.some((r) => r.voice), 'streamed responses must carry X-TTS-Voice');

    assert.equal(pageExceptions.length, 0, 'no uncaught page exceptions: ' + pageExceptions.join('; '));
    assert.equal(consoleErrors.length, 0, 'no console errors: ' + consoleErrors.join('; '));

    console.log('\n==================== PACKAGED APP SMOKE REPORT ====================');
    console.log('App:', APP_EXE);
    console.log('TTS Engine:', statusJson.engine.tts.path);
    for (const m of metrics) {
      console.log(
        `${m.label.padEnd(36)} | len=${String(m.len).padStart(4)} | chunks=${m.chunks} | latency=${m.ms} ms (wall=${m.wallMs} ms)`
      );
    }
    console.log('All packaged smoke assertions PASSED.');
    console.log('====================================================================\n');
  } finally {
    if (cdp) cdp.close();
    if (appProc && !appProc.killed) {
      try {
        appProc.kill();
      } catch (_) {}
      await sleep(400);
      if (appProc.exitCode === null) {
        try {
          cp.spawn('taskkill', ['/pid', String(appProc.pid), '/T', '/F'], { windowsHide: true });
        } catch (_) {}
      }
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

run().catch((e) => {
  console.error('\nPACKAGED SMOKE FAILED:', (e && e.stack) || e);
  process.exit(1);
});

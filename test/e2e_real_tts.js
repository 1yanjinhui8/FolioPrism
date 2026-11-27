'use strict';

/**
 * 真实运行环境端到端实测脚本（Real-Environment E2E Verification）
 *
 * 验证目标：
 *   1. 启动真实 FolioPrism HTTP 服务（连接真实 Microsoft Edge ReadAloud 服务 speech.platform.bing.com）
 *   2. 启动真实 Chromium (Chrome / Edge) 通过 CDP 连接，打开真实文档并模拟真实点击
 *   3. 实测未缓存段落（短英文、长英文、>1400字超长英文、中文）从点击朗读按钮到 <audio> playing 的真实耗时 (< 3000 ms)
 *   4. 验证保留 edge-tts 引擎（how === 'audio'、X-TTS-Voice）、缓存命中、快速切段、全文朗读暂停/恢复/下一句/停止、核心阅读功能回归
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const http = require('node:http');
const assert = require('node:assert/strict');

const ROOT_DIR = path.resolve(__dirname, '..');
const PORT = 7899;
const TOKEN = 'e2e-real-token-' + process.pid;
const BASE_URL = 'http://127.0.0.1:' + PORT;

function findBrowser() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return '';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const j = await httpGetJson(BASE_URL + '/api/health');
      if (j && j.ok) return j;
    } catch (_) {}
    await sleep(200);
  }
  throw new Error('Server health timeout');
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
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method && this.listeners.has(msg.method)) {
        for (const fn of this.listeners.get(msg.method)) {
          try { fn(msg.params); } catch (_) {}
        }
      }
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
  async eval(expression, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error('Eval exception: ' + JSON.stringify(r.exceptionDetails));
    }
    return r.result ? r.result.value : undefined;
  }
  close() {
    try { this.ws.close(); } catch (_) {}
  }
}

async function run() {
  const browserExe = findBrowser();
  assert.ok(browserExe, 'Chrome or Edge must be installed for real browser E2E');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-e2e-'));
  const userDataDir = path.join(tmpDir, 'profile');
  fs.mkdirSync(userDataDir, { recursive: true });

  // 每次运行使用唯一 nonce，确保段落完全未命中 TTS 磁盘缓存，真实走 Microsoft Edge ReadAloud
  const runId = Date.now().toString(36);
  const sampleMd = path.join(tmpDir, 'e2e_sample_' + runId + '.md');
  const pShort = `Run ${runId}. Edge neural speech streaming begins playing immediately without waiting for the entire clip.`;
  const pMed =
    `Run ${runId} medium test. ` +
    'FolioPrism keeps the local edge-tts neural engine while removing cold-start Python overhead. ' +
    'By holding a persistent worker with a shared connector, TLS and DNS setup are reused across sentences. ' +
    'Meanwhile, progressive HTTP audio streaming sends the first MP3 frames to Chromium as soon as they arrive. ' +
    'This pipeline compresses paragraph startup well under three seconds in real desktop usage.';
  const pLong =
    `Run ${runId} extended test. ` +
    Array.from({ length: 16 }, (_, i) =>
      `Clause ${i + 1} verifies that paragraphs exceeding twelve hundred characters no longer fail with HTTP 400 and still begin playing quickly.`
    ).join(' ');
  const pZh =
    `测试编号 ${runId}。棱阅保留原有的微软神经语音引擎与对外接口，通过常驻工作进程、渐进式音频流传输与首句分块优化，将触发段落朗读到真正出声的等待时间压缩到三秒以内，同时确保长段落不会因为字符数限制而报错回退。`;

  assert.ok(pLong.length > 1400, 'Long paragraph must exceed 1200 chars: ' + pLong.length);

  fs.writeFileSync(
    sampleMd,
    [
      '# E2E TTS Benchmark ' + runId,
      '',
      pShort,
      '',
      pMed,
      '',
      pLong,
      '',
      pZh,
      '',
    ].join('\n'),
    'utf8'
  );

  // 用独立的服务器包装脚本方便获取优雅 shutdown
  const srvScript = path.join(tmpDir, 'srv.js');
  fs.writeFileSync(
    srvScript,
    [
      `'use strict';`,
      `process.argv.push('--port=${PORT}', '--token=${TOKEN}', '--no-open', '--root=${ROOT_DIR.replace(/\\/g, '\\\\')}');`,
      `const server = require(${JSON.stringify(path.join(ROOT_DIR, 'src', 'server', 'index.js'))});`,
      `const translator = require(${JSON.stringify(path.join(ROOT_DIR, 'src', 'translator', 'index.js'))});`,
      `server.start({ port: ${PORT}, root: ${JSON.stringify(ROOT_DIR)}, openBrowser: false }).then(async () => {`,
      `  await translator.warmTtsWorker();`,
      `  console.log('E2E_SERVER_READY');`,
      `});`,
      `process.stdin.setEncoding('utf8');`,
      `process.stdin.on('data', (d) => { if (d.includes('shutdown')) { server.shutdown(); setTimeout(() => process.exit(0), 200); } });`,
    ].join('\n'),
    'utf8'
  );

  const srv = cp.spawn(process.execPath, [srvScript], {
    cwd: ROOT_DIR,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let srvOut = '';
  let srvErr = '';
  srv.stderr.on('data', (d) => { srvErr += d.toString(); });

  let browserProc = null;
  let cdp = null;
  const metrics = [];

  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Server warmup timeout: ' + srvErr)), 20000);
      srv.stdout.on('data', (d) => {
        srvOut += d.toString();
        if (srvOut.includes('E2E_SERVER_READY')) {
          clearTimeout(t);
          resolve();
        }
      });
      srv.on('exit', (c) => {
        clearTimeout(t);
        reject(new Error('Server exited early: ' + c + ' err=' + srvErr));
      });
    });
    await waitForHealth(10000);

    // 启动真实 Chromium
    const cdpPort = 9333 + (process.pid % 200);
    browserProc = cp.spawn(
      browserExe,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--autoplay-policy=no-user-gesture-required',
        '--remote-debugging-port=' + cdpPort,
        '--user-data-dir=' + userDataDir,
        BASE_URL + '/?token=' + TOKEN,
      ],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }
    );

    let targets = null;
    for (let i = 0; i < 40; i++) {
      try {
        targets = await httpGetJson('http://127.0.0.1:' + cdpPort + '/json/list');
        if (Array.isArray(targets) && targets.find((t) => t.type === 'page')) break;
      } catch (_) {}
      await sleep(150);
    }
    const pageTarget = targets && targets.find((t) => t.type === 'page');
    assert.ok(pageTarget && pageTarget.webSocketDebuggerUrl, 'Browser page target not found');

    cdp = new CdpClient(pageTarget.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('DOM.enable');

    const consoleErrors = [];
    const pageExceptions = [];
    const statusRequests = [];
    const ttsResponses = [];

    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error') consoleErrors.push(JSON.stringify(p.args));
    });
    cdp.on('Runtime.exceptionThrown', (p) => {
      pageExceptions.push(JSON.stringify(p.exceptionDetails));
    });
    cdp.on('Network.requestWillBeSent', (p) => {
      if (p.request && p.request.url.includes('/api/translate/status')) {
        statusRequests.push(p.request.url);
      }
    });
    cdp.on('Network.responseReceived', (p) => {
      if (p.response && p.response.url.includes('/api/tts')) {
        ttsResponses.push({
          url: p.response.url,
          status: p.response.status,
          mimeType: p.response.mimeType,
          voice: p.response.headers['x-tts-voice'] || p.response.headers['X-TTS-Voice'] || '',
          serverTiming: p.response.headers['server-timing'] || p.response.headers['Server-Timing'] || '',
        });
      }
    });

    // 等待前端 boot() 完成
    for (let i = 0; i < 50; i++) {
      const ready = await cdp.eval('Boolean(window.__reader && window.__reader.ready)');
      if (ready) break;
      await sleep(100);
    }
    assert.equal(await cdp.eval('Boolean(window.__reader && window.__reader.ready)'), true, 'Reader must become ready');

    // 检查默认打开 README.md 图片渲染与目录回归
    await cdp.eval(`window.__reader.openFile(${JSON.stringify(path.join(ROOT_DIR, 'README.md'))})`);
    await sleep(500);
    const readmeStats = await cdp.eval('window.__reader.refreshStats()');
    assert.equal(readmeStats.imgs, 6, 'README.md should render 6 images');
    assert.equal(readmeStats.broken, 0, 'README.md should have 0 broken images');
    assert.ok(readmeStats.tocItems > 0 && readmeStats.codeBlocks > 0);

    // 验证 /api/translate/status 引擎状态与单次去重
    const statusJson = await cdp.eval(`fetch('/api/translate/status').then(r => r.json())`);
    assert.equal(statusJson.engine.tts.available, true, 'edge-tts must be available');
    assert.ok(statusJson.engine.tts.path.toLowerCase().includes('edge-tts'), 'engine must remain edge-tts');
    // 启动阶段的 statusRequests（扣除刚才显式 fetch 的那次）应 <= 1
    assert.ok(statusRequests.length <= 2, 'boot should deduplicate /api/translate/status');

    // 打开本次 E2E 未缓存测试文档
    await cdp.eval(`window.__reader.openFile(${JSON.stringify(sampleMd)})`);
    await sleep(300);

    // 给页面注入独立音频播放时间戳探针，交叉验证 window.__reader.tts.lastMetric
    await cdp.eval(`
      (() => {
        window.__e2eAudioEvents = [];
        const origPlay = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function () {
          if (!this.__e2eHooked) {
            this.__e2eHooked = true;
            this.addEventListener('playing', () => {
              window.__e2eAudioEvents.push({
                kind: 'html-audio',
                t: performance.now(),
                src: this.currentSrc || this.src,
                paused: this.paused,
                readyState: this.readyState
              });
            });
          }
          return origPlay.apply(this, arguments);
        };
        if (typeof AudioBufferSourceNode !== 'undefined') {
          const origStart = AudioBufferSourceNode.prototype.start;
          AudioBufferSourceNode.prototype.start = function () {
            const ret = origStart.apply(this, arguments);
            if (this.buffer && this.buffer.length > 0 && this.buffer.duration > 0) {
              window.__e2eAudioEvents.push({
                kind: 'webaudio',
                t: performance.now(),
                duration: this.buffer.duration,
                sampleRate: this.buffer.sampleRate,
                ctxState: this.context ? this.context.state : ''
              });
            }
            return ret;
          };
        }
      })()
    `, false);

    async function clickParagraphTts(idx, label, opts) {
      const o = opts || {};
      const prevCount = await cdp.eval('window.__e2eAudioEvents.length', false);
      const tClickStart = await cdp.eval(`
        (() => {
          const btns = Array.from(document.querySelectorAll('#content p .tts-block-btn'));
          const btn = btns[${idx}];
          if (!btn) throw new Error('Missing tts button at index ' + ${idx});
          btn.scrollIntoView({ block: 'center', behavior: 'instant' });
          window.__e2eClickAt = performance.now();
          btn.click();
          return window.__e2eClickAt;
        })()
      `, false);

      // 等待真实 <audio> 触发 playing 事件
      let metric = null;
      let audioEv = null;
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const state = await cdp.eval(`
          ({
            evLen: window.__e2eAudioEvents.length,
            lastEv: window.__e2eAudioEvents[window.__e2eAudioEvents.length - 1] || null,
            metric: window.__reader.tts.lastMetric
          })
        `, false);
        if (state.evLen > prevCount && state.metric && state.metric.playingAt > 0) {
          audioEv = state.lastEv;
          metric = state.metric;
          break;
        }
        await sleep(30);
      }

      if (!audioEv || !metric) {
        const diag = await cdp.eval(`({
          evLen: window.__e2eAudioEvents.length,
          metric: window.__reader.tts.lastMetric,
          audioState: window.__reader.tts.state.audio ? {
            src: window.__reader.tts.state.audio.currentSrc || window.__reader.tts.state.audio.src,
            readyState: window.__reader.tts.state.audio.readyState,
            networkState: window.__reader.tts.state.audio.networkState,
            paused: window.__reader.tts.state.audio.paused,
            error: window.__reader.tts.state.audio.error ? window.__reader.tts.state.audio.error.code : null
          } : null
        })`, false);
        console.error('DIAG:', JSON.stringify({ diag, ttsResponses, consoleErrors, pageExceptions, srvOut: srvOut.slice(-1000), srvErr: srvErr.slice(-1000) }, null, 2));
      }
      assert.ok(audioEv && metric, label + ': audio playing event did not fire within 8s');
      const wallMs = Math.round((audioEv.t - tClickStart) * 100) / 100;
      assert.equal(metric.how, 'audio', label + ': must use Edge TTS audio, not fallback speech');
      const maxMs = o.maxMs || 3000;
      assert.ok(metric.latencyMs < maxMs, `${label}: lastMetric.latencyMs=${metric.latencyMs}ms must be < ${maxMs}ms`);
      assert.ok(wallMs < maxMs, `${label}: wallMs=${wallMs}ms must be < ${maxMs}ms`);
      metrics.push({
        label,
        textLength: metric.textLength,
        chunks: metric.chunks,
        firstChunkLength: metric.firstChunkLength,
        voice: metric.voice,
        metricMs: metric.latencyMs,
        wallMs,
        how: metric.how,
      });

      if (o.waitFinish) {
        const finDeadline = Date.now() + 15000;
        while (Date.now() < finDeadline) {
          const playing = await cdp.eval('Boolean(window.__reader.tts.state.playing)', false);
          if (!playing) break;
          await sleep(100);
        }
        await sleep(200);
      } else {
        await cdp.eval('window.__reader.tts.stop()', false);
        await sleep(80);
      }
    }

    // 1. 短英文段落（未缓存，播完以落盘缓存供第 5 步测试真实缓存命中）
    await clickParagraphTts(0, 'Uncached Short EN (~120 chars)', { waitFinish: true });
    // 2. 中长英文段落（未缓存）
    await clickParagraphTts(1, 'Uncached Medium EN (~470 chars)');
    // 3. 超长英文段落 >1400 字（未缓存，旧版会 HTTP 400）
    await clickParagraphTts(2, 'Uncached Long EN (>1400 chars)');
    // 4. 中文段落（未缓存）
    await clickParagraphTts(3, 'Uncached Chinese (~130 chars)');
    // 5. 缓存命中复播（短英文，应走 cache-hit 200/206 < 500ms）
    await clickParagraphTts(0, 'Cached Replay Short EN', { maxMs: 500 });

    // 验证没有任何 /api/tts 请求返回 >= 400
    const badTts = ttsResponses.filter((r) => r.status >= 400);
    assert.equal(badTts.length, 0, 'No /api/tts request should return >=400: ' + JSON.stringify(badTts));
    assert.ok(ttsResponses.some((r) => r.voice === 'en-US-AriaNeural'), 'Should use AriaNeural for EN');
    assert.ok(ttsResponses.some((r) => r.voice === 'zh-CN-XiaoxiaoNeural'), 'Should use XiaoxiaoNeural for ZH');

    // 6. 快速切换 A -> B -> Stop
    const prevEvs = await cdp.eval('window.__e2eAudioEvents.length', false);
    await cdp.eval(`
      (() => {
        const btns = document.querySelectorAll('#content p .tts-block-btn');
        btns[1].click();
        setTimeout(() => btns[0].click(), 120);
      })()
    `, false);
    await sleep(900);
    const switchState = await cdp.eval(`({
      evLen: window.__e2eAudioEvents.length,
      lastEv: window.__e2eAudioEvents[window.__e2eAudioEvents.length - 1] || null,
      metric: window.__reader.tts.lastMetric
    })`, false);
    assert.ok(switchState.evLen > prevEvs, 'Rapid A->B switch should fire audio playback events');
    assert.ok(
      switchState.metric &&
        switchState.metric.textLength === pShort.length &&
        switchState.metric.how === 'audio' &&
        switchState.metric.playingAt > 0,
      'Rapid A->B switch must confirm B (pShort) started playing, got: ' + JSON.stringify(switchState.metric)
    );
    assert.ok(
      switchState.lastEv && switchState.lastEv.t >= switchState.metric.triggerAt,
      'Audio event timestamp must occur after B was triggered'
    );
    await cdp.eval('window.__reader.tts.stop()', false);
    assert.equal(await cdp.eval('window.__reader.tts.state.playing', false), false);
    assert.equal(await cdp.eval('window.__reader.tts.lastMetric', false), null);
    assert.equal(await cdp.eval('document.querySelectorAll(".tts-current").length', false), 0);

    // 7. 全文朗读 (#btn-read) + 暂停/恢复 + 下一句 + 停止
    const beforeArt = await cdp.eval('window.__e2eAudioEvents.length', false);
    await cdp.eval(`document.getElementById('btn-read').click()`, false);
    for (let i = 0; i < 100; i++) {
      const ok = await cdp.eval(
        `window.__e2eAudioEvents.length > ${beforeArt} && window.__reader.tts.lastMetric && window.__reader.tts.lastMetric.playingAt > 0`,
        false
      );
      if (ok) break;
      await sleep(50);
    }
    const artMetric = await cdp.eval('window.__reader.tts.lastMetric', false);
    assert.ok(artMetric && artMetric.how === 'audio' && artMetric.latencyMs < 3000, 'Article TTS start <3s, got: ' + JSON.stringify(artMetric));
    assert.equal(await cdp.eval('document.getElementById("tts-bar").hidden', false), false);

    // 暂停 -> 恢复 -> 下一句 -> 停止
    await cdp.eval(`document.getElementById('tts-play').click()`, false);
    assert.equal(await cdp.eval('window.__reader.tts.state.paused', false), true);
    await sleep(100);
    await cdp.eval(`document.getElementById('tts-play').click()`, false);
    assert.equal(await cdp.eval('window.__reader.tts.state.paused', false), false);
    await cdp.eval(`document.getElementById('tts-next').click()`, false);
    await sleep(300);
    assert.equal(await cdp.eval('window.__reader.tts.state.index', false), 1);
    await cdp.eval(`document.getElementById('tts-stop').click()`, false);
    assert.equal(await cdp.eval('document.getElementById("tts-bar").hidden', false), true);
    assert.equal(await cdp.eval('window.__reader.tts.state.mode', false), 'idle');

    // 8. 双语结构回归（点击切换不会抛出前端异常；切回 off 后段落朗读按钮仍可用）
    await cdp.eval(`window.__reader.bilingual.setMode('dual')`, false);
    await sleep(300);
    assert.equal(await cdp.eval(`window.__reader.bilingual.mode()`, false), 'dual');
    const biBtns = await cdp.eval(`document.querySelectorAll('#content .bi-en .tts-block-btn').length`, false);
    assert.ok(biBtns > 0, 'Bilingual mode should attach .tts-block-btn per sentence');
    await cdp.eval(`window.__reader.bilingual.setMode('off')`, false);
    await sleep(200);
    assert.equal(await cdp.eval(`window.__reader.bilingual.mode()`, false), 'off');
    const restoredBtns = await cdp.eval(`document.querySelectorAll('#content p .tts-block-btn').length`, false);
    assert.ok(restoredBtns >= 4, 'Exiting bilingual mode should restore paragraph .tts-block-btn');

    assert.equal(consoleErrors.length, 0, 'Zero console errors expected: ' + consoleErrors.join('; '));
    assert.equal(pageExceptions.length, 0, 'Zero uncaught page exceptions expected: ' + pageExceptions.join('; '));

    console.log('\n==================== E2E REAL-ENV LATENCY REPORT ====================');
    console.log('Browser:', browserExe);
    console.log('TTS Engine:', statusJson.engine.tts.path);
    for (const m of metrics) {
      console.log(
        `${m.label.padEnd(36)} | len=${String(m.textLength).padStart(4)} | chunks=${m.chunks} (c0=${String(m.firstChunkLength).padStart(3)}) | voice=${m.voice} | how=${m.how} | latency=${m.metricMs} ms (wall=${m.wallMs} ms)`
      );
    }
    console.log(`Article #btn-read start              | how=${artMetric.how} | latency=${artMetric.latencyMs} ms`);
    console.log('All E2E assertions PASSED.');
    console.log('=====================================================================\n');
  } finally {
    if (cdp) cdp.close();
    if (browserProc && browserProc.exitCode === null) {
      try { cp.spawnSync('taskkill', ['/pid', String(browserProc.pid), '/T', '/F'], { windowsHide: true }); } catch (_) {}
    }
    try { srv.stdin.write('shutdown\n'); srv.stdin.end(); } catch (_) {}
    await sleep(400);
    if (srv.exitCode === null) {
      try { cp.spawnSync('taskkill', ['/pid', String(srv.pid), '/T', '/F'], { windowsHide: true }); } catch (_) {}
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

run().catch((e) => {
  console.error('E2E FAILED:', (e && e.stack) || e);
  process.exit(1);
});

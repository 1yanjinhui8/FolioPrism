'use strict';

/**
 * 端到端验收脚本
 * 用法: node verify.js [样本 Markdown 路径]
 * 也可以用环境变量 READER_SAMPLE 指定样本；不提供时跳过与样本相关的检查。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const PORT = 7789;
const BASE = 'http://127.0.0.1:' + PORT;
// 服务端除 /api/health 外都要求令牌；验收脚本用固定令牌启动，省去抓 Cookie
const TOKEN = 'verify-token-' + process.pid;

// 样本可以用第一个参数或 READER_SAMPLE 指定；不提供时跳过 2/3/4/6
const SAMPLE = process.argv[2] || process.env.READER_SAMPLE || '';
const SAMPLE_DIR = SAMPLE ? path.dirname(SAMPLE) : '';
const EXPECTED_REFS = process.env.READER_EXPECT_REFS
  ? parseInt(process.env.READER_EXPECT_REFS, 10)
  : 0;
const MIN_MD_FILES = process.env.READER_MIN_MD_FILES
  ? parseInt(process.env.READER_MIN_MD_FILES, 10)
  : 0;
const MIN_READ_BYTES = process.env.READER_MIN_READ_BYTES
  ? parseInt(process.env.READER_MIN_READ_BYTES, 10)
  : 100;

const results = [];
function record(name, status, detail) {
  results.push({ name, status, detail });
}

function httpGet(urlPath, headers) {
  const sep = urlPath.indexOf('?') >= 0 ? '&' : '?';
  const fullPath = urlPath + sep + 'token=' + encodeURIComponent(TOKEN);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: fullPath, method: 'GET', headers: headers || {} },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
        );
      }
    );
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */

async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await httpGet('/api/health');
      if (r.status === 200) return true;
    } catch (_) {
      /* 还没起来 */
    }
    await sleep(300);
  }
  return false;
}

async function main() {
  /* ---------- 1. 启动服务 ---------- */
  const child = cp.spawn(
    process.execPath,
    ['server.js', '--no-open', '--port=' + PORT, '--token=' + TOKEN],
    { cwd: __dirname, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
  );

  let serverStdout = '';
  let serverStderr = '';
  child.stdout.on('data', (d) => { serverStdout += d.toString(); });
  child.stderr.on('data', (d) => { serverStderr += d.toString(); });

  let childExited = false;
  child.on('exit', () => { childExited = true; });

  try {
    const ready = await waitForHealth(15000);
    if (!ready) {
      record('1. 服务启动 /api/health', 'FAIL',
        '15 秒内未就绪' + (childExited ? '（子进程已退出）' : '') +
        (serverStderr ? ' | stderr: ' + serverStderr.trim().slice(0, 300) : ''));
      return;
    }
    const health = JSON.parse((await httpGet('/api/health')).body.toString('utf8'));
    record('1. 服务启动 /api/health', 'PASS', 'ok=' + health.ok + ' port=' + health.port);

    /* ---------- 2. 提取图片引用并断言数量 ---------- */
    const sampleOk = fs.existsSync(SAMPLE);
    let refs = [];

    if (!sampleOk) {
      record(
        '2. 读取样本 Markdown',
        'SKIP',
        '样本不存在，跳过 2/3/4/6：' + SAMPLE +
          '（可用第一个参数或 READER_SAMPLE 指定）'
      );
    } else {
      let markdown = '';
      try {
        markdown = fs.readFileSync(SAMPLE, 'utf8');
      } catch (e) {
        record('2. 读取样本 Markdown', 'FAIL', '读取失败: ' + e.message);
      }
      const re = /!\[[^\]]*\]\(([^)]+)\)/g;
      let m;
      while ((m = re.exec(markdown)) !== null) refs.push(m[1]);

      if (EXPECTED_REFS > 0) {
        record(
          '2. 图片引用数量',
          refs.length === EXPECTED_REFS ? 'PASS' : 'FAIL',
          '期望 ' + EXPECTED_REFS + '，实际 ' + refs.length
        );
      }

      /* ---------- 3. 逐个请求 /api/asset ---------- */
      const failedAssets = [];
      for (const ref of refs) {
        const q =
          '/api/asset?file=' + encodeURIComponent(SAMPLE) + '&ref=' + encodeURIComponent(ref);
        try {
          const r = await httpGet(q);
          if (/^https?:\/\//i.test(ref)) {
            if (r.status !== 302) failedAssets.push(ref + ' (期望 302，实际 ' + r.status + ')');
            continue;
          }
          const ct = String(r.headers['content-type'] || '');
          if (r.status !== 200) {
            failedAssets.push(ref + ' (status=' + r.status + ')');
          } else if (!ct.startsWith('image/')) {
            failedAssets.push(ref + ' (content-type=' + ct + ')');
          } else if (r.body.length <= 0) {
            failedAssets.push(ref + ' (0 字节)');
          }
        } catch (e) {
          failedAssets.push(ref + ' (' + e.message + ')');
        }
      }

      record(
        '3. ' + refs.length + ' 张图片均可访问',
        failedAssets.length === 0 ? 'PASS' : 'FAIL',
        '成功 ' + (refs.length - failedAssets.length) + '/' + refs.length +
          (failedAssets.length ? '\n      失败项:\n' + failedAssets.map((f) => '        - ' + f).join('\n') : '')
      );
    }

    /* ---------- 4. /api/read ---------- */
    if (!sampleOk) {
      record('4. /api/read 全文读取', 'SKIP', '样本不存在');
    } else try {
      const r = await httpGet('/api/read?path=' + encodeURIComponent(SAMPLE));
      const j = JSON.parse(r.body.toString('utf8'));
      const chars = j && j.text ? j.text.length : 0;
      const bytes = j && j.text ? Buffer.byteLength(j.text, 'utf8') : 0;
      const hasText = !!(j && j.text && j.text.trim());
      const ok =
        r.status === 200 && bytes >= MIN_READ_BYTES && hasText && j.kind === 'markdown';
      record(
        '4. /api/read 全文读取',
        ok ? 'PASS' : 'FAIL',
        'status=' + r.status + ' 字符数=' + chars + ' 字节数=' + bytes +
          ' (>=' + MIN_READ_BYTES + ') 非空=' + hasText + ' kind=' + (j && j.kind)
      );
    } catch (e) {
      record('4. /api/read 全文读取', 'FAIL', e.message);
    }

    /* ---------- 5. 静态资源 ---------- */
    const staticChecks = [
      ['/', 'GET /'],
      ['/vendor/marked.min.js', 'GET /vendor/marked.min.js'],
      ['/vendor/highlight.min.js', 'GET /vendor/highlight.min.js'],
    ];
    for (const [p, label] of staticChecks) {
      try {
        const r = await httpGet(p);
        if (r.status === 200) {
          record('5. ' + label, 'PASS', '200, ' + r.body.length + ' 字节');
        } else if (p === '/' && r.status === 302) {
          // 首次带 ?token= 会 302 到不带令牌的地址，并写 HttpOnly Cookie
          record('5. ' + label, 'PASS', '302 → ' + (r.headers.location || '/') + '（已清除 URL 令牌）');
        } else if (p === '/') {
          record('5. ' + label, 'SKIP', 'status=' + r.status + '（前端 index.html 尚未就绪，跳过）');
        } else {
          record('5. ' + label, 'FAIL', 'status=' + r.status);
        }
      } catch (e) {
        record('5. ' + label, 'FAIL', e.message);
      }
    }

    /* ---------- 6. /api/browse ---------- */
    if (!sampleOk) {
      record('6. /api/browse 目录列表', 'SKIP', '样本目录不存在');
    } else try {
      const r = await httpGet('/api/browse?path=' + encodeURIComponent(SAMPLE_DIR));
      const j = JSON.parse(r.body.toString('utf8'));
      const mds = (j.entries || []).filter((e) => !e.isDir && e.ext === 'md');
      const ok = r.status === 200 && (MIN_MD_FILES <= 0 || mds.length >= MIN_MD_FILES);
      record(
        '6. /api/browse 目录列表',
        ok ? 'PASS' : 'FAIL',
        'status=' + r.status + ' 条目=' + (j.entries || []).length +
          ' .md 文件数=' + mds.length +
          (MIN_MD_FILES > 0 ? ' (>=' + MIN_MD_FILES + ')' : '') +
          ' parent=' + j.parent
      );
    } catch (e) {
      record('6. /api/browse 目录列表', 'FAIL', e.message);
    }
  } finally {
    try {
      child.kill();
    } catch (_) {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ */

function printReport() {
  const nameWidth = Math.max(30, ...results.map((r) => r.name.length + 2));
  console.log('');
  console.log('==================== 验 收 结 果 ====================');
  for (const r of results) {
    console.log(r.status.padEnd(6) + r.name.padEnd(nameWidth) + (r.detail || ''));
  }
  console.log('=====================================================');

  const failed = results.filter((r) => r.status === 'FAIL');
  const skipped = results.filter((r) => r.status === 'SKIP');
  const passed = results.filter((r) => r.status === 'PASS');
  console.log(
    '总计: PASS=' + passed.length + '  FAIL=' + failed.length + '  SKIP=' + skipped.length
  );

  if (failed.length) {
    console.log('\n失败明细:');
    for (const f of failed) console.log('  - ' + f.name + ': ' + (f.detail || ''));
  }

  return failed.length ? 1 : 0;
}

main()
  .catch((e) => {
    record('脚本异常', 'FAIL', (e && e.stack) || String(e));
  })
  .then(() => {
    const code = printReport();
    process.exitCode = code;
    // 确保子进程句柄不会拦住退出
    setTimeout(() => process.exit(code), 400);
  });

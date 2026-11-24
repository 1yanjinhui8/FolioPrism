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
const formats = require('../public/formats');
const { extractFileArg } = require('../main');

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
/* 1. FolioFormats 注册表一致性与格式识别                                */
/* ------------------------------------------------------------------ */

test('FolioFormats registry aligns OPENABLE_EXT, FILE_DIALOG_FILTERS, and kindOf without drift', () => {
  const openableSet = new Set(formats.OPENABLE_EXT);
  const firstFilterSet = new Set(formats.FILE_DIALOG_FILTERS[0].extensions);

  assert.deepStrictEqual(
    formats.FILE_DIALOG_FILTERS[0].extensions,
    formats.OPENABLE_EXT,
    'first file dialog filter must equal OPENABLE_EXT'
  );

  const groups = [
    formats.MARKDOWN_EXT,
    formats.HTML_EXT,
    formats.PDF_EXT,
    formats.DOCX_EXT,
    formats.SHEET_EXT,
    formats.PPTX_EXT,
    formats.PLAIN_TEXT_EXT,
    formats.CODE_EXT,
    formats.DOTFILE_EXT,
    formats.IMAGE_EXT,
    formats.VIDEO_EXT,
    formats.AUDIO_EXT,
    formats.TEXT_EXT,
  ];
  for (const grp of groups) {
    for (const ext of grp) {
      assert.ok(openableSet.has(ext), 'OPENABLE_EXT must contain .' + ext);
      assert.ok(firstFilterSet.has(ext), 'FILE_DIALOG_FILTERS[0] must contain .' + ext);
    }
  }

  for (const ext of formats.OPENABLE_EXT) {
    const kind = formats.kindOf('sample.' + ext);
    assert.notEqual(kind, 'unsupported', 'every OPENABLE_EXT must map to a supported kind: .' + ext);
  }

  // 验证音频与补齐视频格式分类
  for (const a of ['mp3', 'wav', 'm4a', 'flac', 'ogg']) {
    assert.equal(formats.kindOf('track.' + a), 'audio');
    assert.ok(formats.INLINE_RAW_EXT.has(a));
    assert.ok(formats.ASSET_EXT.has(a));
  }
  for (const v of ['mp4', 'webm', 'ogv', 'mov', 'm4v', 'mkv']) {
    assert.equal(formats.kindOf('clip.' + v), 'video');
    assert.ok(formats.INLINE_RAW_EXT.has(v));
    assert.ok(formats.ASSET_EXT.has(v));
  }
});

test('extOf, kindOf, isTextFile, and hljsLangFor handle dotfiles and extensionless files', () => {
  const dotCases = [
    { path: 'D:\\repo\\.gitignore', ext: 'gitignore', kind: 'text' },
    { path: 'D:\\repo\\.gitattributes', ext: 'gitattributes', kind: 'text' },
    { path: 'D:\\repo\\.editorconfig', ext: 'editorconfig', kind: 'text' },
    { path: 'D:\\repo\\.npmrc', ext: 'npmrc', kind: 'text' },
    { path: 'D:\\repo\\.env', ext: 'env', kind: 'text' },
    { path: 'D:\\repo\\.env.local', ext: 'env', kind: 'text' },
    { path: 'D:\\repo\\.env.production', ext: 'env', kind: 'text' },
    { path: 'D:\\repo\\.eslintrc.json', ext: 'json', kind: 'text' },
  ];
  for (const c of dotCases) {
    assert.equal(formats.extOf(c.path), c.ext, 'extOf(' + c.path + ')');
    assert.equal(formats.kindOf(c.path), c.kind, 'kindOf(' + c.path + ')');
    assert.equal(formats.isTextFile(c.path), true, 'isTextFile(' + c.path + ')');
  }

  const noExtCases = [
    { path: 'D:\\repo\\Makefile', ext: 'makefile', hljs: 'makefile' },
    { path: 'D:\\repo\\GNUmakefile', ext: 'makefile', hljs: 'makefile' },
    { path: 'D:\\repo\\Dockerfile', ext: 'dockerfile', hljs: 'dockerfile' },
    { path: 'D:\\repo\\Dockerfile.dev', ext: 'dockerfile', hljs: 'dockerfile' },
    { path: 'D:\\repo\\LICENSE', ext: 'text', hljs: '' },
    { path: 'D:\\repo\\README', ext: 'text', hljs: '' },
    { path: 'D:\\repo\\CHANGELOG', ext: 'text', hljs: '' },
    { path: 'D:\\repo\\Procfile', ext: 'text', hljs: '' },
    { path: 'D:\\repo\\Gemfile', ext: 'rb', hljs: 'rb' },
  ];
  for (const c of noExtCases) {
    assert.equal(formats.extOf(c.path), c.ext, 'extOf(' + c.path + ')');
    assert.equal(formats.kindOf(c.path), 'text', 'kindOf(' + c.path + ')');
    assert.equal(formats.isTextFile(c.path), true, 'isTextFile(' + c.path + ')');
    assert.equal(formats.hljsLangFor(c.path), c.hljs, 'hljsLangFor(' + c.path + ')');
  }

  assert.equal(formats.hljsLangFor('D:\\notes\\hello.txt'), '');
  assert.equal(formats.hljsLangFor('D:\\notes\\app.log'), '');
  assert.equal(formats.hljsLangFor('D:\\notes\\main.py'), 'py');
});

/* ------------------------------------------------------------------ */
/* 2. dirOf 与 extractFileArg 路径边界                                   */
/* ------------------------------------------------------------------ */

test('dirOf preserves Windows drive roots and UNC share roots', () => {
  assert.equal(formats.dirOf('D:\\a.txt'), 'D:\\');
  assert.equal(formats.dirOf('D:/a.txt'), 'D:\\');
  assert.equal(formats.dirOf('D:\\'), 'D:\\');
  assert.equal(formats.dirOf('D:/'), 'D:\\');
  assert.equal(formats.dirOf('D:'), 'D:\\');
  assert.equal(formats.dirOf('D:\\notes\\hello.txt'), 'D:\\notes');
  assert.equal(formats.dirOf('\\\\server\\share\\doc.md'), '\\\\server\\share');
  assert.equal(formats.dirOf('\\\\server\\share'), '\\\\server\\share');
  assert.equal(formats.dirOf('\\\\server\\share\\'), '\\\\server\\share');
});

test('extractFileArg resolves relative, Chinese, spaced paths and skips Electron flags/entry scripts', () => {
  const tmpDir = makeTempDir('fp-argv-');
  try {
    const subDir = path.join(tmpDir, '中文 目录');
    fs.mkdirSync(subDir, { recursive: true });
    const targetFile = path.join(subDir, '测试 文档.md');
    const dashFile = path.join(subDir, '-dash-note.txt');
    fs.writeFileSync(targetFile, '# Hello', 'utf8');
    fs.writeFileSync(dashFile, 'dash file', 'utf8');

    // 1. 开发模式 `electron .` 或 `electron main.js` 不误当成用户文件
    assert.equal(
      extractFileArg(['electron.exe', '.', '--remote-debugging-port=9222'], ROOT_DIR),
      ''
    );
    assert.equal(
      extractFileArg(['electron.exe', path.join(ROOT_DIR, 'main.js')], ROOT_DIR),
      ''
    );

    // 2. 相对路径结合 workingDirectory 解析
    assert.equal(
      extractFileArg(['FolioPrism.exe', '--user-data-dir=C:\\tmp', '中文 目录\\测试 文档.md'], tmpDir),
      targetFile
    );

    // 3. 带引号与 -- 分隔符后的参数
    assert.equal(
      extractFileArg(['FolioPrism.exe', '--', '"' + targetFile + '"'], ROOT_DIR),
      targetFile
    );

    // 4. 真实存在的单横线开头文件名
    assert.equal(
      extractFileArg(['FolioPrism.exe', '-dash-note.txt'], subDir),
      dashFile
    );
  } finally {
    rmrf(tmpDir);
  }
});

/* ------------------------------------------------------------------ */
/* 3. server.js: /api/browse 隐藏项/依赖开关/不可读项 & /api/read 413     */
/* ------------------------------------------------------------------ */

test('server /api/browse supports hidden/deps toggles, counts, unreadable entries, and /api/read 413', async () => {
  const tmpRoot = makeTempDir('fp-browse-150-');
  const fakeLocalAppData = path.join(tmpRoot, 'localappdata');
  const browseDir = path.join(tmpRoot, 'workspace');
  fs.mkdirSync(fakeLocalAppData, { recursive: true });
  fs.mkdirSync(browseDir, { recursive: true });

  fs.writeFileSync(path.join(browseDir, 'README'), 'extensionless readme', 'utf8');
  fs.writeFileSync(path.join(browseDir, 'Makefile'), 'all:\n\techo ok\n', 'utf8');
  fs.writeFileSync(path.join(browseDir, '.gitignore'), 'node_modules/\n', 'utf8');
  fs.writeFileSync(path.join(browseDir, '.env.local'), 'PORT=7788\n', 'utf8');
  fs.mkdirSync(path.join(browseDir, '.vscode'), { recursive: true });
  fs.mkdirSync(path.join(browseDir, 'node_modules', 'pkg'), { recursive: true });

  // 创建一个超过 32 MB 的稀疏/大文件用于验证 /api/read 413
  const hugeFile = path.join(browseDir, 'huge.log');
  const fd = fs.openSync(hugeFile, 'w');
  fs.ftruncateSync(fd, 33 * 1024 * 1024);
  fs.closeSync(fd);

  // 尝试创建指向不存在目标的损坏符号链接/目录联接以测试 stat 失败返回 unreadable: true
  const brokenLink = path.join(browseDir, 'broken_link_dir');
  let hasBrokenLink = false;
  try {
    fs.symlinkSync(path.join(browseDir, 'non_existent_target_xyz'), brokenLink, 'junction');
    hasBrokenLink = true;
  } catch (_) {
    hasBrokenLink = false;
  }

  const port = 7970 + (process.pid % 150);
  const token = 'test-browse-token-150';
  const harnessPath = path.join(tmpRoot, 'run_server.js');
  fs.writeFileSync(
    harnessPath,
    [
      `'use strict';`,
      `process.argv.push('--port=${port}', '--token=${token}', '--no-open');`,
      `const server = require(${JSON.stringify(path.join(ROOT_DIR, 'server.js'))});`,
      `server.start({ port: ${port}, root: ${JSON.stringify(browseDir)}, openBrowser: false }).then((p) => {`,
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

    // 1. 默认不传 hidden/deps：隐藏项与 node_modules 被过滤，但返回精确计数
    const resDefault = await httpGet(
      port,
      '/api/browse?token=' + token + '&path=' + encodeURIComponent(browseDir)
    );
    assert.equal(resDefault.status, 200);
    const dataDefault = JSON.parse(resDefault.body.toString('utf8'));
    assert.equal(dataDefault.hiddenCount, 3, 'expected 3 dotfiles (.gitignore, .env.local, .vscode)');
    assert.equal(dataDefault.depsHiddenCount, 1, 'expected 1 node_modules');
    const namesDefault = dataDefault.entries.map((e) => e.name);
    assert.ok(namesDefault.includes('README'));
    assert.ok(namesDefault.includes('Makefile'));
    assert.ok(!namesDefault.includes('.gitignore'));
    assert.ok(!namesDefault.includes('node_modules'));

    const readmeEntry = dataDefault.entries.find((e) => e.name === 'README');
    const makeEntry = dataDefault.entries.find((e) => e.name === 'Makefile');
    assert.equal(readmeEntry.ext, 'text');
    assert.equal(makeEntry.ext, 'makefile');

    if (hasBrokenLink) {
      const brokenEntry = dataDefault.entries.find((e) => e.name === 'broken_link_dir');
      assert.ok(brokenEntry, 'stat-failed entry must NOT be silently dropped');
      assert.equal(brokenEntry.unreadable, true);
      assert.ok(brokenEntry.error, 'unreadable entry must include error reason');
    }

    // 2. 开启 hidden=1：点文件与点目录返回，且 ext 正确识别
    const resHidden = await httpGet(
      port,
      '/api/browse?token=' + token + '&hidden=1&path=' + encodeURIComponent(browseDir)
    );
    assert.equal(resHidden.status, 200);
    const dataHidden = JSON.parse(resHidden.body.toString('utf8'));
    const gitignoreEntry = dataHidden.entries.find((e) => e.name === '.gitignore');
    const envEntry = dataHidden.entries.find((e) => e.name === '.env.local');
    const vscodeEntry = dataHidden.entries.find((e) => e.name === '.vscode');
    assert.ok(gitignoreEntry && gitignoreEntry.ext === 'gitignore');
    assert.ok(envEntry && envEntry.ext === 'env');
    assert.ok(vscodeEntry && vscodeEntry.isDir === true);
    assert.ok(!dataHidden.entries.some((e) => e.name === 'node_modules'));

    // 3. 开启 deps=1：node_modules 返回
    const resDeps = await httpGet(
      port,
      '/api/browse?token=' + token + '&deps=1&path=' + encodeURIComponent(browseDir)
    );
    assert.equal(resDeps.status, 200);
    const dataDeps = JSON.parse(resDeps.body.toString('utf8'));
    assert.ok(dataDeps.entries.some((e) => e.name === 'node_modules' && e.isDir === true));

    // 4. /api/read 超过 32 MB 返回 413 及 code: 'too-large'
    const resHuge = await httpGet(
      port,
      '/api/read?token=' + token + '&path=' + encodeURIComponent(hugeFile)
    );
    assert.equal(resHuge.status, 413);
    const dataHuge = JSON.parse(resHuge.body.toString('utf8'));
    assert.equal(dataHuge.code, 'too-large');
    assert.ok(String(dataHuge.error).includes('32 MB'));
  } finally {
    try { srv.stdin.write('shutdown\n'); } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));
    if (srv.exitCode === null) {
      try { cp.spawnSync('taskkill', ['/pid', String(srv.pid), '/T', '/F'], { windowsHide: true }); } catch (_) {}
    }
    rmrf(tmpRoot);
  }
});

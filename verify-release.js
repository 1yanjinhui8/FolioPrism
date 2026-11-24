'use strict';

/**
 * 发布产物门禁校验脚本
 *
 * 检查内容：
 *   1. package.json 与 installer/FolioPrism.iss 版本号一致
 *   2. dist/FolioPrism-win32-x64/resources/app.asar 存在且版本号与源码一致
 *   3. app.asar 内核心源码（public/app.js 等）SHA256 与工作区源码完全一致
 *   4. app.asar 内 public/app.js 不包含旧版崩溃代码 `pre.parentNode.insertBefore(wrap, pre);`
 *   5. dist/release/ 安装包、便携包、SHA256SUMS.txt、RELEASE_NOTES_<ver>.md 一致性校验
 *
 * 用法：
 *   node verify-release.js
 *   node verify-release.js --require-release
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const asar = require('@electron/asar');
const formats = require('./public/formats');

const ROOT = __dirname;
const REQUIRE_RELEASE = process.argv.includes('--require-release');

const checks = [];
function record(name, pass, detail) {
  checks.push({ name, pass, detail });
}

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const ver = String(pkg.version || '').trim();
  const issPath = path.join(ROOT, 'installer', 'FolioPrism.iss');
  const issSrc = fs.readFileSync(issPath, 'utf8');

  const appVerMatch = /^#define\s+AppVersion\s+"([^"]+)"/m.exec(issSrc);
  const infoVerMatch = /^VersionInfoVersion=([0-9.]+)/m.exec(issSrc);
  const issVer = appVerMatch ? appVerMatch[1] : '(missing)';
  const infoVer = infoVerMatch ? infoVerMatch[1] : '(missing)';

  record(
    '1. 源码与安装脚本版本号一致',
    Boolean(ver) && issVer === ver && infoVer === ver + '.0',
    `package.json=${ver}, AppVersion=${issVer}, VersionInfoVersion=${infoVer}`
  );

  const asarPath = path.join(ROOT, 'dist', 'FolioPrism-win32-x64', 'resources', 'app.asar');
  const asarExists = fs.existsSync(asarPath);
  record('2. dist app.asar 存在', asarExists, asarPath);

  if (asarExists) {
    const asarPkg = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'));
    record(
      '3. app.asar 内版本号与源码一致',
      asarPkg.version === ver,
      `asar=${asarPkg.version}, expected=${ver}`
    );

    const filesToCompare = [
      'main.js',
      'preload.js',
      'server.js',
      'translator.js',
      'public/formats.js',
      'public/app.js',
      'public/index.html',
      'public/style.css',
    ];
    const mismatched = [];
    for (const rel of filesToCompare) {
      const srcHash = sha256Buffer(fs.readFileSync(path.join(ROOT, rel)));
      let asarHash = '';
      try {
        asarHash = sha256Buffer(asar.extractFile(asarPath, rel));
      } catch (e) {
        mismatched.push(`${rel} (asar 提取失败: ${e.message})`);
        continue;
      }
      if (srcHash !== asarHash) {
        mismatched.push(`${rel} (src=${srcHash.slice(0, 12)} != asar=${asarHash.slice(0, 12)})`);
      }
    }
    record(
      '4. app.asar 核心文件与源码 SHA256 一致',
      mismatched.length === 0,
      mismatched.length === 0 ? `全部 ${filesToCompare.length} 个文件校验一致` : mismatched.join('; ')
    );

    const asarAppJs = asar.extractFile(asarPath, 'public/app.js').toString('utf8');
    const hasLegacyCrash = asarAppJs.includes('pre.parentNode.insertBefore(wrap, pre);');
    record(
      '5. app.asar 不含旧版 wrapPre 崩溃代码',
      !hasLegacyCrash,
      hasLegacyCrash ? '检测到旧版未判空 insertBefore 调用' : '未发现旧版崩溃代码'
    );

    const asarMainJs = asar.extractFile(asarPath, 'main.js').toString('utf8');
    const firstFilterExts =
      formats.FILE_DIALOG_FILTERS &&
      formats.FILE_DIALOG_FILTERS[0] &&
      Array.isArray(formats.FILE_DIALOG_FILTERS[0].extensions)
        ? formats.FILE_DIALOG_FILTERS[0].extensions
        : [];
    const filterSet = new Set(firstFilterExts);
    const missingFromFilter = formats.OPENABLE_EXT.filter((e) => !filterSet.has(e));
    const mainUsesFormatsFilter = asarMainJs.includes('formats.FILE_DIALOG_FILTERS');
    record(
      '6. 文件对话框筛选器完整覆盖 OPENABLE_EXT',
      mainUsesFormatsFilter && missingFromFilter.length === 0,
      mainUsesFormatsFilter && missingFromFilter.length === 0
        ? `共覆盖全部 ${formats.OPENABLE_EXT.length} 个可打开扩展名`
        : `mainUsesFormatsFilter=${mainUsesFormatsFilter}, missing=${missingFromFilter.join(',')}`
    );
  }

  const releaseDir = path.join(ROOT, 'dist', 'release');
  const setupName = `FolioPrism-${ver}-win32-x64-setup.exe`;
  const zipName = `FolioPrism-${ver}-win32-x64-portable.zip`;
  const sumsName = 'SHA256SUMS.txt';
  const notesName = `RELEASE_NOTES_${ver}.md`;

  const setupPath = path.join(releaseDir, setupName);
  const zipPath = path.join(releaseDir, zipName);
  const sumsPath = path.join(releaseDir, sumsName);
  const notesPath = path.join(releaseDir, notesName);

  const releaseFiles = [setupPath, zipPath, sumsPath, notesPath];
  const existingRelease = releaseFiles.filter((p) => fs.existsSync(p));
  if (REQUIRE_RELEASE || existingRelease.length > 0) {
    const missing = releaseFiles.filter((p) => !fs.existsSync(p)).map((p) => path.basename(p));
    record(
      '7. release 产物文件齐全',
      missing.length === 0,
      missing.length === 0 ? `${setupName}, ${zipName}, ${sumsName}, ${notesName}` : '缺失: ' + missing.join(', ')
    );

    if (fs.existsSync(sumsPath) && fs.existsSync(setupPath) && fs.existsSync(zipPath)) {
      const actualSetup = await sha256File(setupPath);
      const actualZip = await sha256File(zipPath);
      const sumsRaw = fs.readFileSync(sumsPath, 'utf8');
      const parsedSums = new Map();
      for (const line of sumsRaw.split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(t);
        if (m) parsedSums.set(m[2].trim(), m[1].toLowerCase());
      }
      const sumsOk =
        parsedSums.get(setupName) === actualSetup &&
        parsedSums.get(zipName) === actualZip;
      record(
        '8. SHA256SUMS.txt 校验一致',
        sumsOk,
        `setup=${actualSetup.slice(0, 12)} (${parsedSums.get(setupName) === actualSetup ? 'ok' : 'mismatch'}), zip=${actualZip.slice(0, 12)} (${parsedSums.get(zipName) === actualZip ? 'ok' : 'mismatch'})`
      );

      if (fs.existsSync(notesPath)) {
        const notesRaw = fs.readFileSync(notesPath, 'utf8');
        const notesOk = notesRaw.includes(actualSetup) && notesRaw.includes(actualZip);
        record(
          '9. RELEASE_NOTES 内 SHA256 与产物一致',
          notesOk,
          notesOk ? `${notesName} 校验值匹配` : `${notesName} 缺少或错配 SHA256`
        );
      }
    }
  }

  console.log('\n==================== 发布校验结果 ====================');
  for (const c of checks) {
    console.log((c.pass ? 'PASS  ' : 'FAIL  ') + c.name.padEnd(36) + ' ' + c.detail);
  }
  console.log('======================================================\n');

  const failed = checks.filter((c) => !c.pass);
  if (failed.length) {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('RELEASE VERIFY ERROR:', (e && e.stack) || e);
  process.exit(1);
});

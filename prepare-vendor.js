'use strict';

/**
 * 把浏览器版库文件从 node_modules 拷到 public/vendor/
 */

const fs = require('node:fs');
const path = require('node:path');

const __dir = __dirname;
const VENDOR_DIR = path.join(__dir, 'public', 'vendor');

/** 目标文件名 -> 候选源相对路径（按顺序取第一个存在的） */
const TARGETS = [
  {
    dest: 'marked.min.js',
    sources: ['node_modules/marked/marked.min.js', 'node_modules/marked/lib/marked.umd.js'],
  },
  {
    dest: 'highlight.min.js',
    sources: ['node_modules/@highlightjs/cdn-assets/highlight.min.js'],
  },
  {
    dest: 'hljs-github.min.css',
    sources: ['node_modules/@highlightjs/cdn-assets/styles/github.min.css'],
  },
  {
    dest: 'hljs-github-dark.min.css',
    sources: ['node_modules/@highlightjs/cdn-assets/styles/github-dark.min.css'],
  },
  {
    dest: 'mammoth.browser.min.js',
    sources: ['node_modules/mammoth/mammoth.browser.min.js'],
  },
  {
    dest: 'xlsx.full.min.js',
    sources: ['node_modules/xlsx/dist/xlsx.full.min.js'],
  },
  {
    // Markdown 里的原始 HTML 必须消毒后再进 DOM，见 public/app.js 的 sanitizeHtml()
    dest: 'purify.min.js',
    sources: ['node_modules/dompurify/dist/purify.min.js'],
  },
];

function main() {
  fs.mkdirSync(VENDOR_DIR, { recursive: true });

  const missing = [];

  for (const t of TARGETS) {
    let picked = null;
    for (const rel of t.sources) {
      const src = path.join(__dir, rel);
      if (fs.existsSync(src) && fs.statSync(src).isFile()) {
        picked = { rel, src };
        break;
      }
    }

    if (!picked) {
      missing.push(t.dest + '  (候选: ' + t.sources.join(' | ') + ')');
      continue;
    }

    const dest = path.join(VENDOR_DIR, t.dest);
    fs.copyFileSync(picked.src, dest);
    const bytes = fs.statSync(dest).size;
    console.log('OK  ' + picked.rel + '  ->  ' + path.relative(__dir, dest) + '  ' + bytes);
  }

  if (missing.length) {
    console.error('\n以下 vendor 文件缺失（请先运行 npm install）：');
    for (const m of missing) console.error('  MISSING  ' + m);
    process.exitCode = 1;
    return;
  }

  console.log('\n全部 ' + TARGETS.length + ' 个 vendor 文件已就绪: ' + path.relative(__dir, VENDOR_DIR));
}

main();

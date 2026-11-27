'use strict';

/**
 * FolioPrism（棱阅）—— 统一格式注册表（Node 与浏览器共享 UMD）
 *
 * 作为 src/main、src/server、src/renderer/app.js 及自动化测试的唯一格式真相源，
 * 消除文件选择框筛选器、服务端白名单与前端渲染分支之间的扩展名漂移。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FolioFormats = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function () {
  function uniq(list) {
    const out = [];
    const seen = new Set();
    for (let i = 0; i < list.length; i++) {
      const v = String(list[i] || '').toLowerCase().trim();
      if (v && !seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
    return out;
  }

  const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'];
  const VIDEO_EXT = ['mp4', 'webm', 'ogv', 'mov', 'm4v', 'mkv'];
  const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'flac', 'ogg'];
  const DOCX_EXT = ['docx'];
  const SHEET_EXT = ['xlsx', 'xls', 'csv'];
  const MARKDOWN_EXT = ['md', 'markdown'];
  const HTML_EXT = ['html', 'htm'];
  const PDF_EXT = ['pdf'];
  const PPTX_EXT = ['pptx'];

  const PLAIN_TEXT_EXT = ['txt', 'log', 'text', 'plaintext', 'tsv'];

  const CODE_EXT = [
    'js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs',
    'go', 'rs', 'php', 'rb', 'sh', 'bat', 'ps1', 'css', 'scss', 'less', 'json', 'yaml', 'yml',
    'toml', 'ini', 'conf', 'xml', 'sql', 'vue', 'svelte', 'swift', 'kt', 'm', 'mm', 'gradle',
    'properties', 'r', 'lua', 'dart', 'pl', 'makefile', 'dockerfile',
  ];

  const DOTFILE_EXT = [
    'env', 'gitignore', 'gitattributes', 'gitmodules', 'editorconfig',
    'npmrc', 'nvmrc', 'prettierrc', 'eslintrc', 'dockerignore',
    'bashrc', 'zshrc', 'profile', 'clang-format',
  ];

  // TEXT_EXT 包含所有走文本/代码/Markdown 文本读取通道的扩展名（csv 优先走 SHEET_EXT 表格视图）
  const TEXT_EXT = uniq([
    ...MARKDOWN_EXT,
    ...PLAIN_TEXT_EXT,
    ...CODE_EXT,
    ...DOTFILE_EXT,
  ]);

  const EXTENSIONLESS_TEXT_MAP = {
    makefile: 'makefile',
    gnumakefile: 'makefile',
    dockerfile: 'dockerfile',
    license: 'text',
    licence: 'text',
    readme: 'text',
    changelog: 'text',
    procfile: 'text',
    gemfile: 'rb',
    rakefile: 'rb',
    vagrantfile: 'rb',
    authors: 'text',
    contributors: 'text',
    notice: 'text',
    todo: 'text',
  };

  const EXTENSIONLESS_TEXT_NAMES = Object.keys(EXTENSIONLESS_TEXT_MAP);

  const DOTFILE_TEXT_NAMES = DOTFILE_EXT.map((e) => '.' + e);
  const DOTFILE_TEXT_SET = new Set(DOTFILE_TEXT_NAMES);

  // /api/raw 允许内联返回的扩展名（svg 单独在 applyRawPolicy 中带 sandbox CSP 返回，不进此集合以阻止 /api/ticket 顶层打开）
  const INLINE_RAW_EXT = new Set(
    uniq([
      ...IMAGE_EXT.filter((e) => e !== 'svg'),
      ...VIDEO_EXT,
      ...AUDIO_EXT,
      ...PDF_EXT,
      ...DOCX_EXT,
      'xlsx', 'xls',
      ...PPTX_EXT,
    ])
  );

  // 文档内相对引用资源（<img>/<video>/<audio>）允许的媒体类型
  const ASSET_EXT = new Set(uniq([...IMAGE_EXT, ...VIDEO_EXT, ...AUDIO_EXT]));

  // 前端能够直接打开/预览（或展示专属卡片）的全部扩展名集合
  const OPENABLE_EXT = uniq([
    ...MARKDOWN_EXT,
    ...HTML_EXT,
    ...PDF_EXT,
    ...DOCX_EXT,
    ...SHEET_EXT,
    ...PPTX_EXT,
    ...PLAIN_TEXT_EXT,
    ...CODE_EXT,
    ...DOTFILE_EXT,
    ...IMAGE_EXT,
    ...VIDEO_EXT,
    ...AUDIO_EXT,
  ]);

  const FILE_DIALOG_FILTERS = [
    {
      name: '可以阅读的文件',
      extensions: OPENABLE_EXT.slice(),
    },
    {
      name: '文档与网页',
      extensions: uniq([
        ...MARKDOWN_EXT,
        ...PDF_EXT,
        ...DOCX_EXT,
        ...SHEET_EXT,
        ...PPTX_EXT,
        ...HTML_EXT,
        ...PLAIN_TEXT_EXT,
      ]),
    },
    {
      name: '代码与配置文件',
      extensions: uniq([...CODE_EXT, ...DOTFILE_EXT]),
    },
    {
      name: '图片与音视频',
      extensions: uniq([...IMAGE_EXT, ...VIDEO_EXT, ...AUDIO_EXT]),
    },
    {
      name: '所有文件',
      extensions: ['*'],
    },
  ];

  // Windows 安装包注册「打开方式」的常用文档/代码/媒体扩展名
  const FILE_ASSOCIATION_EXTS = uniq([
    ...MARKDOWN_EXT,
    ...PLAIN_TEXT_EXT,
    ...PDF_EXT,
    ...DOCX_EXT,
    ...SHEET_EXT,
    ...HTML_EXT,
    'json', 'yaml', 'yml', 'toml', 'ini', 'conf', 'xml', 'sql',
    'js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs',
    'go', 'rs', 'php', 'rb', 'sh', 'bat', 'ps1', 'css', 'scss', 'less', 'vue', 'svelte',
    'swift', 'kt', 'r', 'lua', 'dart', 'pl',
    ...IMAGE_EXT,
    ...VIDEO_EXT,
    ...AUDIO_EXT,
  ]);

  const IMAGE_SET = new Set(IMAGE_EXT);
  const VIDEO_SET = new Set(VIDEO_EXT);
  const AUDIO_SET = new Set(AUDIO_EXT);
  const DOCX_SET = new Set(DOCX_EXT);
  const SHEET_SET = new Set(SHEET_EXT);
  const MARKDOWN_SET = new Set(MARKDOWN_EXT);
  const HTML_SET = new Set(HTML_EXT);
  const CODE_SET = new Set(CODE_EXT);
  const PLAIN_TEXT_SET = new Set(PLAIN_TEXT_EXT);
  const TEXT_SET = new Set(TEXT_EXT);

  /** 提取路径最后一段文件名 */
  function baseNameOf(filePath) {
    const raw = String(filePath || '').trim();
    if (!raw) return '';
    if (/^[A-Za-z]:[\\/]*$/.test(raw)) return raw[0] + ':';
    const s = raw.replace(/[\\/]+$/, '');
    const parts = s.split(/[\\/]/);
    return parts[parts.length - 1] || '';
  }

  /**
   * 提取文件父目录路径，正确处理 Windows 盘根目录（D:\a.txt -> D:\）与 UNC 共享根（\\server\share）。
   */
  function dirOf(filePath) {
    const raw = String(filePath || '').trim();
    if (!raw) return '';
    if (/^[A-Za-z]:[\\/]*$/.test(raw)) {
      return raw[0] + ':\\';
    }
    const s = raw.replace(/[\\/]+$/, '');
    if (/^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+$/.test(s)) {
      return s.replace(/\//g, '\\');
    }
    const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
    if (i < 0) return s;
    if (i === 0) return s[0] === '/' ? '/' : s[0] + '\\';
    const head = s.slice(0, i);
    if (/^[A-Za-z]:$/.test(head)) return head + '\\';
    return head;
  }

  /**
   * 统一扩展名/特殊文件名识别：
   *   - 点文件：.gitignore -> 'gitignore'，.env / .env.local -> 'env'
   *   - 无扩展名：Makefile -> 'makefile'，Dockerfile -> 'dockerfile'，LICENSE / README -> 'text'
   *   - 常规文件：最后一个 '.' 后的小写扩展名
   */
  function extOf(filePath) {
    const base = baseNameOf(filePath);
    const lower = base.toLowerCase();
    if (!lower) return '';

    if (lower === '.env' || lower.startsWith('.env.')) return 'env';
    if (lower === '.eslintrc' || lower.startsWith('.eslintrc.')) {
      const tail = lower.slice('.eslintrc.'.length);
      if (tail && CODE_SET.has(tail)) return tail;
      return 'eslintrc';
    }
    if (lower === '.prettierrc' || lower.startsWith('.prettierrc.')) {
      const tail = lower.slice('.prettierrc.'.length);
      if (tail && CODE_SET.has(tail)) return tail;
      return 'prettierrc';
    }
    if (DOTFILE_TEXT_SET.has(lower)) {
      return lower.slice(1);
    }

    if (Object.prototype.hasOwnProperty.call(EXTENSIONLESS_TEXT_MAP, lower)) {
      return EXTENSIONLESS_TEXT_MAP[lower];
    }
    if (lower.startsWith('dockerfile.')) {
      return 'dockerfile';
    }

    const dot = lower.lastIndexOf('.');
    if (dot > 0 && dot < lower.length - 1) {
      const ext = lower.slice(dot + 1);
      if (/^[a-z0-9_-]+$/.test(ext)) return ext;
    }
    return '';
  }

  /**
   * 统一判断文件的渲染分类：
   * 'markdown' | 'html' | 'docx' | 'sheet' | 'pptx' | 'pdf' | 'image' | 'video' | 'audio' | 'text' | 'unsupported'
   */
  function kindOf(filePath) {
    const ext = extOf(filePath);
    if (!ext) return 'unsupported';
    if (MARKDOWN_SET.has(ext)) return 'markdown';
    if (HTML_SET.has(ext)) return 'html';
    if (DOCX_SET.has(ext)) return 'docx';
    if (SHEET_SET.has(ext)) return 'sheet';
    if (ext === 'pptx') return 'pptx';
    if (ext === 'pdf') return 'pdf';
    if (IMAGE_SET.has(ext)) return 'image';
    if (VIDEO_SET.has(ext)) return 'video';
    if (AUDIO_SET.has(ext)) return 'audio';
    if (TEXT_SET.has(ext)) return 'text';
    return 'unsupported';
  }

  function isTextFile(filePath) {
    return kindOf(filePath) === 'text';
  }

  /** 供服务端 /api/read 返回的 kind 字段（'markdown' | 'code' | 'text'） */
  function serverKindFor(filePathOrExt) {
    const raw = String(filePathOrExt || '').trim();
    const ext = raw.includes('.') || raw.includes('\\') || raw.includes('/')
      ? extOf(raw)
      : (EXTENSIONLESS_TEXT_MAP[raw.toLowerCase()] || raw.toLowerCase());
    if (MARKDOWN_SET.has(ext)) return 'markdown';
    if (CODE_SET.has(ext) || HTML_SET.has(ext) || DOTFILE_TEXT_SET.has('.' + ext)) return 'code';
    return 'text';
  }

  /**
   * 返回传给 highlight.js 的语言名；纯文本返回 ''（避免对 .txt/.log/LICENSE/README 做无意义语法猜测）。
   */
  function hljsLangFor(filePath) {
    const ext = extOf(filePath);
    if (!ext || PLAIN_TEXT_SET.has(ext)) return '';
    return ext;
  }

  return {
    IMAGE_EXT,
    VIDEO_EXT,
    AUDIO_EXT,
    DOCX_EXT,
    SHEET_EXT,
    MARKDOWN_EXT,
    HTML_EXT,
    PDF_EXT,
    PPTX_EXT,
    PLAIN_TEXT_EXT,
    CODE_EXT,
    DOTFILE_EXT,
    TEXT_EXT,
    EXTENSIONLESS_TEXT_NAMES,
    DOTFILE_TEXT_NAMES,
    INLINE_RAW_EXT,
    ASSET_EXT,
    OPENABLE_EXT,
    FILE_DIALOG_FILTERS,
    FILE_ASSOCIATION_EXTS,
    baseNameOf,
    dirOf,
    extOf,
    kindOf,
    isTextFile,
    serverKindFor,
    hljsLangFor,
  };
});

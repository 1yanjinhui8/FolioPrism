'use strict';

/**
 * 打包成绿色免安装的 Windows 桌面应用。
 *
 *   npm run dist
 *
 * 产物：dist/FolioPrism-win32-x64/ —— 整个目录拷到别的电脑双击 exe 就能用，
 * 目标机器不需要装 Node.js，也不需要 npm install。
 */

const path = require('node:path');
const { packager } = require('@electron/packager');

const ROOT = path.join(__dirname, '..');
const APP_NAME = 'FolioPrism';

/**
 * 白名单：只放行运行时真正需要的东西。
 *
 * 以前这里是 IGNORE 黑名单（默认放行），新加一个调试脚本 / .env 就会被悄悄
 * 打进安装包。改成白名单后，新文件默认进不来；万一漏了 src/ 里的运行时代码，
 * 打包版一启动就会立刻报错，而不是发布之后才发现。
 *
 * @param {string} relPath 相对仓库根的路径（Windows 下已统一为 / 分隔）
 * @returns {boolean} true 表示忽略（不打包）
 */
function shouldIgnore(relPath) {
  if (!relPath || relPath === '/') return false;
  // 根目录只保留这些文件；其余（.github、docs、scripts、test、installer、assets、
  // README、start.bat……）一律不进包
  const ROOT_ALLOW = ['/package.json', '/src', '/build'];
  const first = '/' + relPath.split('/').filter(Boolean)[0];
  if (!ROOT_ALLOW.includes(first)) return true;

  // src/ 下只排除开发期目录：测试与文档不在 src 内，这里留一个保险
  if (first === '/src') {
    return /^\/src\/(test|docs)(\/|$)/.test(relPath);
  }
  return false;
}

packager({
  dir: ROOT,
  out: path.join(ROOT, 'dist'),
  name: APP_NAME,
  appVersion: require(path.join(ROOT, 'package.json')).version,
  platform: 'win32',
  arch: 'x64',
  icon: path.join(ROOT, 'build', 'icon.ico'),
  // 内网/断网时用本地 electron zip 目录打包（见 README 的打包说明）
  electronZipDir: process.env.ELECTRON_ZIP_DIR || undefined,
  overwrite: true,
  asar: true,
  prune: false,
  ignore: shouldIgnore,
  win32metadata: {
    CompanyName: 'FolioPrism',
    FileDescription: 'FolioPrism 棱阅 · 本地多媒体文档与双语阅读工作台',
    ProductName: APP_NAME,
    InternalName: APP_NAME,
    OriginalFilename: APP_NAME + '.exe',
  },
})
  .then((paths) => {
    console.log('\n打包完成，产物目录：');
    paths.forEach((p) => console.log('  ' + p));
    console.log('\n把整个目录拷走，双击里面的 ' + APP_NAME + '.exe 即可运行。');
  })
  .catch((e) => {
    console.error('打包失败：', (e && e.stack) || e);
    process.exit(1);
  });

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

const ROOT = __dirname;
const APP_NAME = 'FolioPrism';

// 运行时用不到的：打包工具产物、开发脚本、Web 模式启动器、依赖源码
// （public/vendor 里的浏览器版库是 prepare-vendor 早就拷好的，运行时不需要 node_modules）
const IGNORE = [
  /^\/dist(\/|$)/,
  /^\/node_modules(\/|$)/,
  /^\/runtime\.log$/,
  /^\/\.trae(\/|$)/,
  /^\/verify\.js$/,
  /^\/prepare-vendor\.js$/,
  /^\/start\.bat$/,
  /^\/pack\.js$/,
  // 开发期资产：测试脚本、安装包脚本，运行时都不需要
  /^\/test(\/|$)/,
  /^\/installer(\/|$)/,
  // 本机用户数据备份（阅读进度、缓存、配置），绝不能打进分发包
  /^\/data-backup(\/|$)/,
];

packager({
  dir: ROOT,
  out: path.join(ROOT, 'dist'),
  name: APP_NAME,
  appVersion: require('./package.json').version,
  platform: 'win32',
  arch: 'x64',
  icon: path.join(ROOT, 'build', 'icon.ico'),
  // 内网/断网时用本地 electron zip 目录打包（见 README 的打包说明）
  electronZipDir: process.env.ELECTRON_ZIP_DIR || undefined,
  overwrite: true,
  asar: true,
  prune: false,
  ignore: IGNORE,
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

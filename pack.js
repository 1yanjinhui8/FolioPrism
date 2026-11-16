'use strict';

/**
 * 打包成绿色免安装的 Windows 桌面应用。
 *
 *   npm run dist
 *
 * 产物：dist/媒体阅读器-win32-x64/ —— 整个目录拷到别的电脑双击 exe 就能用，
 * 目标机器不需要装 Node.js，也不需要 npm install。
 */

const path = require('node:path');
const { packager } = require('@electron/packager');

const ROOT = __dirname;
const APP_NAME = '媒体阅读器';

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
];

packager({
  dir: ROOT,
  out: path.join(ROOT, 'dist'),
  name: APP_NAME,
  appVersion: require('./package.json').version,
  platform: 'win32',
  arch: 'x64',
  icon: path.join(ROOT, 'build', 'icon.ico'),
  overwrite: true,
  asar: true,
  prune: false,
  ignore: IGNORE,
  win32metadata: {
    CompanyName: 'Media Reader',
    FileDescription: '本地多媒体阅读器',
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

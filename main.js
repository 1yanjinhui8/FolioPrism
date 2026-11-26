'use strict';

/**
 * FolioPrism（棱阅）—— Electron 主进程
 *
 * 职责：
 *   1. 在本机起一个 node:http 服务（server.js），窗口指向 http://127.0.0.1:<port>
 *   2. 提供原生文件夹选择对话框（主进程前台调用，不受 Windows 前台锁定影响）
 *   3. 单实例、外链交给系统浏览器、窗口菜单
 */

const path = require('node:path');
const fs = require('node:fs');
const cp = require('node:child_process');
const electron = require('electron');
const { app, BrowserWindow, Menu, dialog, ipcMain, shell } =
  typeof electron === 'object' && electron ? electron : {};

const server = require('./server');
const formats = require('./public/formats');

// 产品名用英文，进程名 / exe 名 / 安装目录都用它；界面上再带中文名「棱阅」
const APP_NAME = 'FolioPrism';
const APP_TITLE = 'FolioPrism 棱阅';
const LEGACY_APP_NAME = '媒体阅读器';
const ICON_PATH = path.join(__dirname, 'build', 'icon.ico');
const START_PORT = 7788;

let mainWindow = null;
let baseUrl = '';

/**
 * 命令行里带的文件路径。
 *
 * Windows 的「双击打开」「打开方式 → FolioPrism」都是把文件路径作为
 * argv 传给 exe 的。以前这里完全不看 argv，所以双击 docx 只会把已经
 * 开着的窗口拉到前台、或者恢复上次读的文件，新文件永远打不开。
 */
let pendingOpenFile = extractFileArg(process.argv, process.cwd());
/** 当前渲染进程正在浏览的根目录，保证对话框起始路径与侧栏同步 */
let currentRoot = '';
/** 最近一次打开文件/文件夹的位置，下次弹框从这里接着选 */
let lastDialogDir = '';

function extractFileArg(argv, cwd) {
  if (!Array.isArray(argv)) return '';
  const baseCwd = cwd && typeof cwd === 'string' ? cwd : process.cwd();
  const appDir = path.resolve(__dirname).toLowerCase();
  const mainScript = path.resolve(__dirname, 'main.js').toLowerCase();
  const pkgJson = path.resolve(__dirname, 'package.json').toLowerCase();
  let afterDoubleDash = false;

  for (let i = 1; i < argv.length; i++) {
    let a = String(argv[i] || '').trim();
    if (!a) continue;
    if (!afterDoubleDash && a === '--') {
      afterDoubleDash = true;
      continue;
    }
    // 剥离外层多余引号
    if (a.length >= 2 && a.startsWith('"') && a.endsWith('"')) {
      a = a.slice(1, -1).trim();
    }
    if (!a) continue;
    if (!afterDoubleDash) {
      // 跳过明确的双横线开关（如 --remote-debugging-port=...、--user-data-dir=...）
      if (a.startsWith('--')) continue;
      // 开发模式 `electron .`：argv[1] 是应用目录本身，不是用户文件
      if (a === '.' || a === '..') continue;
    }

    let resolved = '';
    try {
      resolved = path.resolve(baseCwd, a);
    } catch (_) {
      continue;
    }
    const lowerResolved = resolved.toLowerCase();
    if (
      lowerResolved === appDir ||
      lowerResolved === mainScript ||
      lowerResolved === pkgJson
    ) {
      continue;
    }
    // 单横线参数若不是实际存在的文件则视为开关跳过；若是真实文件（如 -notes.txt）则放行
    try {
      if (fs.statSync(resolved).isFile()) return resolved;
    } catch (_) {
      /* 不是已存在的文件就跳过 */
    }
  }
  return '';
}

/** 把文件交给渲染进程打开；窗口还没建好时先记下来 */
function openFileInRenderer(filePath) {
  if (!filePath) return;
  lastDialogDir = formats.dirOf(filePath) || path.dirname(filePath);
  if (!mainWindow || mainWindow.isDestroyed()) {
    pendingOpenFile = filePath;
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
  mainWindow.webContents.send('reader:open-file', filePath);
}

/* ------------------------------------------------------------------ */
/* 原生对话框 / IPC                                                     */
/* ------------------------------------------------------------------ */

function resolveDialogStartDir(startDir) {
  const candidates = [startDir, currentRoot, lastDialogDir];
  for (const c of candidates) {
    const dir = String(c || '').trim();
    if (!dir || dir === '__DRIVES__') continue;
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir;
    } catch (_) {
      /* ignore */
    }
  }
  try {
    return app ? app.getPath('documents') : process.cwd();
  } catch (_) {
    return process.cwd();
  }
}

/** 选单个文件（菜单「打开文件…」）。筛选器与渲染器格式表完全同步 */
async function pickFile(startDir) {
  const defaultPath = resolveDialogStartDir(startDir);

  const opts = {
    title: '选择要打开的文件',
    defaultPath,
    buttonLabel: '打开',
    properties: ['openFile'],
    filters: formats.FILE_DIALOG_FILTERS,
  };
  const r = mainWindow
    ? await dialog.showOpenDialog(mainWindow, opts)
    : await dialog.showOpenDialog(opts);

  if (r.canceled || !r.filePaths.length) return null;
  const chosen = r.filePaths[0];
  lastDialogDir = formats.dirOf(chosen) || path.dirname(chosen);
  return chosen;
}

/** 读取 Windows「文本大小」辅助功能缩放比例（100% -> 1.0），非 Windows 或读取失败回退 1 */
function readSystemTextScale() {
  if (process.platform !== 'win32') return Promise.resolve(1);
  return new Promise((resolve) => {
    cp.execFile(
      'reg.exe',
      ['query', 'HKCU\\Software\\Microsoft\\Accessibility', '/v', 'TextScaleFactor'],
      { encoding: 'utf8', windowsHide: true, timeout: 2000 },
      (err, stdout) => {
        if (err || !stdout) return resolve(1);
        const m = /TextScaleFactor\s+REG_DWORD\s+(0x[0-9a-fA-F]+|\d+)/i.exec(String(stdout));
        if (!m) return resolve(1);
        const raw = m[1].toLowerCase().startsWith('0x')
          ? parseInt(m[1], 16)
          : parseInt(m[1], 10);
        if (!Number.isFinite(raw) || raw <= 0) return resolve(1);
        const scale = Math.max(0.8, Math.min(2.25, Math.round(raw) / 100));
        resolve(scale);
      }
    );
  });
}

function registerIpc() {
  ipcMain.handle('reader:pick-file', (_e, startDir) => pickFile(startDir));
  ipcMain.handle('reader:system-text-scale', () => readSystemTextScale());
  ipcMain.handle('reader:set-current-root', (_e, dir) => {
    const d = String(dir || '').trim();
    if (d && d !== '__DRIVES__') {
      currentRoot = d;
      lastDialogDir = d;
    }
    return currentRoot;
  });

  // 启动参数里的文件只交付一次：刷新页面时不该又被拉回去
  ipcMain.handle('reader:initial-file', () => {
    const f = pendingOpenFile;
    pendingOpenFile = '';
    return f || '';
  });

  ipcMain.handle('reader:open-external', (_e, url) => {
    if (/^https?:\/\//i.test(String(url || ''))) shell.openExternal(url);
  });

  ipcMain.handle('reader:app-info', () => ({
    name: APP_NAME,
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
  }));
}

/** 菜单里点「打开文件」：选完直接把文件推给渲染进程 */
async function menuOpenFile() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const file = await pickFile(currentRoot || lastDialogDir || null);
  if (!file) return;
  openFileInRenderer(file);
}

/** 把「视图」菜单里的阅读控制动作转发给渲染进程 */
function sendViewAction(action) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('reader:view-action', String(action || ''));
}

/* ------------------------------------------------------------------ */
/* 菜单                                                                */
/* ------------------------------------------------------------------ */

function buildMenu() {
  const devtools = [
    { label: '开发者工具', accelerator: 'F12', click: () => mainWindow && mainWindow.webContents.toggleDevTools() },
  ];
  // 打包后的正式版不给用户留调试入口；排查问题时可用 READER_DEVTOOLS=1 打开
  const allowDevtools = !app.isPackaged || process.env.READER_DEVTOOLS === '1';

  return Menu.buildFromTemplate([
    {
      label: '文件',
      submenu: [
        { label: '打开文件…', accelerator: 'CmdOrCtrl+O', click: menuOpenFile },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '增大字号（A+）', click: () => sendViewAction('font-inc') },
        { label: '减小字号（A-）', click: () => sendViewAction('font-dec') },
        { label: '切换阅读宽度', click: () => sendViewAction('toggle-width') },
        { label: '翻译设置…', click: () => sendViewAction('translate-settings') },
        { type: 'separator' },
        { label: '重新加载', accelerator: 'CmdOrCtrl+R', click: () => mainWindow && mainWindow.reload() },
        { type: 'separator' },
        { label: '放大页面', role: 'zoomIn' },
        { label: '缩小页面', role: 'zoomOut' },
        { label: '实际大小', role: 'resetZoom' },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' },
        ...(allowDevtools ? [{ type: 'separator' }, ...devtools] : []),
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 ' + APP_TITLE,
          click: () => {
            const opts = {
              type: 'info',
              title: '关于 ' + APP_TITLE,
              message: APP_TITLE + ' ' + app.getVersion(),
              detail:
                '本地优先的多媒体文档与双语阅读工作台：Markdown / 代码 / PDF / Office 渲染，图片与视频真实显示。\n\n' +
                'Electron ' + process.versions.electron + ' · Node ' + process.versions.node,
              buttons: ['好'],
            };
            if (mainWindow) dialog.showMessageBox(mainWindow, opts);
            else dialog.showMessageBox(opts);
          },
        },
      ],
    },
  ]);
}

/* ------------------------------------------------------------------ */
/* 窗口                                                                */
/* ------------------------------------------------------------------ */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1040,
    minHeight: 640,
    title: APP_TITLE,
    icon: ICON_PATH,
    backgroundColor: '#f6f7f9',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // 进度条：页面加载期间在任务栏显示，加载完清掉
  mainWindow.webContents.on('did-start-loading', () => {
    if (mainWindow) mainWindow.setProgressBar(2, { mode: 'indeterminate' });
  });
  mainWindow.webContents.on('did-stop-loading', () => {
    if (mainWindow) mainWindow.setProgressBar(-1);
  });

  // 本地服务没起来 / 页面被导航到坏地址时，不要只留一个空白窗口
  mainWindow.webContents.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* ERR_ABORTED */) return;
    const opts = {
      type: 'error',
      title: APP_TITLE,
      message: '页面加载失败',
      detail: (desc || '未知错误') + '（' + code + '）\n' + url,
      buttons: ['重试', '退出'],
      defaultId: 0,
      cancelId: 1,
    };
    const p = mainWindow
      ? dialog.showMessageBox(mainWindow, opts)
      : dialog.showMessageBox(opts);
    p.then((r) => {
      if (r.response === 0) {
        if (mainWindow) mainWindow.reload();
      } else {
        app.quit();
      }
    });
  });

  // 首次加载带上本机访问令牌；服务端会把它换成 HttpOnly Cookie，
  // 之后页面内的 fetch / 图片 / 音频 / PDF 子资源都不用再拼令牌
  const token = typeof server.getToken === 'function' ? server.getToken() : '';
  mainWindow.loadURL(baseUrl + (token ? '?token=' + encodeURIComponent(token) : ''));

  // 外链（含文中的 B 站 / YouTube 链接）交给系统浏览器，别在阅读器窗口里乱跳
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(baseUrl)) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

async function bootstrap() {
  migrateUserData();
  Menu.setApplicationMenu(buildMenu());
  registerIpc();

  let port;
  try {
    port = await server.start({ port: START_PORT, openBrowser: false });
  } catch (e) {
    dialog.showErrorBox(APP_TITLE, '本地服务启动失败：\n' + ((e && e.message) || e));
    app.quit();
    return;
  }

  baseUrl = 'http://127.0.0.1:' + port + '/';
  createWindow();

  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
}

/**
 * 改名后的数据目录迁移。
 *
 * Electron 的 userData（含 localStorage 里的阅读进度、主题、最近文件）
 * 目录名跟随 app.setName。直接改名会让老用户「阅读记录全没了」，
 * 所以首次以新名字启动时，把旧的整个目录复制过来；旧目录保持不动，
 * 万一要回退旧版本还能用。
 */
function migrateUserData() {
  try {
    const newDir = app.getPath('userData');
    const oldDir = path.join(app.getPath('appData'), LEGACY_APP_NAME);
    if (!fs.existsSync(newDir) && fs.existsSync(oldDir)) {
      fs.cpSync(oldDir, newDir, { recursive: true });
    }
  } catch (_) {
    /* 迁移失败不阻塞启动：大不了用户重新选一次文件夹 */
  }
}

if (app && typeof app.setName === 'function') {
  app.setName(APP_NAME);
  if (process.platform === 'win32') app.setAppUserModelId('com.folioprism.app');

  // 退出时结束所有子进程（pdf2zh / Edge TTS / 引擎安装），否则它们会变成孤儿进程
  // 继续在后台跑。只做一次，避免 before-quit 被多次触发。
  let childrenKilled = false;
  app.on('before-quit', () => {
    if (childrenKilled) return;
    childrenKilled = true;
    try {
      server.shutdown();
    } catch (_) {
      /* ignore */
    }
  });

  if (!app.requestSingleInstanceLock()) {
    app.quit();
  } else {
    // 已经在运行时再双击一个文件：argv 里带着新文件，结合 workingDirectory 解析后
    // 交给现有窗口打开（若窗口尚未建好也通过 openFileInRenderer 写入 pendingOpenFile）
    app.on('second-instance', (_e, argv, workingDirectory) => {
      const file = extractFileArg(argv, workingDirectory);
      if (file) {
        openFileInRenderer(file);
        return;
      }
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    });

    app.whenReady().then(bootstrap);

    app.on('window-all-closed', () => {
      app.quit();
    });
  }
}

module.exports = {
  extractFileArg,
  readSystemTextScale,
};

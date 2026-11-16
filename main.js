'use strict';

/**
 * 媒体阅读器 —— Electron 主进程
 *
 * 职责：
 *   1. 在本机起一个 node:http 服务（server.js），窗口指向 http://127.0.0.1:<port>
 *   2. 提供原生文件夹选择对话框（主进程前台调用，不受 Windows 前台锁定影响）
 *   3. 单实例、外链交给系统浏览器、窗口菜单
 */

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');

const server = require('./server');

const APP_NAME = '媒体阅读器';
const ICON_PATH = path.join(__dirname, 'build', 'icon.ico');
const START_PORT = 7788;

let mainWindow = null;
let baseUrl = '';

/* ------------------------------------------------------------------ */
/* 原生对话框 / IPC                                                     */
/* ------------------------------------------------------------------ */

/** 选文件夹；startDir 传当前正在看的目录，用户就不用每次从头点 */
async function pickFolder(startDir) {
  const defaultPath =
    startDir && fs.existsSync(startDir)
      ? startDir
      : app.getPath('documents');

  const opts = {
    title: '选择要阅读的文件夹',
    defaultPath,
    buttonLabel: '打开',
    properties: ['openDirectory'],
  };
  // 带父窗口时对话框是模态的，不会被主窗口盖住
  const r = mainWindow
    ? await dialog.showOpenDialog(mainWindow, opts)
    : await dialog.showOpenDialog(opts);

  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
}

function registerIpc() {
  ipcMain.handle('reader:pick-folder', (_e, startDir) => pickFolder(startDir));

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

/** 菜单里点「打开文件夹」：主进程弹框，选完把结果推给渲染进程 */
async function menuOpenFolder() {
  if (!mainWindow) return;
  const dir = await pickFolder(null);
  if (!dir || !mainWindow) return;
  mainWindow.webContents.send('reader:open-folder', dir);
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
        { label: '打开文件夹…', accelerator: 'CmdOrCtrl+O', click: menuOpenFolder },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', accelerator: 'CmdOrCtrl+R', click: () => mainWindow && mainWindow.reload() },
        { type: 'separator' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
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
          label: '关于 ' + APP_NAME,
          click: () => {
            const opts = {
              type: 'info',
              title: '关于 ' + APP_NAME,
              message: APP_NAME + ' ' + app.getVersion(),
              detail:
                '本地多媒体阅读器：Markdown / 代码 / PDF / Office 渲染，图片与视频真实显示。\n\n' +
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
    title: APP_NAME,
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
      title: APP_NAME,
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
  Menu.setApplicationMenu(buildMenu());
  registerIpc();

  let port;
  try {
    port = await server.start({ port: START_PORT, openBrowser: false });
  } catch (e) {
    dialog.showErrorBox(APP_NAME, '本地服务启动失败：\n' + ((e && e.message) || e));
    app.quit();
    return;
  }

  baseUrl = 'http://127.0.0.1:' + port + '/';
  createWindow();

  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
}

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId('com.mediareader.app');

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
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(bootstrap);

  app.on('window-all-closed', () => {
    app.quit();
  });
}

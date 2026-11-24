'use strict';

/**
 * 渲染进程与主进程之间的唯一通道。
 * 只暴露必要的方法，页面里通过 window.readerNative 使用。
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('readerNative', {
  isElectron: true,

  /**
   * 弹出原生文件夹选择框，返回选中的绝对路径；取消返回 null。
   * IPC 只能传结构化克隆支持的值：这里统一转成字符串，避免把 DOM 节点/
   * undefined 之类的东西递给主进程触发 “An object could not be cloned”。
   */
  pickFolder: (startDir) => ipcRenderer.invoke('reader:pick-folder', String(startDir || '')),

  /** 弹出原生文件选择框，返回选中的绝对路径；取消返回 null */
  pickFile: (startDir) => ipcRenderer.invoke('reader:pick-file', String(startDir || '')),

  /** 同步当前正在浏览的目录到主进程，作为下次原生文件/文件夹对话框的默认目录 */
  setCurrentRoot: (dir) => ipcRenderer.invoke('reader:set-current-root', String(dir || '')),

  /** 用系统默认程序打开外部链接 */
  openExternal: (url) => ipcRenderer.invoke('reader:open-external', String(url || '')),

  appInfo: () => ipcRenderer.invoke('reader:app-info'),

  /**
   * 菜单里「打开文件夹…」的订阅。返回取消订阅函数。
   */
  onOpenFolder: (cb) => {
    const handler = (_e, dir) => cb(dir);
    ipcRenderer.on('reader:open-folder', handler);
    return () => ipcRenderer.removeListener('reader:open-folder', handler);
  },

  /**
   * 启动参数里带的文件（双击 docx / 右键「打开方式」）。
   * 只返回一次，渲染进程启动时取走；之后的重启/刷新不再重复打开。
   */
  initialFile: () => ipcRenderer.invoke('reader:initial-file'),

  /**
   * 菜单「打开文件…」、第二个实例、文件关联都会走这里。返回取消订阅函数。
   */
  onOpenFile: (cb) => {
    const handler = (_e, filePath) => cb(filePath);
    ipcRenderer.on('reader:open-file', handler);
    return () => ipcRenderer.removeListener('reader:open-file', handler);
  },

  /**
   * 取拖入文件的真实路径。
   * Electron 32 起 File.path 已被移除，必须由主进程侧的 webUtils 转换，
   * 渲染进程自己是拿不到路径的。
   */
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch (_) {
      return '';
    }
  },
});

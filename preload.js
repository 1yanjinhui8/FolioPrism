'use strict';

/**
 * 渲染进程与主进程之间的唯一通道。
 * 只暴露必要的方法，页面里通过 window.readerNative 使用。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('readerNative', {
  isElectron: true,

  /**
   * 弹出原生文件夹选择框，返回选中的绝对路径；取消返回 null。
   * IPC 只能传结构化克隆支持的值：这里统一转成字符串，避免把 DOM 节点/
   * undefined 之类的东西递给主进程触发 “An object could not be cloned”。
   */
  pickFolder: (startDir) => ipcRenderer.invoke('reader:pick-folder', String(startDir || '')),

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
});

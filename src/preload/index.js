'use strict';

/**
 * 渲染进程与主进程之间的唯一通道。
 * 只暴露必要的方法，页面里通过 window.readerNative 使用。
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('readerNative', {
  isElectron: true,

  /** 弹出原生文件选择框，返回选中的绝对路径；取消返回 null */
  pickFile: (startDir) => ipcRenderer.invoke('reader:pick-file', String(startDir || '')),

  /** 同步当前文件所在目录到主进程，作为下次原生文件对话框的默认目录 */
  setCurrentRoot: (dir) => ipcRenderer.invoke('reader:set-current-root', String(dir || '')),

  /** 用系统默认程序打开外部链接 */
  openExternal: (url) => ipcRenderer.invoke('reader:open-external', String(url || '')),

  appInfo: () => ipcRenderer.invoke('reader:app-info'),

  /** 读取操作系统「文本大小」缩放比例（默认 1） */
  systemTextScale: () => ipcRenderer.invoke('reader:system-text-scale'),

  /**
   * 菜单「视图」里触发的阅读视图动作（字号/宽度/翻译设置）。返回取消订阅函数。
   */
  onViewAction: (cb) => {
    const handler = (_e, action) => cb(action);
    ipcRenderer.on('reader:view-action', handler);
    return () => ipcRenderer.removeListener('reader:view-action', handler);
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

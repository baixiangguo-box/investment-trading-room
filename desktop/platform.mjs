import path from 'node:path';

export const APP_NAME = '投资交易室';
export const APP_ID = 'org.investment.tradingroom';

// Preserve the original Windows ledger location; macOS avoids Documents/iCloud
// and its privacy prompt by using the application's own Application Support dir.
export function dataDirectory({ platform = process.platform, documents, appData, override } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (override !== undefined) {
    if (typeof override !== 'string' || !override || !paths.isAbsolute(override)) throw new Error('数据目录必须为绝对路径。');
    return paths.normalize(override);
  }
  const base = platform === 'win32' ? documents : appData;
  if (!base || !paths.isAbsolute(base)) throw new Error('无法定位系统提供的本地数据目录。');
  return paths.join(base, platform === 'win32' ? '投资交易室数据' : APP_ID);
}

export function macMenuTemplate(openWindow) {
  return [
    { label: APP_NAME, submenu: [
      { role: 'about', label: `关于${APP_NAME}` }, { type: 'separator' },
      { role: 'services', label: '服务' }, { type: 'separator' },
      { role: 'hide', label: `隐藏${APP_NAME}` }, { role: 'hideOthers', label: '隐藏其他' },
      { role: 'unhide', label: '显示全部' }, { type: 'separator' },
      { role: 'quit', label: `退出${APP_NAME}`, accelerator: 'Command+Q' },
    ] },
    { label: '文件', submenu: [
      { label: '打开主窗口', accelerator: 'Command+N', click: openWindow },
      { role: 'close', label: '关闭窗口', accelerator: 'Command+W' },
    ] },
    { label: '编辑', submenu: [
      { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' },
      { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' },
      { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' },
    ] },
    { label: '显示', submenu: [
      { role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大' },
      { role: 'zoomOut', label: '缩小' }, { type: 'separator' }, { role: 'togglefullscreen', label: '全屏' },
    ] },
    { label: '窗口', role: 'windowMenu', submenu: [
      { role: 'minimize', label: '最小化' }, { role: 'zoom', label: '缩放' },
      { type: 'separator' }, { role: 'front', label: '全部置于前台' },
    ] },
  ];
}

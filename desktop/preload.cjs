'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const methods = ['bootstrap','marketOverview','marketList','quotes','history','account','setup','watch','adjustCapital','submit','cancel','order','diagnostics','backup','listBackups','previewBackup','previewRestore','restore','reset','status'];
// Plain envelopes cross contextBridge intact; Error custom fields do not.
// The renderer constructs its Error after unwrapping this transport.
const api = { transportVersion: 1 };
for (const method of methods) {
  api[method] = async (payload) => {
    return ipcRenderer.invoke('trading:' + method, payload);
  };
}
api.onUpdate = (callback) => {
  if (typeof callback !== 'function') return () => {};
  const listener = () => callback();
  ipcRenderer.on('trading:updated', listener);
  return () => ipcRenderer.removeListener('trading:updated', listener);
};
contextBridge.exposeInMainWorld('trading', Object.freeze(api));

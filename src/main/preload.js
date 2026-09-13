const { contextBridge, ipcRenderer, webUtils } = require('electron');

const subscribe = (channel) => (callback) => {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('pitchlens', {
  platform: process.platform,
  engineStatus: () => ipcRenderer.invoke('engines:status'),
  retryEngines: () => ipcRenderer.invoke('engines:retry'),
  onEngineState: subscribe('engines:state'),

  pickAudio: () => ipcRenderer.invoke('dialog:openAudio'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  listSamples: () => ipcRenderer.invoke('samples:list'),
  fileUrl: (filePath) => ipcRenderer.invoke('file:url', filePath),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  reveal: (filePath) => ipcRenderer.invoke('file:reveal', filePath),
  exportPdf: (id) => ipcRenderer.invoke('report:exportPdf', id),

  analyze: (jobId, filePath) => ipcRenderer.invoke('analyze:start', { jobId, filePath }),
  cancel: (jobId) => ipcRenderer.invoke('analyze:cancel', jobId),
  onProgress: subscribe('analyze:progress'),

  history: {
    list: () => ipcRenderer.invoke('history:list'),
    get: (id) => ipcRenderer.invoke('history:get', id),
    remove: (id) => ipcRenderer.invoke('history:delete', id),
  },
});

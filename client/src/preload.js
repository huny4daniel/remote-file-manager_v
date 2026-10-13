const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (cb) => {
  const fn = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};

contextBridge.exposeInMainWorld('rd', {
  api: (method, path, opts) => ipcRenderer.invoke('api', method, path, opts),
  connection: {
    get: () => ipcRenderer.invoke('connection:get'),
    connect: (input) => ipcRenderer.invoke('connection:connect', input),
    info: () => ipcRenderer.invoke('connection:info'),
  },
  wirewol: {
    pick: () => ipcRenderer.invoke('wirewol:pick'),
    check: (file) => ipcRenderer.invoke('wirewol:check', file),
    import: (file, password) => ipcRenderer.invoke('wirewol:import', file, password),
  },
  wol: {
    available: (server) => ipcRenderer.invoke('wol:available', server),
    wake: (server) => ipcRenderer.invoke('wol:wake', server),
  },
  icon: (key, size) => ipcRenderer.invoke('icon', key, size),
  openFile: (remotePath) => ipcRenderer.invoke('file:open', remotePath),
  uploadPaths: (localPaths, remoteDir) => ipcRenderer.invoke('upload:paths', localPaths, remoteDir),
  downloadEntries: (entries) => ipcRenderer.invoke('download:paths', entries),
  clipboardFiles: () => ipcRenderer.invoke('clipboard:files'),
  readText: () => ipcRenderer.invoke('clipboard:readText'),
  writeText: (text) => ipcRenderer.invoke('clipboard:writeText', text),
  clipboardHasImage:() => ipcRenderer.invoke('clipboard:hasImage'),
  askConflict: (names) => ipcRenderer.invoke('ask:conflict', names),
  menu: (template) => ipcRenderer.invoke('menu:popup', template),
  message: (opts) => ipcRenderer.invoke('dialog:message', opts),
  openTerminal: (opts) => ipcRenderer.invoke('terminal:open', opts),
  attachedTerminals: () => ipcRenderer.invoke('terminal:attached'),
  stageForTerminal: (payload) => ipcRenderer.invoke('terminal:stage', payload),
  newWindow: (startPath) => ipcRenderer.invoke('window:new', startPath),
  setTitle: (t) => ipcRenderer.invoke('window:title', t),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onToast: on('toast'),
  onProgress: on('progress'),
  onFsChanged: on('fs:changed'),
});

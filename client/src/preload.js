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
  pcs: {
    list: () => ipcRenderer.invoke('pcs:list'),
    status: (id) => ipcRenderer.invoke('pcs:status', id),
    rename: (id, name) => ipcRenderer.invoke('pcs:rename', id, name),
    remove: (id) => ipcRenderer.invoke('pcs:remove', id),
    wake: (id) => ipcRenderer.invoke('pcs:wake', id),
    shutdown: (id, delaySeconds) => ipcRenderer.invoke('pcs:shutdown', id, delaySeconds),
    cancelShutdown: (id) => ipcRenderer.invoke('pcs:cancelShutdown', id),
    current: () => ipcRenderer.invoke('pcs:current'),
    getPairing: (id) => ipcRenderer.invoke('pcs:getPairing', id),
    setPairing: (id, v) => ipcRenderer.invoke('pcs:setPairing', id, v),
  },
  tunnel: {
    get: () => ipcRenderer.invoke('tunnel:get'),
    ensure: () => ipcRenderer.invoke('tunnel:ensure'),
    install: () => ipcRenderer.invoke('tunnel:install'),
  },
  ww: {
    get: () => ipcRenderer.invoke('ww:get'),
    importConf: () => ipcRenderer.invoke('ww:importConf'),
    clearConf: () => ipcRenderer.invoke('ww:clearConf'),
    setRouter: (r) => ipcRenderer.invoke('ww:setRouter', r),
    clearRouter: () => ipcRenderer.invoke('ww:clearRouter'),
  },
  history: {
    push: (op) => ipcRenderer.invoke('history:push', op),
    take: (which) => ipcRenderer.invoke('history:take', which),
    put: (which, op) => ipcRenderer.invoke('history:put', which, op),
    peek: () => ipcRenderer.invoke('history:peek'),
  },
  wirewol: {
    pick: () => ipcRenderer.invoke('wirewol:pick'),
    check: (file) => ipcRenderer.invoke('wirewol:check', file),
    import: (file, password) => ipcRenderer.invoke('wirewol:import', file, password),
    export: (pcId, password) => ipcRenderer.invoke('wirewol:export', pcId, password),
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
  onTunnel: on('tunnel:state'),
});

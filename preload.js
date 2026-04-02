const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  auth: {
    getStatus: () => ipcRenderer.invoke('auth:getStatus'),
    login: (token) => ipcRenderer.invoke('auth:login', token),
    startDeviceFlow: () => ipcRenderer.invoke('auth:startDeviceFlow'),
    pollDeviceFlow: (deviceCode, interval) => ipcRenderer.invoke('auth:pollDeviceFlow', { deviceCode, interval }),
    cancelDeviceFlow: () => ipcRenderer.invoke('auth:cancelDeviceFlow'),
    logout: () => ipcRenderer.invoke('auth:logout'),
  },
  chat: {
    send: (payload) => ipcRenderer.invoke('chat:send', payload),
    abort: () => ipcRenderer.invoke('chat:abort'),
  },
  onChatProgress: (cb) => {
    ipcRenderer.on('chat:progress', (_event, data) => cb(data));
  },
  onChatChunk: (cb) => {
    ipcRenderer.on('chat:chunk', (_event, chunk) => cb(chunk));
  },
  history: {
    list: () => ipcRenderer.invoke('history:list'),
    load: (chatId) => ipcRenderer.invoke('history:load', chatId),
    save: (chat) => ipcRenderer.invoke('history:save', chat),
    delete: (chatId) => ipcRenderer.invoke('history:delete', chatId),
    rename: (chatId, title) => ipcRenderer.invoke('history:rename', { chatId, title }),
  },
  dialog: {
    openFiles: () => ipcRenderer.invoke('dialog:openFiles'),
  },
  file: {
    read: (filePath) => ipcRenderer.invoke('file:read', filePath),
  },
  image: {
    compress: (dataUrl) => ipcRenderer.invoke('image:compress', dataUrl),
  },
  mcp: {
    getStatus: () => ipcRenderer.invoke('mcp:getStatus'),
    reconnect: () => ipcRenderer.invoke('mcp:reconnect'),
    toggleServer: (serverName, enabled) => ipcRenderer.invoke('mcp:toggleServer', { serverName, enabled }),
    getConfig: () => ipcRenderer.invoke('mcp:getConfig'),
    saveConfig: (config) => ipcRenderer.invoke('mcp:saveConfig', config),
  },
  settings: {
    getModel: () => ipcRenderer.invoke('settings:getModel'),
    setModel: (m) => ipcRenderer.invoke('settings:setModel', m),
    getEndpoint: () => ipcRenderer.invoke('settings:getEndpoint'),
    setEndpoint: (e) => ipcRenderer.invoke('settings:setEndpoint', e),
    getMode: () => ipcRenderer.invoke('settings:getMode'),
    setMode: (m) => ipcRenderer.invoke('settings:setMode', m),
    getCopilotModels: () => ipcRenderer.invoke('settings:getCopilotModels'),
    getCustomApiKey: () => ipcRenderer.invoke('settings:getCustomApiKey'),
    setCustomApiKey: (key) => ipcRenderer.invoke('settings:setCustomApiKey', key),
    getCustomAuthType: () => ipcRenderer.invoke('settings:getCustomAuthType'),
    setCustomAuthType: (type) => ipcRenderer.invoke('settings:setCustomAuthType', type),
    getEntraTenantId: () => ipcRenderer.invoke('settings:getEntraTenantId'),
    setEntraTenantId: (id) => ipcRenderer.invoke('settings:setEntraTenantId', id),
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  },
  onMcpStatus: (cb) => {
    ipcRenderer.on('mcp:status', (_event, status) => cb(status));
  },
  onAzureDeviceCode: (cb) => {
    ipcRenderer.on('azure:deviceCode', (_event, info) => cb(info));
  },
  onEntraDeviceCode: (cb) => {
    ipcRenderer.on('entra:deviceCode', (_event, info) => cb(info));
  },
});

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (partial) => ipcRenderer.invoke('config:set', partial),
  savePdf: (bytes, filename) => ipcRenderer.invoke('pdf:save', { bytes, filename }),
  savePdfLote: (bytes, filename, subcarpeta) => ipcRenderer.invoke('pdf:save-lote', { bytes, filename, subcarpeta }),
  revealPdf: (fullPath) => ipcRenderer.invoke('pdf:reveal', fullPath),
  openPdf: (fullPath) => ipcRenderer.invoke('pdf:open', fullPath),
  pdfExists: (fullPath) => ipcRenderer.invoke('pdf:exists', fullPath),
  getRecibosDir: () => ipcRenderer.invoke('recibos:dir'),
  chooseRecibosDir: () => ipcRenderer.invoke('recibos:choose-dir'),
  openWhatsApp: (tel, texto) => ipcRenderer.invoke('wa:open', { tel, texto }),
  saveCsv: (content, suggestedName) => ipcRenderer.invoke('csv:save', { content, suggestedName }),
  saveBackup: (json) => ipcRenderer.invoke('backup:save', json),
  getLogo: () => ipcRenderer.invoke('logo:get'),
  getActualizacionPendiente: () => ipcRenderer.invoke('actualizacion:pendiente'),
  onActualizacionLista: (cb) => ipcRenderer.on('actualizacion:lista', (_e, version) => cb(version)),
  instalarActualizacion: () => ipcRenderer.send('actualizacion:instalar'),
  comprobarActualizacionesAhora: () => ipcRenderer.send('actualizacion:comprobar-ahora'),
  restartApp: () => ipcRenderer.send('app:restart')
});

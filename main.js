const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

let win;

// Comprueba versiones nuevas en segundo plano, sin preguntar nada: si hay una,
// se descarga sola y se instala en el próximo cierre normal de la app.
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
function comprobarActualizaciones() {
  autoUpdater.checkForUpdates().catch(() => { /* sin conexión: se reintenta la próxima vez */ });
}

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

// La conexión por defecto viene en config.defaults.json (junto a la app);
// lo guardado por el usuario en userData tiene prioridad.
function readConfig() {
  let defaults = {};
  let user = {};
  try {
    defaults = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.defaults.json'), 'utf8'));
  } catch { /* sin defaults */ }
  try {
    user = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch { /* sin config de usuario */ }
  return { ...defaults, ...user };
}

function writeConfig(cfg) {
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf8');
}

function recibosDir() {
  const cfg = readConfig();
  const dir = cfg.recibosDir || path.join(app.getPath('documents'), 'Curiosamente', 'Recibos');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: `Curiosamente — Gestión de la academia (v${app.getVersion()})`,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  // Sin esto, el <title> de index.html sobrescribe el título de la ventana
  // en cuanto carga la página, y la versión desaparece de la barra.
  win.on('page-title-updated', (event) => event.preventDefault());
  win.loadFile(path.join(__dirname, 'app', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  comprobarActualizaciones();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---- IPC ----

ipcMain.handle('config:get', () => readConfig());

ipcMain.handle('config:set', (_e, partial) => {
  const cfg = { ...readConfig(), ...partial };
  writeConfig(cfg);
  return cfg;
});

// Guarda el PDF del recibo en la carpeta de recibos y devuelve la ruta.
ipcMain.handle('pdf:save', (_e, { bytes, filename }) => {
  const dir = recibosDir();
  const safe = filename.replace(/[\\/:*?"<>|]/g, '_');
  const fullPath = path.join(dir, safe);
  fs.writeFileSync(fullPath, Buffer.from(bytes));
  return fullPath;
});

// Guarda el PDF dentro de una subcarpeta del mes (ej. "Julio 2026 recibos academia").
ipcMain.handle('pdf:save-lote', (_e, { bytes, filename, subcarpeta }) => {
  const dir = path.join(recibosDir(), String(subcarpeta).replace(/[\\/:*?"<>|]/g, '_'));
  fs.mkdirSync(dir, { recursive: true });
  const fullPath = path.join(dir, filename.replace(/[\\/:*?"<>|]/g, '_'));
  fs.writeFileSync(fullPath, Buffer.from(bytes));
  return fullPath;
});

ipcMain.handle('pdf:reveal', (_e, fullPath) => {
  if (fs.existsSync(fullPath)) shell.showItemInFolder(fullPath);
  else shell.openPath(recibosDir());
});

// Devuelve false si el archivo ya no existe (el renderer lo regenera entonces).
ipcMain.handle('pdf:open', (_e, fullPath) => {
  if (fullPath && fs.existsSync(fullPath)) {
    shell.openPath(fullPath);
    return true;
  }
  return false;
});

// Copia de seguridad local diaria (JSON con alumnos y recibos). Conserva las 30 últimas.
ipcMain.handle('backup:save', (_e, json) => {
  const dir = path.join(app.getPath('documents'), 'Curiosamente', 'Backups');
  fs.mkdirSync(dir, { recursive: true });
  const hoy = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(dir, `backup_${hoy}.json`), json, 'utf8');
  const backups = fs.readdirSync(dir).filter(f => /^backup_.*\.json$/.test(f)).sort();
  for (const viejo of backups.slice(0, -30)) fs.unlinkSync(path.join(dir, viejo));
  return path.join(dir, `backup_${hoy}.json`);
});

ipcMain.handle('pdf:exists', (_e, fullPath) => Boolean(fullPath && fs.existsSync(fullPath)));

ipcMain.handle('recibos:dir', () => recibosDir());

ipcMain.handle('recibos:choose-dir', async () => {
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  if (res.canceled || !res.filePaths.length) return null;
  const cfg = readConfig();
  cfg.recibosDir = res.filePaths[0];
  writeConfig(cfg);
  return cfg.recibosDir;
});

// Abre el chat de WhatsApp del alumno/tutor: directamente en la app de
// escritorio si está instalada (protocolo whatsapp://), o en wa.me si no.
ipcMain.handle('wa:open', (_e, { tel, texto }) => {
  const numero = String(tel || '').replace(/\D/g, '');
  if (!numero) return false;
  const mensaje = encodeURIComponent(String(texto || ''));
  const tieneApp = Boolean(app.getApplicationNameForProtocol('whatsapp://send'));
  const url = tieneApp
    ? `whatsapp://send?phone=${numero}&text=${mensaje}`
    : `https://wa.me/${numero}?text=${mensaje}`;
  shell.openExternal(url);
  return tieneApp;
});

ipcMain.handle('csv:save', async (_e, { content, suggestedName }) => {
  const res = await dialog.showSaveDialog(win, {
    defaultPath: suggestedName,
    filters: [{ name: 'CSV', extensions: ['csv'] }]
  });
  if (res.canceled || !res.filePath) return null;
  // BOM para que Excel abra el UTF-8 con acentos correctamente
  fs.writeFileSync(res.filePath, '﻿' + content, 'utf8');
  return res.filePath;
});

// Si existe assets/logo.png (logo real de la academia), se usa en el PDF.
ipcMain.handle('logo:get', () => {
  const p = path.join(__dirname, 'assets', 'logo.png');
  try {
    return fs.readFileSync(p).toString('base64');
  } catch {
    return null;
  }
});

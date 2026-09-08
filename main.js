const { app, BrowserWindow, ipcMain, shell, dialog, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

let win;

// Comprueba versiones nuevas en segundo plano, sin preguntar nada: si hay una,
// se descarga sola. Cuando ya está lista, se avisa a la ventana con una
// pantalla completa (en vez de esperar en silencio al próximo cierre) para
// que quien esté usando la app sepa que tiene que actualizar.
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
// electron-updater no imprime nada por su cuenta salvo que se le dé un
// logger — sin esto, una comprobación (falle o no) es completamente muda en
// consola, lo que hace imposible diagnosticar por qué no salta un aviso.
autoUpdater.logger = console;
// La descarga sigue en segundo plano después de comprobar, y si falla ahí
// (sin conexión, o en Mac sin firmar, donde la auto-actualización no está
// permitida) el aviso llega por este evento y no por la promesa de abajo.
// Sin este oyente, ese error tumbaría la app: se ignora a propósito, la
// actualización se reintenta sola la próxima vez que se abra. Se deja
// constancia en consola (con el logger de arriba ya se vería igual, pero
// así queda explícito que se ignora adrede y no por un descuido).
autoUpdater.on('error', (err) => console.error('[actualizador] error ignorado a propósito:', err?.message || err));

// Guardada aquí (no solo enviada por evento) por si la descarga termina antes
// de que la ventana haya cargado del todo y monte su oyente: el renderer la
// pregunta también al arrancar, con `actualizacion:pendiente`.
let actualizacionLista = null;
// En Mac, una segunda descarga de actualización dentro del mismo proceso ya
// arrancado no la aplica bien Squirrel.Mac (el componente nativo de Apple
// que usa electron-updater ahí) — solo funciona fiable la primera vez que
// arranca el proceso. Con varias versiones publicadas seguidas y la app
// abierta todo el rato (como en las pruebas de hoy), la segunda o tercera
// descarga en la misma sesión se quedaría a medio aplicar. Por eso, a partir
// de la segunda, se avisa al renderer para que reinicie la app sola en vez
// de ofrecer el botón de "Actualizar": el proceso nuevo vuelve a contar como
// "primera vez" y esa sí se aplica bien cuando se pulse Actualizar.
let primerAvisoEnEstaSesion = true;
autoUpdater.on('update-downloaded', (info) => {
  const necesitaReinicioLimpio = process.platform === 'darwin' && !primerAvisoEnEstaSesion;
  primerAvisoEnEstaSesion = false;
  actualizacionLista = info.version;
  if (win && !win.isDestroyed()) win.webContents.send('actualizacion:lista', info.version, necesitaReinicioLimpio);
});

function comprobarActualizaciones() {
  console.log('[actualizador] comprobando… versión actual:', app.getVersion());
  autoUpdater.checkForUpdates().catch((err) => console.error('[actualizador] fallo al comprobar (sin conexión, o Mac sin firmar):', err?.message || err));
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

// "Recordar sesión en este ordenador": guarda el email tal cual, y la
// contraseña cifrada con safeStorage (ligada a la cuenta de Windows/macOS de
// quien la guardó — nadie puede leerla ni copiando el archivo a otro
// ordenador ni entrando con otro usuario del sistema). Aparte de
// config.json a propósito, para no mezclar un dato sensible con ajustes
// normales que no lo son.
function credencialesPath() {
  return path.join(app.getPath('userData'), 'credenciales.json');
}

function guardarCredenciales(email, password) {
  if (!safeStorage.isEncryptionAvailable()) return false;
  const cifrada = safeStorage.encryptString(password).toString('base64');
  fs.writeFileSync(credencialesPath(), JSON.stringify({ email, password: cifrada }), 'utf8');
  return true;
}

function cargarCredenciales() {
  try {
    const { email, password } = JSON.parse(fs.readFileSync(credencialesPath(), 'utf8'));
    if (!email || !password) return null;
    return { email, password: safeStorage.decryptString(Buffer.from(password, 'base64')) };
  } catch {
    return null; // sin credenciales guardadas, o no se pudieron descifrar (ej. otro usuario del sistema)
  }
}

function borrarCredenciales() {
  try { fs.unlinkSync(credencialesPath()); } catch { /* ya no había nada que borrar */ }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: `Curiosamente — Gestión de la academia (v${app.getVersion()})`,
    // .ico es un formato de Windows — en Mac (y Linux) hay que darle el .png,
    // si no el icono de la ventana no carga bien.
    icon: path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
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

ipcMain.handle('credenciales:guardar', (_e, { email, password }) => guardarCredenciales(email, password));
ipcMain.handle('credenciales:cargar', () => cargarCredenciales());
ipcMain.handle('credenciales:borrar', () => { borrarCredenciales(); });

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

ipcMain.handle('actualizacion:pendiente', () => actualizacionLista);
ipcMain.on('actualizacion:instalar', () => autoUpdater.quitAndInstall());
// Aviso instantáneo por Supabase Realtime (tabla app_version): en vez de
// esperar a la próxima apertura, se relanza la comprobación ya mismo.
ipcMain.on('actualizacion:comprobar-ahora', () => {
  // Dos motivos posibles para este aviso: un cambio en tiempo real en la
  // tabla app_version, o un inicio de sesión (por si hubo una versión
  // nueva mientras la sesión estaba cerrada). El registro de más abajo ya
  // dice qué versión hay, así que no hace falta distinguir el motivo aquí.
  console.log('[actualizador] comprobación forzada (tiempo real o login)');
  comprobarActualizaciones();
});
// Reinicio completo del proceso: se usa cuando a alguien le cambian los
// permisos de administrador mientras tiene la app abierta, para que arranque
// limpia con los permisos nuevos en vez de dejar la sesión a medias.
ipcMain.on('app:restart', () => {
  app.relaunch();
  app.exit(0);
});

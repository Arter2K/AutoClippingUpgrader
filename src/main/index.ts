import { app, BrowserWindow, dialog, ipcMain, protocol } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeMedia } from './engine/probe';
import { registerPublishing } from './services/publishing-hub';
import { registerEditor } from './editor/handlers';
import { attachDraftClose } from './editor/window-lifecycle';
import { configurePackagedTools } from './engine/tool-paths';

const dataDirectory = app.commandLine.getSwitchValue('user-data-dir');
if (dataDirectory) app.setPath('userData', path.resolve(dataDirectory));

protocol.registerSchemesAsPrivileged([{ scheme: 'acu-media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } }]);

const here = path.dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;

async function createWindow() {
  const win = new BrowserWindow({ width: 1520, height: 980, minWidth: 1180, minHeight: 760,
    show: !app.commandLine.hasSwitch('hidden'),
    icon: path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), app.isPackaged ? 'icon.png' : 'build/icon.png'),
    backgroundColor: '#09090b', title: 'AutoClippingUpgrader',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: !app.commandLine.hasSwitch('hidden') },
  });
  mainWindow = win;
  attachDraftClose(win);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.on('closed', () => { mainWindow = null; });
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) await win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await win.loadFile(path.join(here, '../dist/index.html'));
}

app.whenReady().then(async () => {
  app.setAppUserModelId('com.autoclippingupgrader.desktop');
  await configurePackagedTools(app.isPackaged, process.resourcesPath);
  const publishing = registerPublishing(() => mainWindow);
  await registerEditor(() => mainWindow, publishing);
  ipcMain.handle('media:select', async event => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame)
      throw new Error('Untrusted IPC sender');
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'],
      filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi'] }] });
    const file = result.filePaths[0];
    if (result.canceled || !file) return null;
    return { path: file, media: await probeMedia(file) };
  });
  await createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
}).catch(error => { console.error(error); app.quit(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

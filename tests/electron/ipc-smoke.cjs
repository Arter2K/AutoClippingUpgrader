const { app, BrowserWindow, safeStorage, protocol } = require('electron');
require('tsx/cjs');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const path = require('node:path');
const { EncryptedTokenVault } = require('../../src/main/services/auth/token-vault.ts');
const { registerPublishing } = require('../../src/main/services/publishing-hub.ts');
const { registerEditor } = require('../../src/main/editor/handlers.ts');
protocol.registerSchemesAsPrivileged([{ scheme: 'acu-media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } }]);
app.on('before-quit', event => event.preventDefault());

app.whenReady().then(async () => {
  const dir = process.env.ACU_EDITOR_TEST_DIR ?? await mkdtemp(path.join(app.getPath('temp'), 'acu-ipc-test-'));
  app.setPath('userData', dir);
  process.env.TIKTOK_CLIENT_KEY = 'ipc-test-client';
  process.env.TIKTOK_CLIENT_SECRET = 'ipc-test-secret';
  process.env.GOOGLE_CLIENT_ID = 'ipc-test-google';
  let trusted, untrusted, editor;
  try {
    const vault = new EncryptedTokenVault(path.join(dir, 'oauth-tokens.bin'), safeStorage);
    await vault.set('tiktok', { clientId: 'ipc-test-client', accessToken: 'never-expose-this-access-token',
      refreshToken: 'never-expose-this-refresh-token', expiresAt: Date.now() + 3600000, scopes: ['video.upload'] });
    const publishing = registerPublishing(() => trusted ?? null);
    editor = await registerEditor(() => trusted ?? null, publishing);
    const options = { show: false, webPreferences: { preload: path.resolve('dist-electron/preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false } };
    trusted = new BrowserWindow(options);
    await trusted.loadFile(path.resolve('dist/index.html'));
    const state = await trusted.webContents.executeJavaScript('window.desktop.publishing.state()');
    assert.equal(state.tiktok.connected, true);
    assert.equal(state.tiktok.configured, true);
    assert.equal(JSON.stringify(state).includes('never-expose'), false);
    assert.equal(await trusted.webContents.executeJavaScript('typeof window.require'), 'undefined');
    untrusted = new BrowserWindow(options);
    await untrusted.loadFile(path.resolve('dist/index.html'));
    await assert.rejects(() => untrusted.webContents.executeJavaScript('window.desktop.publishing.state()'), /Untrusted IPC sender/);
    await assert.rejects(() => untrusted.webContents.executeJavaScript('window.desktop.editor.jobs()'), /Untrusted IPC sender/);
    console.log('PASS: built renderer/preload load, tokens stay in main, foreign webContents IPC is rejected');
  } finally {
    editor?.shutdown(); untrusted?.destroy(); trusted?.destroy();
    if (!process.env.ACU_EDITOR_TEST_DIR) await rm(dir, { recursive: true, force: true });
  }
}).then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });

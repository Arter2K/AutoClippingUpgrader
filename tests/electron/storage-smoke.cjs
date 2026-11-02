const { app, safeStorage } = require('electron');
require('tsx/cjs');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const path = require('node:path');
const { EncryptedTokenVault } = require('../../src/main/services/auth/token-vault.ts');
const { EncryptedResumeStore } = require('../../src/main/services/google-drive/resume-store.ts');

app.whenReady().then(async () => {
  const dir = process.env.ACU_EDITOR_TEST_DIR ?? await mkdtemp(path.join(app.getPath('temp'), 'acu-electron-storage-'));
  try {
    assert.equal(safeStorage.isEncryptionAvailable(), true, 'OS-backed encryption is required');
    const file = path.join(dir, 'tokens.bin');
    const vault = new EncryptedTokenVault(file, safeStorage);
    const token = { clientId: 'test-client', accessToken: 'electron-test-access', refreshToken: 'electron-test-refresh',
      expiresAt: Date.now() + 3600000, scopes: ['test'] };
    await vault.set('google', token);
    assert.equal((await new EncryptedTokenVault(file, safeStorage).get('google')).accessToken, token.accessToken);
    assert.equal((await readFile(file)).includes(Buffer.from(token.accessToken)), false);
    const resume = new EncryptedResumeStore(path.join(dir, 'resume'), safeStorage);
    const checkpoint = { url: 'https://www.googleapis.com/upload?upload_id=test-only', filePath: 'test.mp4', size: 100,
      mtimeMs: 1, folderId: 'folder', ownerId: 'owner', createdAt: Date.now() };
    await resume.set('a'.repeat(64), checkpoint);
    assert.deepEqual(await resume.get('a'.repeat(64)), checkpoint);
    await resume.remove('a'.repeat(64)); assert.equal(await resume.get('a'.repeat(64)), null);
    await vault.remove('google'); assert.equal(await vault.get('google'), null);
    console.log('PASS: Electron safeStorage, encrypted token vault and resumable checkpoint round-trip');
  } finally { if (!process.env.ACU_EDITOR_TEST_DIR) await rm(dir, { recursive: true, force: true }); }
}).then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });

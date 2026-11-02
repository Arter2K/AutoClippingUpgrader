import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { stat, mkdir, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron';
import { z } from 'zod';
import { probeMedia } from '../engine/probe';
import { tiktokJobSchema, type Provider, type ServiceEvent, type PublishingState } from '../../shared/publishing';
import { EncryptedTokenVault } from './auth/token-vault';
import { TikTokOAuth } from './tiktok/oauth';
import { TikTokPublishing } from './tiktok/publishing';
import { TikTokAuthorization } from './auth/oauth-window';
import { GoogleOAuth } from './google-drive/oauth';
import { GoogleAuthorization } from './auth/google-authorization';
import { DriveFolders } from './google-drive/folders';
import { DriveUpload } from './google-drive/resumable-upload';
import { EncryptedResumeStore } from './google-drive/resume-store';
import { loadPublishingConfig, publishingConfigPath } from './config';
import { safeMessage } from './http';

export function registerPublishing(owner: () => BrowserWindow | null) {
  const config = loadPublishingConfig();
  const root = app.getPath('userData');
  const vault = new EncryptedTokenVault(path.join(root, 'oauth-tokens.bin'), safeStorage);
  const emit = (event: ServiceEvent) => { const win = owner(); if (win && !win.isDestroyed()) win.webContents.send('publishing:event', event); };
  const authResult = (provider: Provider) => (error?: unknown) => emit({ kind: 'auth', provider, id: provider,
    phase: error ? (error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'error') : 'complete',
    ...(error ? { message: safeMessage(error) } : {}) });
  const tiktok = config.tiktok ? new TikTokOAuth(config.tiktok.clientKey, config.tiktok.clientSecret, vault) : null;
  const google = config.google ? new GoogleOAuth(config.google.clientId, config.google.clientSecret, config.google.scopes, vault) : null;
  const tikAuth = tiktok ? new TikTokAuthorization(tiktok, owner, authResult('tiktok')) : null;
  const googleAuth = google ? new GoogleAuthorization(google, authResult('google')) : null;
  const tikPosts = tiktok ? new TikTokPublishing(tiktok) : null;
  const driveFolders = google ? new DriveFolders(google) : null;
  const driveUpload = google ? new DriveUpload(google, new EncryptedResumeStore(path.join(root, 'drive-resume'), safeStorage)) : null;
  const selected = new Map<string, { path: string; size: number; mtimeMs: number }>();
  const jobs = new Map<string, { controller: AbortController; provider: Provider; fileId: string }>();
  const requireService = <T>(service: T | null): T => { if (!service) throw new Error('OAuth credentials are not configured'); return service; };
  const resolveFile = async (id: string) => {
    const file = selected.get(z.string().uuid().parse(id));
    if (!file) throw new Error('Select an upload file in this app first');
    const current = await stat(file.path);
    if (current.size !== file.size || current.mtimeMs !== file.mtimeMs) throw new Error('Selected file changed; select it again');
    return file.path;
  };
  const handle = (name: string, action: (...args: unknown[]) => Promise<unknown>) => {
    ipcMain.handle(`publishing:${name}`, async (event, ...args: unknown[]) => {
      const win = owner();
      if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('Untrusted IPC sender');
      try { return await action(...args); }
      catch (error) { throw new Error(safeMessage(error)); }
    });
  };
  const startJob = (provider: Provider, fileId: string, task: (id: string, signal: AbortSignal) => Promise<ServiceEvent['result']>) => {
    if ([...jobs.values()].some(job => job.provider === provider && job.fileId === fileId)) throw new Error('Upload already in progress');
    if (jobs.size >= 4) throw new Error('Too many upload jobs');
    const id = randomUUID(), controller = new AbortController(); jobs.set(id, { provider, controller, fileId });
    emit({ kind: 'job', provider, id, phase: 'running' });
    void task(id, controller.signal).then(result => emit({ kind: 'job', provider, id, phase: 'complete', result }))
      .catch(error => emit({ kind: 'job', provider, id, phase: controller.signal.aborted ? 'cancelled' : 'error', message: safeMessage(error) }))
      .finally(() => jobs.delete(id));
    return id;
  };
  handle('state', async (): Promise<PublishingState> => ({
    configurationPath: publishingConfigPath(),
    tiktok: { configured: !!tiktok, ...(await tiktok?.account() ?? { connected: false, scopes: [] }) },
    google: { configured: !!google, ...(await google?.account() ?? { connected: false, scopes: [] }) },
  }));
  handle('config-folder', async () => {
    const file = publishingConfigPath(), directory = path.dirname(file);
    await mkdir(directory, { recursive: true });
    const example = app.isPackaged ? path.join(process.resourcesPath, 'oauth.env.example') : path.resolve('.env.example');
    try { await copyFile(example, file, constants.COPYFILE_EXCL); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const error = await shell.openPath(directory); if (error) throw new Error('Cannot open configuration folder');
  });
  handle('tiktok-connect', async mode => requireService(tikAuth).begin(z.enum(['window', 'external']).parse(mode)));
  handle('tiktok-complete', async url => requireService(tikAuth).complete(z.string().max(10000).parse(url)));
  handle('google-connect', async () => requireService(googleAuth).begin());
  handle('auth-cancel', async provider => { if (z.enum(['tiktok', 'google']).parse(provider) === 'tiktok') tikAuth?.cancel(); else googleAuth?.cancel(); });
  handle('disconnect', async provider => {
    const p = z.enum(['tiktok', 'google']).parse(provider);
    for (const job of jobs.values()) if (job.provider === p) job.controller.abort();
    if (p === 'tiktok') { tikAuth?.cancel(); await requireService(tiktok).disconnect(); }
    else { googleAuth?.cancel(); await requireService(google).disconnect(); }
  });
  handle('creator', async () => requireService(tikPosts).creatorInfo());
  handle('select-file', async () => {
    const win = owner(); if (!win) throw new Error('No window');
    const result = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'MP4 video', extensions: ['mp4'] }] });
    const filePath = result.filePaths[0]; if (result.canceled || !filePath) return null;
    const file = await stat(filePath), media = await probeMedia(filePath);
    const id = randomUUID();
    if (selected.size >= 100) { const first = selected.keys().next().value; if (first) selected.delete(first); }
    selected.set(id, { path: filePath, size: file.size, mtimeMs: file.mtimeMs });
    return { id, name: path.basename(filePath), size: file.size, durationSec: media.durationSec };
  });
  handle('tiktok-start', async value => {
    const job = tiktokJobSchema.parse(value), filePath = await resolveFile(job.fileId), posts = requireService(tikPosts);
    return startJob('tiktok', job.fileId, async (id, signal) => {
      const { publishId } = await posts.upload({ filePath, mode: job.mode, consent: true, ...(job.mode === 'direct_post' ? { postInfo: job.postInfo } : {}) }, {
        signal, onInitialized: publishId => emit({ kind: 'job', provider: 'tiktok', id, phase: 'progress', result: { publishId } }),
        onProgress: progress => emit({ kind: 'job', provider: 'tiktok', id, phase: 'progress', progress }),
      });
      const status = await posts.waitForStatus(publishId, job.mode, { signal,
        onStatus: value => emit({ kind: 'job', provider: 'tiktok', id, phase: 'progress', result: { publishId, status: value.status } }) });
      return { publishId, status: status.status };
    });
  });
  handle('tiktok-status', async id => requireService(tikPosts).status(z.string().min(1).max(512).parse(id)));
  handle('drive-folders', async token => requireService(driveFolders).list(z.string().max(2048).optional().parse(token)));
  handle('drive-folder-create', async name => requireService(driveFolders).create(z.string().min(1).max(200).parse(name)));
  handle('drive-start', async (fileId, folder) => {
    const id = z.string().uuid().parse(fileId), filePath = await resolveFile(id), folderId = z.string().min(1).max(512).parse(folder);
    const drive = requireService(driveUpload);
    return startJob('google', id, async (jobId, signal) => {
      const file = await drive.upload(filePath, folderId, { signal, onProgress: progress => emit({ kind: 'job', provider: 'google', id: jobId, phase: 'progress', progress }) });
      return { fileId: file.id, webViewLink: file.webViewLink };
    });
  });
  handle('job-cancel', async id => { jobs.get(z.string().uuid().parse(id))?.controller.abort(); });
  const shutdown = () => { tikAuth?.cancel(false); googleAuth?.cancel(); for (const job of jobs.values()) job.controller.abort(); };
  app.on('before-quit', shutdown);
  return {
    shutdown,
    registerFile: async (filePath: string) => {
      const file = await stat(filePath), media = await probeMedia(filePath), id = randomUUID();
      selected.set(id, { path: filePath, size: file.size, mtimeMs: file.mtimeMs });
      return { id, name: path.basename(filePath), size: file.size, durationSec: media.durationSec };
    },
    archive: async (filePath: string, folderId: string, options: Parameters<DriveUpload['upload']>[2]) => requireService(driveUpload).upload(filePath, folderId, options),
    canArchive: async () => !!(await google?.account())?.connected,
  };
}

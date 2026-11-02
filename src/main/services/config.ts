import path from 'node:path';
import { app } from 'electron';
import { DRIVE_FILE_SCOPE, DRIVE_SCOPE } from './google-drive/oauth';

export function publishingConfigPath() {
  return app.isPackaged ? path.join(app.getPath('userData'), 'oauth.env') : path.resolve('.env');
}

export function loadPublishingConfig() {
  // .env is main-process-only. Vite-prefixed variables must never contain secrets.
  try { process.loadEnvFile(publishingConfigPath()); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const key = process.env.TIKTOK_CLIENT_KEY?.trim();
  const secret = process.env.TIKTOK_CLIENT_SECRET?.trim();
  const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const scope = process.env.GOOGLE_DRIVE_SCOPE?.trim() ?? DRIVE_FILE_SCOPE;
  if (![DRIVE_FILE_SCOPE, DRIVE_SCOPE].includes(scope)) throw new Error('Unsupported GOOGLE_DRIVE_SCOPE');
  return {
    tiktok: key && secret ? { clientKey: key, clientSecret: secret } : undefined,
    google: googleClientId ? { clientId: googleClientId, clientSecret: process.env.GOOGLE_CLIENT_SECRET?.trim(), scopes: [scope] } : undefined,
  };
}

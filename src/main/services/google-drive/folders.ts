import { z } from 'zod';
import type { GoogleOAuth } from './oauth';
import { googleJson } from '../http';

export const driveFileSchema = z.object({ id: z.string().min(1), name: z.string(), webViewLink: z.string().optional(), size: z.string().optional() });
export class DriveFolders {
  constructor(private oauth: GoogleOAuth) {}
  async list(pageToken?: string, signal?: AbortSignal) {
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.search = new URLSearchParams({ q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false", spaces: 'drive',
      fields: 'nextPageToken,files(id,name)', pageSize: '100', orderBy: 'name', ...(pageToken ? { pageToken } : {}) }).toString();
    return googleJson(await this.oauth.authorized(url.toString(), { signal }),
      z.object({ files: z.array(driveFileSchema), nextPageToken: z.string().optional() }));
  }
  async create(name: string, signal?: AbortSignal) {
    const validName = z.string().trim().min(1).max(200).parse(name);
    return googleJson(await this.oauth.authorized('https://www.googleapis.com/drive/v3/files?fields=id,name', {
      method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: validName, mimeType: 'application/vnd.google-apps.folder' }),
    }), driveFileSchema);
  }
  async assertWritable(id: string, signal?: AbortSignal) {
    const file = await googleJson(await this.oauth.authorized(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,mimeType,trashed,capabilities(canAddChildren)`, { signal }),
      z.object({ id: z.string(), mimeType: z.string(), trashed: z.boolean().optional(), capabilities: z.object({ canAddChildren: z.boolean().optional() }) }));
    if (file.trashed || file.mimeType !== 'application/vnd.google-apps.folder' || !file.capabilities.canAddChildren)
      throw new Error('Drive folder is unavailable or not writable');
  }
}

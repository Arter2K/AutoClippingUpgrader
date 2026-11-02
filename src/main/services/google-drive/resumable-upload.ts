import path from 'node:path';
import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { z } from 'zod';
import type { UploadProgress, DriveFile } from '../../../shared/publishing';
import type { GoogleOAuth } from './oauth';
import type { ResumeStore, DriveCheckpoint } from './resume-store';
import { DriveFolders, driveFileSchema } from './folders';
import { ApiError, assertUploadUrl, backoff, googleJson, request, retryable, type Fetcher } from '../http';

const UNIT = 256 * 1024;
export function driveOffset(response: Response, size: number): number {
  const range = response.headers.get('range');
  if (!range) return 0;
  const match = /^bytes=0-(\d+)$/.exec(range);
  const offset = match ? Number(match[1]) + 1 : NaN;
  if (!Number.isSafeInteger(offset) || offset <= 0 || offset > size) throw new Error('Invalid Google resumable Range');
  return offset;
}

export class DriveUpload {
  private active = new Set<string>();
  constructor(private oauth: GoogleOAuth, private checkpoints: ResumeStore, private fetcher: Fetcher = fetch) {}
  async upload(filePath: string, folderId: string, options: {
    signal?: AbortSignal; chunkSize?: number; onProgress?: (progress: UploadProgress) => void;
  } = {}): Promise<DriveFile> {
    const chunkSize = options.chunkSize ?? 8 * 1024 * 1024;
    if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0 || chunkSize > 64 * 1024 ** 2 || chunkSize % UNIT !== 0)
      throw new Error('Drive chunks must be multiples of 256 KiB, up to 64 MiB');
    if (!folderId || folderId.length > 512) throw new Error('Select a Drive folder');
    const signal = options.signal;
    await new DriveFolders(this.oauth).assertWritable(folderId, signal);
    const identity = await googleJson(await this.oauth.authorized('https://www.googleapis.com/drive/v3/about?fields=user(permissionId)', { signal }),
      z.object({ user: z.object({ permissionId: z.string().min(1) }) }));
    const ownerId = `${this.oauth.clientId}:${identity.user.permissionId}`;
    const absolute = path.resolve(filePath);
    const key = createHash('sha256').update(JSON.stringify([ownerId, absolute, folderId])).digest('hex');
    if (this.active.has(key)) throw new Error('This file is already uploading to this folder');
    this.active.add(key);
    const handle = await open(absolute, 'r').catch(error => { this.active.delete(key); throw error; });
    try {
      const original = await handle.stat();
      if (!original.isFile() || original.size <= 0) throw new Error('Select a non-empty regular file');
      const size = original.size;
      const unchanged = async () => {
        const current = await stat(absolute);
        if (current.size !== size || current.mtimeMs !== original.mtimeMs || current.ino !== original.ino) throw new Error('File changed during Drive upload');
      };
      const report = (n: number) => options.onProgress?.({ uploadedBytes: n, totalBytes: size, fraction: n / size });
      let checkpoint = await this.checkpoints.get(key);
      if (checkpoint && (checkpoint.filePath !== absolute || checkpoint.size !== size || checkpoint.mtimeMs !== original.mtimeMs ||
        checkpoint.ownerId !== ownerId || checkpoint.folderId !== folderId || Date.now() - checkpoint.createdAt > 6 * 86400000)) {
        await this.checkpoints.remove(key); checkpoint = null;
      }
      const initiate = async (): Promise<DriveCheckpoint> => {
        const response = await this.oauth.authorized('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size,webViewLink', {
          method: 'POST', signal, headers: { 'Content-Type': 'application/json; charset=UTF-8',
            'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': String(size) },
          body: JSON.stringify({ name: path.basename(absolute), parents: [folderId], mimeType: 'video/mp4' }),
        });
        if (!response.ok) await googleJson(response, z.unknown());
        const location = response.headers.get('location'); await response.body?.cancel();
        if (!location) throw new Error('Google did not return resumable session URL');
        const next: DriveCheckpoint = { url: assertUploadUrl(location, 'google'), filePath: absolute, size,
          mtimeMs: original.mtimeMs, folderId, ownerId, createdAt: Date.now() };
        await this.checkpoints.set(key, next); return next;
      };
      const send = async (url: string, start?: number): Promise<Response> => {
        signal?.throwIfAborted();
        const token = await this.oauth.accessToken(signal);
        const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'Content-Range': `bytes */${size}`, 'Content-Length': '0' };
        if (start === undefined) return request(this.fetcher, url, { method: 'PUT', signal, headers });
        await unchanged();
        const end = Math.min(size - 1, start + chunkSize - 1);
        // Each request owns its descriptor. Destroying a stream must not close the job's source handle.
        const chunkHandle = await open(absolute, 'r');
        const chunkStat = await chunkHandle.stat();
        if (chunkStat.ino !== original.ino || chunkStat.size !== size || chunkStat.mtimeMs !== original.mtimeMs) {
          await chunkHandle.close(); throw new Error('File changed during Drive upload');
        }
        const stream = chunkHandle.createReadStream({ start, end, autoClose: true });
        Object.assign(headers, { 'Content-Type': 'video/mp4', 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}` });
        try { return await request(this.fetcher, url, { method: 'PUT', signal, headers, duplex: 'half', body: stream as unknown as BodyInit }); }
        finally { stream.destroy(); await chunkHandle.close(); }
      };
      const finish = async (response: Response) => {
        const file = await googleJson(response, driveFileSchema);
        await this.checkpoints.remove(key); report(size); return file;
      };
      const transient = async (response: Response) => {
        if (retryable(response.status)) return true;
        if (response.status !== 403) return false;
        const body = await response.clone().json().catch(() => null) as { error?: { errors?: Array<{ reason?: string }> } } | null;
        return body?.error?.errors?.some(e => ['rateLimitExceeded', 'userRateLimitExceeded'].includes(e.reason ?? '')) ?? false;
      };
      const queryStatus = async (url: string): Promise<Response> => {
        for (let attempt = 0; attempt < 4; attempt++) {
          signal?.throwIfAborted();
          let response: Response | undefined;
          try { response = await send(url); }
          catch (error) { signal?.throwIfAborted(); if (error instanceof ApiError) throw error; }
          if (response && response.status !== 401 && !await transient(response)) return response;
          const retryAfter = response?.headers.get('retry-after'); await response?.body?.cancel();
          if (response?.status === 401) await this.oauth.accessToken(signal, true);
          await backoff(attempt, signal, retryAfter);
        }
        throw new ApiError('Google Drive', 503, 'resume_required', 'Не удалось запросить смещение. Сессия сохранена; повторите загрузку позднее');
      };
      let offset = 0;
      if (checkpoint) {
        const response = await queryStatus(assertUploadUrl(checkpoint.url, 'google'));
        if (response.status === 200 || response.status === 201) return await finish(response);
        if (response.status === 404 || response.status === 410) {
          await response.body?.cancel(); await this.checkpoints.remove(key); checkpoint = null;
        } else if (response.status === 308) {
          offset = driveOffset(response, size); await response.body?.cancel();
        } else { await googleJson(response, z.unknown()); throw new Error('Unexpected resumable response'); }
      }
      checkpoint ??= await initiate();
      const url = assertUploadUrl(checkpoint.url, 'google');
      report(offset);
      let failures = 0;
      while (offset < size) {
        await unchanged();
        const before = offset;
        let response: Response | undefined;
        try { response = await send(url, offset); }
        catch (error) { signal?.throwIfAborted(); if (error instanceof ApiError) throw error; }
        if (response?.status === 200 || response?.status === 201) { await unchanged(); return await finish(response); }
        if (response?.status === 308) {
          const next = driveOffset(response, size); await response.body?.cancel();
          if (next < before || next > Math.min(size, before + chunkSize)) throw new Error('Invalid Drive acknowledged offset');
          if (next > before && next < size) { offset = next; failures = 0; report(offset); continue; }
          // All bytes acknowledged without metadata: query session below to get the final resource.
        } else if (response && response.status !== 401 && !await transient(response)) {
          if (response.status === 404 || response.status === 410) await this.checkpoints.remove(key);
          await googleJson(response, z.unknown()); throw new Error('Drive upload rejected');
        }
        const retryAfter = response?.headers.get('retry-after'); await response?.body?.cancel();
        if (++failures > 4) throw new ApiError('Google Drive', 503, 'resume_required', 'Загрузка приостановлена; повторите для продолжения с подтверждённого смещения');
        if (response?.status === 401) await this.oauth.accessToken(signal, true);
        await backoff(failures - 1, signal, retryAfter);
        // Do not send another byte until a status query has positively confirmed the next offset.
        const status = await queryStatus(url);
        if (status.status === 200 || status.status === 201) return await finish(status);
        if (status.status === 308) {
          offset = driveOffset(status, size); await status.body?.cancel(); report(offset);
          if (offset === size) throw new ApiError('Google Drive', 503, 'metadata_pending', 'Все байты приняты; повторите загрузку для получения результата');
        } else { if (status.status === 404 || status.status === 410) await this.checkpoints.remove(key); await googleJson(status, z.unknown()); throw new Error('Cannot query resumable status'); }
      }
      throw new ApiError('Google Drive', 503, 'metadata_pending', 'Ожидается подтверждение завершения загрузки');
    } finally { this.active.delete(key); await handle.close(); }
  }
}

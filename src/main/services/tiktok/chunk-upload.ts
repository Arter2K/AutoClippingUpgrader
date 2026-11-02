import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { UploadProgress } from '../../../shared/publishing';
import { ApiError, assertUploadUrl, backoff, request, retryable, type Fetcher } from '../http';

const MB = 1024 * 1024;
export interface Chunk { start: number; end: number }
export function tiktokChunkPlan(size: number, preferred = 10 * MB) {
  if (!Number.isSafeInteger(size) || size <= 0 || size > 4 * 1024 ** 3) throw new Error('TikTok video size must be 1 byte–4 GiB');
  if (!Number.isInteger(preferred) || preferred < 5 * MB || preferred > 64 * MB) throw new Error('TikTok chunk must be 5–64 MiB');
  const chunkSize = size <= 64 * MB ? size : preferred;
  const count = Math.max(1, Math.floor(size / chunkSize));
  if (count > 1000) throw new Error('Too many TikTok chunks');
  const chunks: Chunk[] = Array.from({ length: count }, (_, i) => ({ start: i * chunkSize, end: i === count - 1 ? size - 1 : (i + 1) * chunkSize - 1 }));
  return { video_size: size, chunk_size: chunkSize, total_chunk_count: count, chunks };
}

export async function uploadTikTokChunks(options: {
  filePath: string; uploadUrl: string; size: number; plan: ReturnType<typeof tiktokChunkPlan>;
  fetcher?: Fetcher; signal?: AbortSignal; onProgress?: (value: UploadProgress) => void;
  confirmedOffset: () => Promise<number | undefined>;
}) {
  const { filePath, size, signal, plan } = options;
  const url = assertUploadUrl(options.uploadUrl, 'tiktok');
  if ((await stat(filePath)).size !== size) throw new Error('Video changed after upload initialization');
  const report = (n: number) => options.onProgress?.({ uploadedBytes: n, totalBytes: size, fraction: n / size });
  report(0);
  for (const [index, chunk] of plan.chunks.entries()) {
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      const stream = createReadStream(filePath, { start: chunk.start, end: chunk.end });
      let response: Response | undefined;
      try {
        response = await request(options.fetcher ?? fetch, url, { method: 'PUT', signal, duplex: 'half',
          headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(chunk.end - chunk.start + 1),
            'Content-Range': `bytes ${chunk.start}-${chunk.end}/${size}` }, body: stream as unknown as BodyInit });
      } catch { signal?.throwIfAborted(); }
      finally { stream.destroy(); }
      if (response?.status === (index === plan.chunks.length - 1 ? 201 : 206)) {
        await response.body?.cancel(); report(chunk.end + 1); break;
      }
      const status = response?.status ?? 0;
      const retryAfter = response?.headers.get('retry-after');
      await response?.body?.cancel();
      if (response && !retryable(status) && status !== 416)
        throw new ApiError('TikTok upload', status, 'chunk_rejected', 'Чанк отклонён сервером');
      // Lost acknowledgements are resolved by querying server-confirmed bytes. Never restart init implicitly.
      const offset = await options.confirmedOffset();
      if (offset === chunk.end + 1) { report(offset); break; }
      if (offset !== chunk.start || attempt >= 3)
        throw new ApiError('TikTok upload', status, 'upload_uncertain', 'Не удалось подтвердить смещение загрузки; проверьте статус по publish_id');
      await backoff(attempt, signal, retryAfter);
    }
  }
}

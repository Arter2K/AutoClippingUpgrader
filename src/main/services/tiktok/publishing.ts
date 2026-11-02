import { stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { creatorSchema, postInfoSchema, type CreatorInfo, type PostInfo, type UploadProgress } from '../../../shared/publishing';
import { ApiError, tiktokJson, type Fetcher } from '../http';
import { probeMedia } from '../../engine/probe';
import { tiktokChunkPlan, uploadTikTokChunks } from './chunk-upload';
import type { TikTokOAuth } from './oauth';

const base = 'https://open.tiktokapis.com/v2/post/publish/';
const statusSchema = z.object({ status: z.string(), fail_reason: z.string().optional(),
  uploaded_bytes: z.number().nonnegative().optional(), publicaly_available_post_id: z.array(z.union([z.string(), z.number()])).optional() });
export type PostStatus = z.infer<typeof statusSchema>;
export class TikTokPublishing {
  constructor(private oauth: TikTokOAuth, private fetcher: Fetcher = fetch,
    private probe = probeMedia) {}
  private async post<T>(route: string, body: unknown, schema: z.ZodType<T>, signal?: AbortSignal) {
    return tiktokJson(await this.oauth.authorized(`${base}${route}`, { method: 'POST', signal,
      headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify(body) }), schema);
  }
  async creatorInfo(signal?: AbortSignal): Promise<CreatorInfo> {
    await this.oauth.requireScopes(['video.publish']);
    return this.post('creator_info/query/', {}, creatorSchema, signal);
  }
  status(publishId: string, signal?: AbortSignal): Promise<PostStatus> {
    if (!publishId || publishId.length > 512) throw new Error('Invalid publish ID');
    return this.post('status/fetch/', { publish_id: publishId }, statusSchema, signal);
  }
  async upload(input: { filePath: string; mode: 'direct_post' | 'inbox'; postInfo?: PostInfo; consent: true }, options: {
    signal?: AbortSignal; onProgress?: (progress: UploadProgress) => void; onInitialized?: (publishId: string) => Promise<void> | void;
  } = {}): Promise<{ publishId: string }> {
    if (input.consent !== true) throw new Error('Posting consent is required');
    await this.oauth.requireScopes([input.mode === 'direct_post' ? 'video.publish' : 'video.upload']);
    const file = await stat(input.filePath);
    if (!file.isFile()) throw new Error('Video path is not a file');
    const media = await this.probe(input.filePath, undefined, options.signal);
    const plan = tiktokChunkPlan(file.size);
    let postInfo: PostInfo | undefined;
    if (input.mode === 'direct_post') {
      postInfo = postInfoSchema.parse(input.postInfo);
      const creator = await this.creatorInfo(options.signal);
      if (!creator.privacy_level_options.includes(postInfo.privacy_level)) throw new Error('Selected privacy is unavailable for creator');
      if (media.durationSec > creator.max_video_post_duration_sec) throw new Error('Video exceeds creator maximum duration');
      if (postInfo.video_cover_timestamp_ms >= media.durationSec * 1000) throw new Error('Cover timestamp exceeds video duration');
      if (creator.comment_disabled && !postInfo.disable_comment || creator.duet_disabled && !postInfo.disable_duet || creator.stitch_disabled && !postInfo.disable_stitch)
        throw new Error('Interaction settings conflict with creator permissions; refresh Creator Info');
    }
    const sourceInfo = { source: 'FILE_UPLOAD', video_size: plan.video_size, chunk_size: plan.chunk_size, total_chunk_count: plan.total_chunk_count };
    // Initialization is intentionally never retried: a retry can create a second post.
    const initialized = await this.post(input.mode === 'direct_post' ? 'video/init/' : 'inbox/video/init/',
      { source_info: sourceInfo, ...(postInfo ? { post_info: postInfo } : {}) },
      z.object({ publish_id: z.string().min(1), upload_url: z.string().url() }), options.signal);
    await options.onInitialized?.(initialized.publish_id);
    await uploadTikTokChunks({ filePath: input.filePath, size: file.size, uploadUrl: initialized.upload_url, plan,
      fetcher: this.fetcher, signal: options.signal, onProgress: options.onProgress,
      confirmedOffset: async () => (await this.status(initialized.publish_id, options.signal)).uploaded_bytes });
    return { publishId: initialized.publish_id };
  }
  async waitForStatus(publishId: string, mode: 'direct_post' | 'inbox', options: {
    signal?: AbortSignal; timeoutMs?: number; intervalMs?: number; onStatus?: (status: PostStatus) => void;
  } = {}): Promise<PostStatus> {
    const deadline = Date.now() + (options.timeoutMs ?? 600000);
    while (Date.now() < deadline) {
      options.signal?.throwIfAborted();
      const value = await this.status(publishId, options.signal); options.onStatus?.(value);
      if (value.status === 'FAILED') throw new ApiError('TikTok', 200, value.fail_reason ?? 'publish_failed', 'Обработка видео завершилась ошибкой');
      if (value.status === 'PUBLISH_COMPLETE' || mode === 'inbox' && value.status === 'SEND_TO_USER_INBOX') return value;
      await delay(Math.max(2100, options.intervalMs ?? 5000), undefined, { signal: options.signal });
    }
    throw new ApiError('TikTok', 408, 'status_pending', 'Обработка продолжается; проверьте статус позднее по publish_id');
  }
}

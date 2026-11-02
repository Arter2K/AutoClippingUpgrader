import { z } from 'zod';

export type Provider = 'tiktok' | 'google';
export interface AccountState { connected: boolean; scopes: string[]; expiresAt?: number }
export interface PublishingState {
  configurationPath?: string;
  tiktok: AccountState & { configured: boolean };
  google: AccountState & { configured: boolean };
}
export interface UploadProgress { uploadedBytes: number; totalBytes: number; fraction: number }
export interface ServiceEvent {
  kind: 'auth' | 'job';
  provider: Provider;
  id: string;
  phase: 'running' | 'progress' | 'complete' | 'error' | 'cancelled';
  progress?: UploadProgress;
  message?: string;
  result?: { publishId?: string; status?: string; fileId?: string; webViewLink?: string };
}
export const creatorSchema = z.object({
  creator_avatar_url: z.string(), creator_username: z.string(), creator_nickname: z.string(),
  privacy_level_options: z.array(z.string()), comment_disabled: z.boolean(), duet_disabled: z.boolean(),
  stitch_disabled: z.boolean(), max_video_post_duration_sec: z.number().positive(),
});
export type CreatorInfo = z.infer<typeof creatorSchema>;
export const postInfoSchema = z.object({
  title: z.string().max(2200), privacy_level: z.string().min(1),
  disable_duet: z.boolean(), disable_comment: z.boolean(), disable_stitch: z.boolean(),
  video_cover_timestamp_ms: z.number().int().nonnegative().default(0),
});
export type PostInfo = z.infer<typeof postInfoSchema>;
export const tiktokJobSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('direct_post'), fileId: z.string().uuid(), consent: z.literal(true), postInfo: postInfoSchema }),
  z.object({ mode: z.literal('inbox'), fileId: z.string().uuid(), consent: z.literal(true) }),
]);
export type TikTokJob = z.infer<typeof tiktokJobSchema>;
export interface DriveFolder { id: string; name: string }
export interface DriveFile extends DriveFolder { webViewLink?: string; size?: string }
export interface SelectedUploadFile { id: string; name: string; size: number; durationSec: number }
export interface PublishingBridge {
  openConfigFolder(): Promise<void>;
  state(): Promise<PublishingState>;
  connectTikTok(mode: 'window' | 'external'): Promise<{ authorizationUrl: string }>;
  completeTikTok(callbackUrl: string): Promise<void>;
  connectGoogle(): Promise<void>;
  cancelAuth(provider: Provider): Promise<void>;
  disconnect(provider: Provider): Promise<void>;
  creatorInfo(): Promise<CreatorInfo>;
  selectUploadFile(): Promise<SelectedUploadFile | null>;
  startTikTok(job: TikTokJob): Promise<string>;
  statusTikTok(publishId: string): Promise<{ status: string; fail_reason?: string }>;
  driveFolders(pageToken?: string): Promise<{ files: DriveFolder[]; nextPageToken?: string }>;
  createDriveFolder(name: string): Promise<DriveFolder>;
  startDrive(fileId: string, folderId: string): Promise<string>;
  cancelJob(id: string): Promise<void>;
  onEvent(callback: (event: ServiceEvent) => void): () => void;
}

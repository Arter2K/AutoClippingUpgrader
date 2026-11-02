import { runProcess } from './process';
import type { MediaInfo } from '../../shared/template';

export async function probeMedia(file: string, ffprobe = process.env.FFPROBE_PATH ?? 'ffprobe', signal?: AbortSignal, allowAudio = false): Promise<MediaInfo> {
  const raw = await runProcess(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { signal });
  const data = JSON.parse(raw) as { streams: Array<{ codec_type: string; width?: number; height?: number;
    duration?: string; disposition?: { attached_pic?: number }; tags?: { rotate?: string };
    side_data_list?: Array<{ rotation?: number }> }>; format: { duration?: string } };
  const video = data.streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if ((!video?.width || !video.height) && (!allowAudio || !data.streams.some(s => s.codec_type === 'audio'))) throw new Error('No video stream in source');
  const durationSec = Number(video?.duration ?? data.format.duration);
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error('Source duration is unknown');
  const rotation = Number(video?.side_data_list?.find(s => s.rotation !== undefined)?.rotation ?? video?.tags?.rotate ?? 0);
  const rotated = Math.abs(rotation % 180) === 90;
  return { width: rotated ? video!.height! : video?.width ?? 0, height: rotated ? video!.width! : video?.height ?? 0,
    durationSec, hasAudio: data.streams.some(s => s.codec_type === 'audio') };
}

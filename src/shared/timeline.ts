import { z } from 'zod';

const time = z.number().finite().nonnegative();
export const timelineClipSchema = z.object({
  id: z.string().min(1), name: z.string(), media_type: z.enum(['video', 'audio', 'image', 'text']),
  source_path: z.string().refine(v => !/[\x00-\x1f]/.test(v)).default(''), overlay_id: z.string().optional(),
  timeline_start_sec: time, duration_sec: time.positive(), source_in_sec: time, source_out_sec: time.positive(),
  source_duration_sec: time.positive().optional(), has_audio: z.boolean().default(false),
  enabled: z.boolean().optional(),
  volume: z.number().finite().min(0).max(2).default(1), muted: z.boolean().default(false),
  fade_in_sec: time.default(0), fade_out_sec: time.default(0),
  use_template_main_layout: z.boolean().default(false),
  transform: z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().int().min(1).max(16384),
    height: z.number().int().min(1).max(16384), scale: z.number().positive().max(16).default(1), opacity: z.number().min(0).max(1).default(1) }).optional(),
}).superRefine((c, ctx) => {
  if (Math.abs(c.source_out_sec - c.source_in_sec - c.duration_sec) > 0.00001)
    ctx.addIssue({ code: 'custom', message: 'Segment duration must equal source_out_sec - source_in_sec' });
  if (c.source_duration_sec !== undefined && c.source_out_sec > c.source_duration_sec + 0.001)
    ctx.addIssue({ code: 'custom', message: 'Segment exceeds source duration' });
  if (c.fade_in_sec > c.duration_sec || c.fade_out_sec > c.duration_sec)
    ctx.addIssue({ code: 'custom', message: 'Audio fade exceeds segment duration' });
  if (c.media_type !== 'text' && !c.source_path)
    ctx.addIssue({ code: 'custom', message: 'Media segment requires source_path' });
});
export const timelineTrackSchema = z.object({
  id: z.string().min(1), name: z.string(), type: z.enum(['video', 'audio']), order_index: z.number().int(),
  is_visible: z.boolean().default(true), is_locked: z.boolean().default(false), is_muted: z.boolean().default(false),
  is_solo: z.boolean().default(false), volume: z.number().finite().min(0).max(2).default(1),
  clips: z.array(timelineClipSchema).max(500),
});
export const timelineSchema = z.object({
  playhead_sec: time.default(0), zoom_px_per_sec: z.number().finite().min(10).max(500).default(60),
  snap_enabled: z.boolean().default(true), total_duration_sec: time.default(0), tracks: z.array(timelineTrackSchema).max(100),
}).superRefine((t, ctx) => {
  const tracks = new Set<string>(), clips = new Set<string>();
  for (const track of t.tracks) {
    if (tracks.has(track.id)) ctx.addIssue({ code: 'custom', message: 'Duplicate track ID' }); tracks.add(track.id);
    for (const clip of track.clips) {
      if (clips.has(clip.id)) ctx.addIssue({ code: 'custom', message: 'Duplicate clip ID' }); clips.add(clip.id);
      if ((track.type === 'audio') !== (clip.media_type === 'audio')) ctx.addIssue({ code: 'custom', message: 'Incompatible clip and track type' });
    }
  }
}).transform(t => ({ ...t, total_duration_sec: timelineDuration(t) }));
export type TimelineClip = z.infer<typeof timelineClipSchema>;
export type TimelineTrack = z.infer<typeof timelineTrackSchema>;
export interface Timeline { tracks: TimelineTrack[]; playhead_sec: number; zoom_px_per_sec: number; snap_enabled: boolean; total_duration_sec: number }

export function audioTrackActive(track: TimelineTrack, timeline: Pick<Timeline, 'tracks'>): boolean {
  return !track.is_muted && (!timeline.tracks.some(t => t.is_solo) || track.is_solo);
}
export function clipHasAudio(clip: TimelineClip): boolean { return clip.media_type === 'audio' || (clip.media_type === 'video' && clip.has_audio); }
/** Video may contain audio even when an imported JSON omitted its metadata. */
export function segmentNeedsMedia(clip: TimelineClip, track: TimelineTrack, timeline: Timeline): boolean {
  return clip.enabled !== false && ((track.type === 'video' && track.is_visible) ||
    (!clip.muted && audioTrackActive(track, timeline) && (clip.media_type === 'video' || clip.media_type === 'audio')));
}
export function timelineDuration(timeline: Pick<Timeline, 'tracks'>): number {
  return Math.max(0, ...timeline.tracks.flatMap(track => track.clips.filter(clip => clip.enabled !== false && (
    (track.type === 'video' && track.is_visible) || (audioTrackActive(track, timeline) && clipHasAudio(clip) && !clip.muted))
  ).map(c => c.timeline_start_sec + c.duration_sec)));
}
export function timelineHasAudio(timeline: Timeline): boolean {
  return timeline.tracks.some(t => audioTrackActive(t, timeline) && t.clips.some(c => c.enabled !== false && clipHasAudio(c) && !c.muted && c.volume * t.volume > 0));
}
export function clipGain(clip: TimelineClip, track: TimelineTrack, timeline: Timeline, timeSec: number): number {
  const local = timeSec - clip.timeline_start_sec;
  if (clip.enabled === false || !audioTrackActive(track, timeline) || clip.muted || !clipHasAudio(clip) || local < 0 || local >= clip.duration_sec) return 0;
  return clip.volume * track.volume * (clip.fade_in_sec ? Math.min(1, local / clip.fade_in_sec) : 1) *
    (clip.fade_out_sec ? Math.min(1, (clip.duration_sec - local) / clip.fade_out_sec) : 1);
}
export function splitSegment(clip: TimelineClip, playhead: number, id: string): [TimelineClip, TimelineClip] | null {
  const offset = playhead - clip.timeline_start_sec;
  if (offset <= 0.000001 || offset >= clip.duration_sec - 0.000001) return null;
  const left = { ...clip, duration_sec: offset, source_out_sec: clip.source_in_sec + offset, fade_out_sec: 0, fade_in_sec: Math.min(clip.fade_in_sec, offset) };
  const right = { ...clip, id, timeline_start_sec: playhead, source_in_sec: left.source_out_sec, duration_sec: clip.duration_sec - offset, fade_in_sec: 0,
    fade_out_sec: Math.min(clip.fade_out_sec, clip.duration_sec - offset) };
  return [left, right];
}
export function trimmedSegment(clip: TimelineClip, edge: 'in' | 'out', sourceTime: number, minDuration = 1 / 120): TimelineClip {
  const result = { ...clip };
  const still = clip.media_type === 'image' || clip.media_type === 'text';
  if (!still && result.source_duration_sec === undefined) result.source_duration_sec = clip.source_out_sec;
  if (edge === 'in') {
    const value = Math.max(0, clip.source_in_sec - clip.timeline_start_sec, Math.min(clip.source_out_sec - minDuration, sourceTime));
    result.timeline_start_sec += value - clip.source_in_sec; result.source_in_sec = value;
  } else result.source_out_sec = Math.max(clip.source_in_sec + minDuration, Math.min(still ? Infinity : result.source_duration_sec!, sourceTime));
  result.duration_sec = result.source_out_sec - result.source_in_sec;
  result.fade_in_sec = Math.min(result.fade_in_sec, result.duration_sec); result.fade_out_sec = Math.min(result.fade_out_sec, result.duration_sec);
  return result;
}
export function snapClipStart(value: number, duration: number, points: number[], tolerance: number): { value: number; guide: number | null } {
  let result = Math.max(0, value), guide: number | null = null, distance = tolerance;
  for (const p of points) for (const edge of [0, duration]) {
    const delta = Math.abs(value + edge - p);
    if (delta <= distance && p - edge >= 0) { result = p - edge; guide = p; distance = delta; }
  }
  return { value: result, guide };
}

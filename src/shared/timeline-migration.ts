import type { Template, Trim } from './template';
import type { SourceMedia } from './editor';
import { timelineDuration, type Timeline, type TimelineClip, type TimelineTrack } from './timeline';

export function newTrack(type: 'video' | 'audio', tracks: TimelineTrack[], id: string): TimelineTrack {
  const order = type === 'video' ? Math.max(0, ...tracks.filter(t => t.type === type).map(t => t.order_index)) + 1 : Math.min(0, ...tracks.filter(t => t.type === type).map(t => t.order_index)) - 1;
  return { id, type, name: `${type === 'video' ? 'V' : 'A'}${Math.abs(order)}`, order_index: order, is_visible: true,
    is_locked: false, is_muted: false, is_solo: false, volume: 1, clips: [] };
}
export function migrateTimeline(template: Template, source: SourceMedia, trim: Trim): Timeline {
  const track = newTrack('video', [], 'track-main');
  track.clips.push({ id: 'clip-main', name: source.name, media_type: 'video', source_path: source.path ?? '',
    timeline_start_sec: 0, duration_sec: trim.outSec - trim.inSec, source_in_sec: trim.inSec, source_out_sec: trim.outSec,
    source_duration_sec: source.media.durationSec, has_audio: source.media.hasAudio, volume: 1, muted: false,
    fade_in_sec: 0, fade_out_sec: 0, use_template_main_layout: true });
  const timeline: Timeline = { playhead_sec: 0, zoom_px_per_sec: 60, snap_enabled: true, total_duration_sec: trim.outSec - trim.inSec, tracks: [track] };
  syncOverlayClips(template, timeline);
  return timeline;
}
export function syncOverlayClips(template: Template, timeline: Timeline, addedIds?: string[]) {
  const duration = timelineDuration(timeline) || 1;
  for (const track of timeline.tracks) track.clips = track.clips.filter(c => !c.overlay_id || template.overlays.some(o => o.id === c.overlay_id));
  for (const o of [...template.overlays].sort((a, b) => a.z_index - b.z_index)) {
    if (addedIds && !addedIds.includes(o.id)) continue;
    if (timeline.tracks.some(t => t.clips.some(c => c.overlay_id === o.id))) continue;
    const start = o.timing.full_duration ? 0 : o.timing.start_offset_sec;
    const length = Math.max(1 / template.canvas.fps, (o.timing.full_duration ? duration : o.timing.end_offset_sec ?? duration) - start);
    const track = newTrack('video', timeline.tracks, `track-${o.id}`);
    track.is_locked = o.locked ?? false;
    const clip: TimelineClip = { id: `clip-${o.id}`, overlay_id: o.id, name: o.name, media_type: o.type,
      source_path: o.type === 'text' ? '' : o.source_path, timeline_start_sec: start, duration_sec: length,
      source_in_sec: 0, source_out_sec: length, volume: 1, muted: true, has_audio: false,
      fade_in_sec: 0, fade_out_sec: 0, use_template_main_layout: false, enabled: o.enabled !== false };
    track.clips.push(clip); timeline.tracks.push(track);
  }
  // Media paths follow restored originals / AI-processed images.
  for (const track of timeline.tracks) for (const c of track.clips) {
    const o = template.overlays.find(o => o.id === c.overlay_id);
    if (o && o.type !== 'text') c.source_path = o.source_path;
  }
  timeline.total_duration_sec = timelineDuration(timeline);
}

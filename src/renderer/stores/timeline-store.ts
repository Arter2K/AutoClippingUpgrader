import { create } from 'zustand';
import { useEditorStore } from './editor-store';
import { newTrack } from '../../shared/timeline-migration';
import { splitSegment, trimmedSegment, timelineDuration, type Timeline, type TimelineClip, type TimelineTrack } from '../../shared/timeline';

const empty: Timeline = { tracks: [], playhead_sec: 0, total_duration_sec: 0, zoom_px_per_sec: 60, snap_enabled: true };
interface TimelineStore {
  timeline: Timeline; selectedClipId: string | null;
  addTrack(type: 'video' | 'audio', record?: boolean): string;
  reorderTracks(ids: string[]): void;
  moveClipToTrack(id: string, trackId: string, start: number, record?: boolean): void;
  splitClipAtPlayhead(): void;
  trimClip(id: string, edge: 'in' | 'out', time: number, record?: boolean): void;
  setClipVolume(id: string, volume: number, record?: boolean): void;
  updateClip(id: string, patch: Partial<TimelineClip>, record?: boolean): void;
  updateTrack(id: string, patch: Partial<Pick<TimelineTrack, 'name' | 'volume' | 'is_muted' | 'is_solo' | 'is_visible' | 'is_locked'>>): void;
  detachAudio(id?: string): void; deleteClip(id: string): void; selectClip(id: string | null): void;
  addClip(trackId: string, clip: TimelineClip, record?: boolean): void;
  setView(patch: Partial<Pick<Timeline, 'zoom_px_per_sec' | 'snap_enabled'>>): void;
}
function edit(recipe: (timeline: Timeline) => void, record = true) {
  useEditorStore.getState().change(t => { if (t.timeline) { recipe(t.timeline); t.timeline.total_duration_sec = timelineDuration(t.timeline); } }, record);
}
function eachClip(id: string, recipe: (clip: TimelineClip) => void, record = true) {
  edit(t => { for (const track of t.tracks) { const c = track.clips.find(c => c.id === id); if (c && !track.is_locked) recipe(c); } }, record);
}
export const useTimelineStore = create<TimelineStore>((set, get) => ({
  timeline: empty, selectedClipId: null,
  addTrack(type, record = true) { const id = crypto.randomUUID(); edit(t => { t.tracks.push(newTrack(type, t.tracks, id)); }, record); return id; },
  reorderTracks(ids) { edit(t => { const video = t.tracks.filter(t => t.type === 'video');
    if (ids.length !== video.length || new Set(ids).size !== ids.length || ids.some(id => !video.some(t => t.id === id)) || video.some(t => t.is_locked)) return;
    for (const track of video) track.order_index = ids.length - ids.indexOf(track.id);
  }); },
  moveClipToTrack(id, trackId, start, record = true) { if (!Number.isFinite(start)) return; edit(t => {
    const from = t.tracks.find(t => t.clips.some(c => c.id === id)), to = t.tracks.find(t => t.id === trackId);
    if (!from || !to || from.is_locked || to.is_locked || from.type !== to.type) return;
    const clip = from.clips.find(c => c.id === id)!; from.clips = from.clips.filter(c => c.id !== id);
    to.clips.push({ ...clip, timeline_start_sec: Math.max(0, start) });
  }, record); },
  splitClipAtPlayhead() { const state = useEditorStore.getState(), selected = get().selectedClipId;
    edit(t => { for (const track of t.tracks) if (!track.is_locked) track.clips = track.clips.flatMap(c =>
      (!selected || selected === c.id) ? splitSegment(c, state.playhead, crypto.randomUUID()) ?? [c] : [c]); });
  },
  trimClip(id, edge, time, record = true) { if (!Number.isFinite(time)) return; eachClip(id, c => Object.assign(c, trimmedSegment(c, edge, time)), record); },
  setClipVolume(id, volume, record = true) { if (Number.isFinite(volume)) eachClip(id, c => { c.volume = Math.max(0, Math.min(2, volume)); }, record); },
  updateClip(id, patch, record = true) { eachClip(id, c => Object.assign(c, patch), record); },
  updateTrack(id, patch) { edit(t => { const track = t.tracks.find(t => t.id === id); if (track) Object.assign(track, patch); }); },
  detachAudio(id = get().selectedClipId ?? '') { edit(t => {
    const from = t.tracks.find(t => t.clips.some(c => c.id === id)), clip = from?.clips.find(c => c.id === id);
    if (!clip || from?.is_locked || clip.media_type !== 'video' || !clip.has_audio || clip.muted) return;
    let target = t.tracks.find(track => track.type === 'audio' && !track.is_locked && !track.is_muted && track.is_solo === from!.is_solo && track.volume === from!.volume && !track.clips.some(c => c.timeline_start_sec < clip.timeline_start_sec + clip.duration_sec && c.timeline_start_sec + c.duration_sec > clip.timeline_start_sec));
    if (!target) { target = newTrack('audio', t.tracks, crypto.randomUUID()); target.volume = from!.volume; target.is_solo = from!.is_solo; t.tracks.push(target); }
    target.clips.push({ ...clip, id: crypto.randomUUID(), overlay_id: undefined, media_type: 'audio', use_template_main_layout: false,
      background_removal: undefined, volume: clip.volume, muted: false, name: `${clip.name} · audio` });
    clip.muted = true;
  }); },
  deleteClip(id) { edit(t => { for (const track of t.tracks) if (!track.is_locked) track.clips = track.clips.filter(c => c.id !== id); }); set({ selectedClipId: null }); },
  selectClip(id) { set({ selectedClipId: id }); const clip = get().timeline.tracks.flatMap(t => t.clips).find(c => c.id === id);
    if (clip) useEditorStore.getState().select(clip.overlay_id ?? 'main');
  },
  addClip(trackId, clip, record = true) { edit(t => { const track = t.tracks.find(t => t.id === trackId); if (track && !track.is_locked && (track.type === 'audio') === (clip.media_type === 'audio')) track.clips.push(clip); }, record); },
  setView(patch) { edit(t => Object.assign(t, patch), false); },
}));
useEditorStore.subscribe(state => {
  const timeline = state.template.timeline ? { ...state.template.timeline, playhead_sec: state.playhead } : empty;
  const selected = useTimelineStore.getState().selectedClipId;
  useTimelineStore.setState({ timeline, ...(selected && !timeline.tracks.some(t => t.clips.some(c => c.id === selected)) ? { selectedClipId: null } : {}) });
});

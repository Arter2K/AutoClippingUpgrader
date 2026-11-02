import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Pause, Play, Scissors, Magnet, Volume2, VolumeX } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { useEditorStore, loadSource, task } from '../../stores/editor-store';
import { useTimelineStore } from '../../stores/timeline-store';
import { clipHasAudio, snapClipStart, type TimelineClip } from '../../../shared/timeline';
import { timecode } from '../../lib/utils';
import { Waveform } from './Waveform';

export function MultiTrackTimeline() {
  const store = useTimelineStore(), { timeline, selectedClipId } = store;
  const source = useEditorStore(s => s.source), assets = useEditorStore(s => s.assets), playhead = useEditorStore(s => s.playhead);
  const playing = useEditorStore(s => s.playing), muted = useEditorStore(s => s.muted), trim = useEditorStore(s => s.trim);
  const [guide, setGuide] = useState<number | null>(null), scroll = useRef<HTMLDivElement>(null);
  const [context, setContext] = useState<{ id: string; x: number; y: number } | null>(null);
  useEffect(() => {
    const close = (e: globalThis.PointerEvent) => { if (!(e.target as HTMLElement).closest('.clip-context-menu')) setContext(null); };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') setContext(null); };
    window.addEventListener('pointerdown', close); window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', escape); };
  }, []);
  const drag = useRef<{ clip: TimelineClip; trackId: string; x: number; y: number; mode: 'move' | 'in' | 'out' | 'volume' } | null>(null);
  const zoom = timeline.zoom_px_per_sec, duration = timeline.total_duration_sec;
  const tracks = [...timeline.tracks].sort((a, b) => b.order_index - a.order_index);
  const videoIds = tracks.filter(t => t.type === 'video').map(t => t.id);
  const width = Math.max(800, (duration + 5) * zoom);
  useEffect(() => {
    const el = scroll.current; if (!el) return;
    const wheel = (e: WheelEvent) => { if (e.ctrlKey) { e.preventDefault(); store.setView({ zoom_px_per_sec: Math.min(500, Math.max(10, useTimelineStore.getState().timeline.zoom_px_per_sec * (e.deltaY > 0 ? 0.9 : 1.1))) }); } };
    el.addEventListener('wheel', wheel, { passive: false }); return () => el.removeEventListener('wheel', wheel);
  }, [store.setView]);
  const startDrag = (event: PointerEvent, clip: TimelineClip, trackId: string, mode: 'move' | 'in' | 'out' | 'volume') => {
    event.stopPropagation(); if (event.button !== 0 || timeline.tracks.find(t => t.id === trackId)?.is_locked) return;
    store.selectClip(clip.id); useEditorStore.getState().checkpoint(); useEditorStore.setState({ playing: false });
    drag.current = { clip: structuredClone(clip), trackId, x: event.clientX, y: event.clientY, mode };
    scroll.current?.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent) => {
    const d = drag.current; if (!d) return;
    const dx = (event.clientX - d.x) / zoom;
    if (d.mode === 'volume') { store.setClipVolume(d.clip.id, d.clip.volume + (d.y - event.clientY) / 22, false); return; }
    const points = [0, playhead, ...timeline.tracks.flatMap(t => t.clips.filter(c => c.id !== d.clip.id).flatMap(c => [c.timeline_start_sec, c.timeline_start_sec + c.duration_sec]))];
    if (d.mode !== 'move') {
      const edge = d.mode === 'in' ? d.clip.timeline_start_sec + dx : d.clip.timeline_start_sec + d.clip.duration_sec + dx;
      const snapped = timeline.snap_enabled ? snapClipStart(edge, 0, points, 8 / zoom) : { value: edge, guide: null };
      setGuide(snapped.guide); store.trimClip(d.clip.id, d.mode, d.clip.source_in_sec + snapped.value - d.clip.timeline_start_sec, false); return;
    }
    const snapped = timeline.snap_enabled ? snapClipStart(d.clip.timeline_start_sec + dx, d.clip.duration_sec, points, 8 / zoom) : { value: Math.max(0, d.clip.timeline_start_sec + dx), guide: null };
    setGuide(snapped.guide);
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-track-id]');
    store.moveClipToTrack(d.clip.id, target?.dataset.trackId ?? d.trackId, snapped.value, false);
  };
  const finish = (event: PointerEvent) => {
    const d = drag.current;
    if (d?.mode === 'move') {
      const zone = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-new-track]');
      if (zone && (zone.dataset.newTrack === 'audio') === (d.clip.media_type === 'audio')) {
        const type = d.clip.media_type === 'audio' ? 'audio' : 'video', id = store.addTrack(type, false);
        const current = useTimelineStore.getState().timeline.tracks.flatMap(t => t.clips).find(c => c.id === d.clip.id);
        store.moveClipToTrack(d.clip.id, id, current?.timeline_start_sec ?? 0, false);
      }
    }
    drag.current = null; setGuide(null);
  };
  const importClip = (kind: 'video' | 'audio') => task(async () => {
    const asset = await window.desktop.editor.selectAsset(kind); if (!asset?.media) return;
    useEditorStore.setState(s => ({ assets: { ...s.assets, [asset.path]: asset.url } }));
    useEditorStore.getState().checkpoint();
    const id = store.addTrack(kind, false), length = asset.media.durationSec;
    store.addClip(id, { id: crypto.randomUUID(), name: asset.name, media_type: kind, source_path: asset.path,
      timeline_start_sec: playhead, duration_sec: length, source_in_sec: 0, source_out_sec: length, source_duration_sec: length,
      volume: 1, muted: false, fade_in_sec: 0, fade_out_sec: 0, has_audio: asset.media.hasAudio, use_template_main_layout: false,
      ...(kind === 'video' ? { transform: { x: 0, y: 0, width: useEditorStore.getState().template.canvas.width, height: useEditorStore.getState().template.canvas.height, scale: 1, opacity: 1 } } : {}) }, false);
  });
  return <section className="timeline-panel multitrack-panel" aria-label="Многодорожечный таймлайн">
    <div className="transport"><div className="transport-left">
      <Button size="icon" aria-label={playing ? 'Пауза' : 'Воспроизвести'} disabled={!duration} onClick={() => useEditorStore.setState({ playing: !playing })}>{playing ? <Pause size={14} /> : <Play size={14} />}</Button>
      <span className="time-display">{timecode(playhead)} / {timecode(duration)}</span>
      <Button size="sm" disabled={!source} onClick={() => store.splitClipAtPlayhead()}><Scissors size={12} />Split (S)</Button>
      <Button size="sm" disabled={!selectedClipId} onClick={() => store.detachAudio()}>Detach Audio</Button>
      <Button size="sm" className={timeline.snap_enabled ? 'is-active' : ''} onClick={() => store.setView({ snap_enabled: !timeline.snap_enabled })}><Magnet size={12} />Snap (N)</Button>
      <label>Zoom <input aria-label="Timeline Zoom" type="range" min={10} max={500} value={zoom} onChange={e => store.setView({ zoom_px_per_sec: +e.target.value })} /></label>
      <Button size="icon" aria-label="Звук предпросмотра" onClick={() => useEditorStore.setState({ muted: !muted })}>{muted ? <VolumeX size={13} /> : <Volume2 size={13} />}</Button>
    </div></div>
    <div className="track-actions"><button disabled={!source} onClick={() => store.addTrack('video')}>+ Add Video Track</button><button disabled={!source} onClick={() => store.addTrack('audio')}>+ Add Audio Track</button>
      <button disabled={!source} onClick={() => void importClip('video')}>+ Video clip</button><button disabled={!source} onClick={() => void importClip('audio')}>+ Audio clip</button>
      <button aria-label="Добавить видеоисходник" onClick={() => void loadSource(() => window.desktop.editor.selectSource())}>Добавить исходник</button></div>
    <div className="multitrack-scroll" ref={scroll} onPointerMove={move} onPointerUp={finish} onPointerCancel={() => { drag.current = null; setGuide(null); }}>
      <div className="multitrack-content" style={{ width: width + 180 }}>
        <div className="nle-ruler"><span className="track-header">TRACKS</span><div style={{ width }} onPointerDown={e => { const r = e.currentTarget.getBoundingClientRect(); store.selectClip(null); useEditorStore.setState({ playhead: Math.max(0, Math.min(duration - 0.001, (e.clientX - r.left) / zoom)), playing: false }); }}>
          {Array.from({ length: Math.ceil(width / zoom) + 1 }, (_, i) => i % Math.max(1, Math.ceil(60 / zoom)) === 0 && <span key={i} style={{ left: i * zoom }}>{timecode(i)}</span>)}
        </div></div>
        <div className="new-track-zone" data-new-track="video">Перетащите сюда для новой видеодорожки</div>
        {tracks.map(track => <div className={`nle-track ${track.type} ${track.is_locked ? 'locked' : ''}`} data-track-id={track.id} key={track.id}>
          <div className="track-header" draggable={track.type === 'video' && !track.is_locked} onDragStart={e => e.dataTransfer.setData('application/acu-track', track.id)} onDragOver={e => e.preventDefault()} onDrop={e => {
            e.preventDefault(); e.stopPropagation(); const id = e.dataTransfer.getData('application/acu-track');
            if (id && videoIds.includes(track.id)) { const ids = videoIds.filter(v => v !== id); ids.splice(ids.indexOf(track.id), 0, id); store.reorderTracks(ids); }
          }}><strong>{track.name}</strong><div>
            <button aria-label={`Mute ${track.name}`} aria-pressed={track.is_muted} onClick={() => store.updateTrack(track.id, { is_muted: !track.is_muted })}>M</button>
            <button aria-label={`Solo ${track.name}`} aria-pressed={track.is_solo} onClick={() => store.updateTrack(track.id, { is_solo: !track.is_solo })}>S</button>
            {track.type === 'video' && <button aria-label={`Hide ${track.name}`} aria-pressed={!track.is_visible} onClick={() => store.updateTrack(track.id, { is_visible: !track.is_visible })}>Eye</button>}
            <button aria-label={`Lock ${track.name}`} aria-pressed={track.is_locked} onClick={() => store.updateTrack(track.id, { is_locked: !track.is_locked })}>Lock</button>
          </div><input aria-label={`Volume ${track.name}`} type="range" min={0} max={2} step={0.01} value={track.volume} onChange={e => store.updateTrack(track.id, { volume: +e.target.value })} /></div>
          <div className="track-lane" style={{ width }} onPointerDown={() => store.selectClip(null)}>
            {track.clips.map(clip => <div key={clip.id} data-clip-id={clip.id} className={`nle-clip ${selectedClipId === clip.id ? 'selected' : ''}`} style={{ left: clip.timeline_start_sec * zoom, width: Math.max(3, clip.duration_sec * zoom) }}
              title={`${clip.name} · ${(clip.volume * 100).toFixed(0)}% / ${clip.volume ? (20 * Math.log10(clip.volume)).toFixed(1) : '−∞'} dB`}
              onClick={() => store.selectClip(clip.id)} onPointerDown={e => startDrag(e, clip, track.id, 'move')}
              onContextMenu={e => { e.preventDefault(); store.selectClip(clip.id); setContext({ id: clip.id, x: e.clientX, y: e.clientY }); }}>
              <span className="clip-name">{clip.name}</span>
              {clipHasAudio(clip) && <><Waveform clip={clip} url={assets[clip.source_path]} /><div className="clip-volume-line" style={{ top: 60 - clip.volume * 20 }} onPointerDown={e => startDrag(e, clip, track.id, 'volume')} /></>}
              <div className="clip-trim in" role="slider" aria-label={`Trim start ${clip.name}`} onPointerDown={e => startDrag(e, clip, track.id, 'in')} />
              <div className="clip-trim out" role="slider" aria-label={`Trim end ${clip.name}`} onPointerDown={e => startDrag(e, clip, track.id, 'out')} />
            </div>)}
          </div>
        </div>)}
        <div className="new-track-zone" data-new-track="audio">Перетащите сюда для новой аудиодорожки</div>
        <div className="nle-playhead" style={{ left: 180 + playhead * zoom }} />
        {guide !== null && <div className="nle-snap-guide" style={{ left: 180 + guide * zoom }} />}
      </div>
    </div>
    {context && <div role="menu" className="clip-context-menu" style={{ left: Math.min(context.x, window.innerWidth - 180), top: Math.min(context.y, window.innerHeight - 90) }}>
      <button role="menuitem" onClick={() => { store.detachAudio(context.id); setContext(null); }}>Отделить аудио / Detach Audio</button>
      <button role="menuitem" onClick={() => { store.deleteClip(context.id); setContext(null); }}>Удалить сегмент</button>
    </div>}
    {timeline.tracks.flatMap(t => t.clips).filter(c => c.use_template_main_layout).length === 1 && <div className="legacy-trim-fields">
      <label>IN <input aria-label="Trim In" type="number" min={0} max={trim.outSec - 0.01} step={0.1} value={trim.inSec} onChange={e => useEditorStore.getState().setTrim({ ...trim, inSec: +e.target.value })} /></label>
      <label>OUT <input aria-label="Trim Out" type="number" min={trim.inSec + 0.01} max={source?.media.durationSec} step={0.1} value={trim.outSec} onChange={e => useEditorStore.getState().setTrim({ ...trim, outSec: +e.target.value })} /></label>
    </div>}
  </section>;
}

export function ClipInspector() {
  const { timeline, selectedClipId, setClipVolume, updateClip } = useTimelineStore();
  const clip = timeline.tracks.flatMap(t => t.clips).find(c => c.id === selectedClipId);
  if (!clip) return null;
  return <section className="clip-inspector"><strong>{clip.name}</strong><label>Volume: {Math.round(clip.volume * 100)}%<input aria-label="Clip Volume" type="range" min={0} max={2} step={0.01} value={clip.volume} onChange={e => setClipVolume(clip.id, +e.target.value)} /></label>
    <label><input type="checkbox" checked={clip.muted} onChange={e => updateClip(clip.id, { muted: e.target.checked })} />Mute clip audio</label>
    {(['in', 'out'] as const).map(edge => <label key={edge}>Fade {edge} (sec)<input aria-label={`Clip Fade ${edge}`} type="number" min={0} max={Math.min(5, clip.duration_sec)} step={0.1} value={clip[`fade_${edge}_sec`]} onChange={e => updateClip(clip.id, { [`fade_${edge}_sec`]: Math.max(0, Math.min(5, clip.duration_sec, +e.target.value)) })} /></label>)}
    {clip.transform && (['x', 'y', 'width', 'height', 'scale', 'opacity'] as const).map(key => <label key={key}>{key}<input aria-label={`Clip ${key}`} type="number" value={clip.transform![key]} step={key === 'scale' || key === 'opacity' ? 0.1 : 1} onChange={e => {
      const value = +e.target.value; if (!Number.isFinite(value)) return;
      const next = key === 'opacity' ? Math.max(0, Math.min(1, value)) : key === 'scale' ? Math.max(0.01, Math.min(16, value)) : key === 'width' || key === 'height' ? Math.max(1, Math.min(16384, Math.round(value))) : value;
      updateClip(clip.id, { transform: { ...clip.transform!, [key]: next } });
    }} /></label>)}
  </section>;
}

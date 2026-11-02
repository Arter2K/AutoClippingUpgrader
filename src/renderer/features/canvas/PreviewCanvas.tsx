import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { motion } from 'framer-motion';
import { Film, Grid2X2, Magnet, ScanLine, Upload, LoaderCircle, X, ZoomIn } from 'lucide-react';
import { useEditorStore, loadSource, task } from '../../stores/editor-store';
import { Button } from '../../components/ui/button';
import { mainGeometry, overlayAlpha, snapPosition, type Rect } from '../../../shared/geometry';
import type { Overlay } from '../../../shared/template';
import { drawRichText, transformedBounds } from '../../lib/rich-text-canvas';
import { bccSettings, chromaSettings, effectiveScale, resolvedTextStyle } from '../../../shared/layer-effects';
import { averagePixelColor } from '../../../shared/bcc-chroma';
import { BccLayerRenderer } from '../../lib/bcc-layer-renderer';
import { useTimelineStore } from '../../stores/timeline-store';
import { applyChromaKey } from '../../lib/chroma-key';
import { TimelinePreview, advanceTimeline } from '../../lib/timeline-preview';

type Visual = HTMLImageElement | HTMLVideoElement;
const fontName = (id: string) => `acu_${id.replace(/[^a-zA-Z0-9]/g, '_')}`;
export function PreviewCanvas() {
  const source = useEditorStore(s => s.source), template = useEditorStore(s => s.template), assets = useEditorStore(s => s.assets);
  const playing = useEditorStore(s => s.playing), muted = useEditorStore(s => s.muted), grid = useEditorStore(s => s.grid), snap = useEditorStore(s => s.snap);
  const zoom = useEditorStore(s => s.zoom), revision = useEditorStore(s => s.revision), loading = useEditorStore(s => s.loading);
  const selectedId = useEditorStore(s => s.selectedId), picking = useEditorStore(s => s.pickingColorFor);
  const canvas = useRef<HTMLCanvasElement>(null), video = useRef<HTMLVideoElement>(null), viewport = useRef<HTMLDivElement>(null);
  const visuals = useRef(new Map<string, Visual>()), boxes = useRef(new Map<string, Rect>());
  const keyedCanvases = useRef(new Map<string, HTMLCanvasElement>());
  const bccRenderers = useRef(new Map<string, BccLayerRenderer>());
  useEffect(() => {
    for (const [id, renderer] of bccRenderers.current) if (id !== 'main' && !template.overlays.some(o => o.id === id)) { renderer.dispose(); bccRenderers.current.delete(id); }
  }, [template.overlays]);
  useEffect(() => () => { for (const renderer of bccRenderers.current.values()) renderer.dispose(); }, []);
  const timelinePreview = useRef<TimelinePreview | null>(null);
  useEffect(() => { timelinePreview.current = new TimelinePreview(); return () => { timelinePreview.current?.dispose(); timelinePreview.current = null; }; }, []);
  const [size, setSize] = useState({ width: 600, height: 600 }), [videoError, setVideoError] = useState(false);
  const [reference, setReference] = useState<{ url: string; revision: number; time: number } | null>(null), [checking, setChecking] = useState(false);
  const requestIndex = useRef(0);
  const drag = useRef<{ id: string; startX: number; startY: number; positionX: number; positionY: number; box: Rect;
    width: number; height: number; scale: number; resize: boolean; moved: boolean } | null>(null);
  const fit = Math.min(Math.max(120, size.width - 80) / template.canvas.width, Math.max(160, size.height - 64) / template.canvas.height);
  const scale = fit * zoom, width = template.canvas.width * scale, height = template.canvas.height * scale;
  useEffect(() => {
    const el = viewport.current; if (!el) return;
    const observer = new ResizeObserver(entries => { const r = entries[0]?.contentRect; if (r) setSize({ width: r.width, height: r.height }); });
    observer.observe(el); return () => observer.disconnect();
  }, []);
  useEffect(() => { setVideoError(false); setReference(null); }, [source?.id]);
  useEffect(() => { setReference(null); }, [revision, picking]);
  useEffect(() => {
    const active = new Set<string>();
    for (const o of template.overlays) {
      if (o.type === 'text') {
        const url = assets[o.style.font_file]; if (!url) continue;
        const style = resolvedTextStyle(o); const key = `font:${o.id}:${url}:${style.font_weight}:${style.italic}`; active.add(key);
        if (!visuals.current.has(key)) {
          // The placeholder marks a font load as requested; no font path is fetched outside the registry.
          visuals.current.set(key, new Image());
          const font = new FontFace(fontName(o.id), `url("${url}")`, { weight: style.font_weight, style: style.italic ? 'italic' : 'normal' });
          void font.load().then(loaded => document.fonts.add(loaded)).catch(() => {});
        }
      } else {
        const url = assets[o.source_path]; if (!url) continue;
        const key = `${o.id}:${url}`; active.add(key);
        if (!visuals.current.has(key)) {
          const el = o.type === 'video' ? document.createElement('video') : new Image();
          el.crossOrigin = 'anonymous';
          if (el instanceof HTMLVideoElement) { el.muted = true; el.loop = true; el.preload = 'auto'; el.playsInline = true; }
          el.src = url; visuals.current.set(key, el);
        }
      }
    }
    for (const [key, el] of visuals.current) if (!active.has(key)) {
      if (el instanceof HTMLVideoElement) { el.pause(); el.removeAttribute('src'); el.load(); }
      visuals.current.delete(key);
    }
  }, [template.overlays, assets]);
  useEffect(() => () => { for (const el of visuals.current.values()) if (el instanceof HTMLVideoElement) { el.pause(); el.removeAttribute('src'); el.load(); } }, []);
  useEffect(() => {
    const v = video.current; if (!v || !source) return;
    if (useEditorStore.getState().template.timeline) { v.pause(); v.muted = true; return; }
    v.muted = muted;
    if (playing) {
      const s = useEditorStore.getState();
      if (v.currentTime < s.trim.inSec || v.currentTime >= s.trim.outSec - 0.02) v.currentTime = s.trim.inSec;
      void v.play().catch(() => { useEditorStore.setState({ playing: false }); });
    } else v.pause();
  }, [playing, source, muted]);
  useEffect(() => useEditorStore.subscribe((state, previous) => {
    if (state.playhead !== previous.playhead) setReference(null);
    if (!state.template.timeline && state.playhead !== previous.playhead && !state.playing && video.current && Math.abs(video.current.currentTime - state.playhead) > 0.012)
      video.current.currentTime = state.playhead;
  }), []);
  useEffect(() => {
    let raf = 0, lastTime = 0, clockTime = 0;
    const draw = (now: number) => {
      const element = canvas.current, v = video.current, state = useEditorStore.getState();
      if (!element) return;
      const ctx = element.getContext('2d'); if (!ctx) return;
      const t = state.template, w = t.canvas.width, h = t.canvas.height;
      const dpr = Math.min(window.devicePixelRatio || 1, 2), pixelWidth = Math.round(width * dpr), pixelHeight = Math.round(height * dpr);
      if (element.width !== pixelWidth || element.height !== pixelHeight) { element.width = pixelWidth; element.height = pixelHeight; }
      ctx.setTransform(pixelWidth / w, 0, 0, pixelHeight / h, 0, 0); ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = t.canvas.background_color; ctx.fillRect(0, 0, w, h); boxes.current.clear();
      if (t.timeline) {
        if (state.playing && clockTime) useEditorStore.setState({ playhead: advanceTimeline(t, state.playhead, Math.min(0.25, (now - clockTime) / 1000)) });
        timelinePreview.current?.draw(ctx, t, state.assets, useEditorStore.getState().playhead, state.playing, state.muted, boxes.current, state.pickingColorFor);
      } else timelinePreview.current?.dispose();
      clockTime = state.playing ? now : 0;
      if (!t.timeline && v && state.source && v.readyState >= 2) {
        if (state.playing) {
          if (v.currentTime >= state.trim.outSec - 0.01) { v.currentTime = state.trim.inSec; }
          if (now - lastTime > 33) { useEditorStore.setState({ playhead: v.currentTime }); lastTime = now; }
        }
        const mainKey=t.main_clip_layout.background_removal;
        if (!mainKey?.enabled && t.main_clip_layout.source_aspect_handling === 'blur_pad' && t.main_clip_layout.background_blur.enabled) {
          const sw = v.videoWidth, sh = v.videoHeight, r = Math.max(w / sw, h / sh), cw = w / r, ch = h / r;
          ctx.save(); ctx.filter = `blur(${t.main_clip_layout.background_blur.luma_radius * pixelWidth / w}px) brightness(${Math.max(0, 1 + t.main_clip_layout.background_blur.brightness)})`;
          ctx.drawImage(v, (sw - cw) / 2, (sh - ch) / 2, cw, ch, -12, -12, w + 24, h + 24); ctx.restore();
        }
        const g = mainGeometry(t, v.videoWidth, v.videoHeight), s = g.source, d = g.target;
        try {
          if(mainKey?.enabled){let renderer=bccRenderers.current.get('main');if(!renderer){renderer=new BccLayerRenderer();bccRenderers.current.set('main',renderer);}renderer.drawCropped(ctx,v,mainKey,g,state.pickingColorFor==='main');}
          else ctx.drawImage(v, s.x, s.y, s.width, s.height, d.x, d.y, d.width, d.height);
        } catch { /* Wait for decoded media. */ }
      }
      if (!t.timeline) boxes.current.set('main', { ...t.main_clip_layout.Position });
      const relative = state.playhead - state.trim.inSec, duration = state.trim.outSec - state.trim.inSec;
      for (const o of (t.timeline ? [] : [...t.overlays].sort((a, b) => a.z_index - b.z_index))) {
        const alpha = overlayAlpha(o, relative, duration);
        ctx.save(); ctx.globalAlpha = alpha;
        if (o.type === 'text') {
          boxes.current.set(o.id, drawRichText(ctx, o, fontName(o.id), relative, duration));
        } else {
          const rect = { ...o.position, width: o.position.width * effectiveScale(o), height: o.position.height * effectiveScale(o) };
          const angle = o.position.rotation ?? 0;
          boxes.current.set(o.id, transformedBounds({ x: -rect.width / 2, y: -rect.height / 2, width: rect.width, height: rect.height }, rect.x + rect.width / 2, rect.y + rect.height / 2, 1, angle));
          ctx.translate(rect.x + rect.width / 2, rect.y + rect.height / 2); ctx.rotate(angle * Math.PI / 180); ctx.translate(-rect.x - rect.width / 2, -rect.y - rect.height / 2);
          const visual = visuals.current.get(`${o.id}:${state.assets[o.source_path]}`);
          if (visual instanceof HTMLVideoElement) {
            const start = o.timing.full_duration ? 0 : o.timing.start_offset_sec;
            const target = Math.max(0, relative - start) % (visual.duration || Infinity);
            if (Number.isFinite(target) && Math.abs(visual.currentTime - target) > 0.12 && !visual.seeking) visual.currentTime = target;
            if (state.playing && alpha > 0) { if (visual.paused) void visual.play().catch(() => {}); } else visual.pause();
          }
          const ready = visual instanceof HTMLVideoElement ? visual.readyState >= 2 : visual instanceof HTMLImageElement && visual.complete && visual.naturalWidth > 0;
          if (alpha > 0 && visual && ready) try {
            const keySettings = chromaSettings(o);
            const bcc = bccSettings(o);
            if (bcc) {
              let renderer = bccRenderers.current.get(o.id); if (!renderer) { renderer = new BccLayerRenderer(); bccRenderers.current.set(o.id, renderer); }
              renderer.draw(ctx, visual, bcc, rect, state.pickingColorFor === o.id);
            } else if (keySettings && state.pickingColorFor !== o.id) {
              let keyed = keyedCanvases.current.get(o.id);
              if (!keyed) { keyed = document.createElement('canvas'); keyedCanvases.current.set(o.id, keyed); }
              const keyWidth = Math.max(1, Math.round(Math.min(512, rect.width))), keyHeight = Math.max(1, Math.round(Math.min(512, rect.height * keyWidth / rect.width)));
              if (keyed.width !== keyWidth || keyed.height !== keyHeight) { keyed.width = keyWidth; keyed.height = keyHeight; }
              const keyContext = keyed.getContext('2d', { willReadFrequently: true })!;
              keyContext.clearRect(0, 0, keyWidth, keyHeight); keyContext.drawImage(visual, 0, 0, keyWidth, keyHeight);
              const pixels = keyContext.getImageData(0, 0, keyWidth, keyHeight);
              applyChromaKey(pixels.data, keySettings, !!o.chroma_key); keyContext.putImageData(pixels, 0, 0);
              ctx.drawImage(keyed, rect.x, rect.y, rect.width, rect.height);
            } else ctx.drawImage(visual, rect.x, rect.y, rect.width, rect.height);
          } catch { /* Wait for a decoded frame; exact frame rendering remains available. */ }
        }
        ctx.restore();
      }
      const line = 1 / Math.max(scale, 0.01);
      if (state.grid && !state.pickingColorFor) {
        ctx.save(); ctx.lineWidth = line; ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.setLineDash([3 * line, 4 * line]);
        for (let i = 1; i <= 2; i++) { ctx.beginPath(); ctx.moveTo(w * i / 3, 0); ctx.lineTo(w * i / 3, h); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0, h * i / 3); ctx.lineTo(w, h * i / 3); ctx.stroke(); }
        ctx.strokeRect(w * 0.06, h * 0.08, w * 0.88, h * 0.82); ctx.restore();
      }
      const box = boxes.current.get(state.selectedId), layer = t.overlays.find(o => o.id === state.selectedId);
      if (box && state.source && !state.pickingColorFor) {
        ctx.save(); ctx.strokeStyle = '#a5a7ff'; ctx.lineWidth = line; ctx.strokeRect(box.x, box.y, box.width, box.height);
        if (!layer?.locked) {
          ctx.fillStyle = '#ffffff'; const n = 6 * line;
          for (const [x, y] of [[box.x, box.y], [box.x + box.width, box.y], [box.x, box.y + box.height], [box.x + box.width, box.y + box.height]]) ctx.fillRect(x! - n / 2, y! - n / 2, n, n);
        }
        ctx.restore();
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw); return () => cancelAnimationFrame(raf);
  }, [width, height, scale, source?.id]);
  const point = (event: PointerEvent<HTMLCanvasElement>) => {
    const r = event.currentTarget.getBoundingClientRect(); return { x: (event.clientX - r.left) / scale, y: (event.clientY - r.top) / scale };
  };
  const pointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    const pickingState = useEditorStore.getState();
    if (pickingState.pickingColorFor) {
      const el = event.currentTarget, r = el.getBoundingClientRect();
      try {
        const x = Math.max(0, Math.floor((event.clientX - r.left) * el.width / r.width) - 1), y = Math.max(0, Math.floor((event.clientY - r.top) * el.height / r.height) - 1);
        const pixel = el.getContext('2d')!.getImageData(x, y, Math.min(3, el.width - x), Math.min(3, el.height - y)).data;
        pickingState.pickColor(pickingState.pickingColorFor, averagePixelColor(pixel));
      } catch (error) { pickingState.notify(String(error), 'error'); }
      return;
    }
    if (!source || reference) return;
    const p = point(event), s = useEditorStore.getState(), currentBox = boxes.current.get(s.selectedId);
    const resize = currentBox && Math.hypot(p.x - currentBox.x - currentBox.width, p.y - currentBox.y - currentBox.height) < 12 / scale;
    const ids = [...s.template.overlays].filter(o => o.enabled !== false && overlayAlpha(o, s.playhead - s.trim.inSec, s.trim.outSec - s.trim.inSec) > 0)
      .sort((a, b) => b.z_index - a.z_index).map(o => o.id).concat('main');
    const id = resize ? s.selectedId : ids.find(id => { const b = boxes.current.get(id); return b && p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height; });
    if (!id) return; useTimelineStore.getState().selectClip(null); s.select(id);
    const o = s.template.overlays.find(o => o.id === id); if (o?.locked) return;
    const pos = o?.position ?? s.template.main_clip_layout.Position, box = boxes.current.get(id)!;
    drag.current = { id, startX: p.x, startY: p.y, positionX: pos.x, positionY: pos.y, box: { ...box },
      width: 'width' in pos ? pos.width : box.width, height: 'height' in pos ? pos.height : box.height, scale: o ? effectiveScale(o) : 1, resize: !!resize, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId); useEditorStore.setState({ playing: false });
  };
  const pointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current; if (!d) return; const p = point(event), dx = p.x - d.startX, dy = p.y - d.startY;
    if (!d.moved && Math.hypot(dx, dy) < 2 / scale) return;
    const store = useEditorStore.getState(); if (!d.moved) { store.checkpoint(); d.moved = true; }
    if (d.resize) {
      if (d.id === 'main') store.change(t => { t.main_clip_layout.Position.width = Math.max(2, Math.round(d.width + dx)); t.main_clip_layout.Position.height = Math.max(2, Math.round(d.height + dy)); }, false);
      else store.updateOverlay(d.id, o => { if (o.type === 'text') o.scale = Math.max(0.05, Math.min(16, d.scale / (o.position.scale ?? 1) * (d.box.width + dx) / d.box.width));
        else { o.position.width = Math.max(1, Math.round(d.width + dx / d.scale)); o.position.height = Math.max(1, Math.round(d.height + dy / d.scale)); } }, false);
    } else {
      let target = { x: d.box.x + dx, y: d.box.y + dy };
      if (store.snap) target = snapPosition(target.x, target.y, d.box.width, d.box.height, template.canvas.width, template.canvas.height, 7 / scale);
      const x = Math.round(target.x + d.positionX - d.box.x), y = Math.round(target.y + d.positionY - d.box.y);
      if (d.id === 'main') store.change(t => { t.main_clip_layout.Position.x = x; t.main_clip_layout.Position.y = y; }, false);
      else store.updateOverlay(d.id, o => { o.position.x = x; o.position.y = y; }, false);
    }
  };
  const checkFrame = () => task(async () => {
    if (!source) return; useEditorStore.setState({ playing: false }); setChecking(true);
    const number = ++requestIndex.current, state = useEditorStore.getState();
    try {
      const time = state.template.timeline ? Math.max(0, Math.min(state.template.timeline.total_duration_sec - 1 / state.template.canvas.fps, state.playhead)) : Math.min(state.trim.outSec - state.trim.inSec - 1 / state.template.canvas.fps, Math.max(0, state.playhead - state.trim.inSec));
      const url = await window.desktop.editor.preview(source.id, state.template, state.trim, Math.max(0, time));
      if (number === requestIndex.current && state.revision === useEditorStore.getState().revision && state.playhead === useEditorStore.getState().playhead) setReference({ url, revision: state.revision, time: state.playhead });
    } catch (error) { if (number === requestIndex.current) throw error;
    } finally { if (number === requestIndex.current) setChecking(false); }
  });
  void selectedId;
  return <div className="preview-panel">
    <div className="preview-toolbar"><div className="preview-label"><span className={`status-dot ${reference ? 'green' : ''}`} />{reference ? 'FFMPEG REFERENCE' : 'LIVE PREVIEW'}</div>
      <div className="toolbar-buttons"><Button size="icon" variant="ghost" title="Сетка и безопасные зоны (G)" aria-label="Сетка" className={grid ? 'is-active' : ''} onClick={() => useEditorStore.setState({ grid: !grid })}><Grid2X2 size={15} /></Button>
        <Button size="icon" variant="ghost" title="Привязка к центру и краям" aria-label="Привязка" className={snap ? 'is-active' : ''} onClick={() => useEditorStore.setState({ snap: !snap })}><Magnet size={15} /></Button>
        <span className="toolbar-divider" /><ZoomIn size={13} className="dim" /><select aria-label="Масштаб холста" className="zoom-select" value={zoom} onChange={e => useEditorStore.setState({ zoom: Number(e.target.value) })}><option value={0.75}>75%</option><option value={1}>Fit</option><option value={1.5}>150%</option><option value={2}>200%</option></select>
        <Button size="sm" variant="outline" disabled={!source || checking} title="Точный кадр через тот же filter_complex, что и экспорт" onClick={checkFrame}>{checking ? <LoaderCircle size={13} className="spin" /> : <ScanLine size={13} />}FFmpeg-кадр</Button>
        {checking && <Button size="icon" variant="ghost" aria-label="Отменить проверку кадра" onClick={() => { requestIndex.current++; setChecking(false); void task(() => window.desktop.editor.cancelPreview()); }}><X size={12} /></Button>}
      </div>
    </div>
    {picking && <div className="picker-banner">Нажмите на цвет на холсте · Esc — отмена</div>}
    <div className="canvas-viewport" ref={viewport}>
      <div className="canvas-wrap" style={{ width, height }}>
        <canvas aria-label="Интерактивный холст" data-testid="preview-canvas" ref={canvas} style={{ width, height, cursor: picking ? 'crosshair' : undefined }} onPointerDown={pointerDown} onPointerMove={pointerMove}
          onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} />
        {reference && <div className="reference-frame"><img src={reference.url} alt="Точный кадр FFmpeg" /><Button size="icon" title="Вернуться к интерактивному холсту" onClick={() => setReference(null)}><X size={15} /></Button></div>}
        {!source && <motion.div className="canvas-empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }}><div className="canvas-empty-glyph"><Film size={27} strokeWidth={1.2} /></div>
          <span className="eyebrow">YOUR NEXT HIGHLIGHT</span><h2>В кадре.<br /><em>Только главное.</em></h2><p>Перетащите клип сюда<br />и соберите свой вертикальный формат.</p>
          <Button variant="default" size="sm" disabled={loading} onClick={() => void loadSource(() => window.desktop.editor.selectSource())}><Upload size={13} />Выбрать видео</Button>
          <small>MP4 · MOV · MKV · WEBM</small></motion.div>}
        {videoError && source && <div className="decoder-error">Этот кодек не поддерживается предпросмотром браузера. Используйте FFmpeg-кадр; экспорт доступен.</div>}
      </div>
      <span className="canvas-size-label">{template.canvas.width} × {template.canvas.height} <i /> {template.canvas.aspect_ratio}</span>
    </div>
    {source && <video ref={video} className="source-decoder" key={source.id} src={source.url} crossOrigin="anonymous" playsInline preload="auto" muted={muted}
      onLoadedData={() => { if (video.current) video.current.currentTime = useEditorStore.getState().playhead; }} onError={() => setVideoError(true)}
      onEnded={() => { const state = useEditorStore.getState(), v = video.current; if (state.playing && v) { v.currentTime = state.trim.inSec; void v.play().catch(() => useEditorStore.setState({ playing: false })); } }} />}
    {loading && <div className="media-loading"><LoaderCircle className="spin" size={23} /><span>Подготавливаем клип и кадры…</span></div>}
  </div>;
}

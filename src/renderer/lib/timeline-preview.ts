import type { Template, Overlay } from '../../shared/template';
import { clipGain, timelineDuration } from '../../shared/timeline';
import { mainGeometry, overlayAlpha, type Rect } from '../../shared/geometry';
import { chromaSettings, effectiveScale } from '../../shared/layer-effects';
import { BccLayerRenderer } from './bcc-layer-renderer';
import { videoBackgroundConfig, mainPickerTarget } from '../../shared/video-effects';
import { drawRichText } from './rich-text-canvas';
import { applyChromaKey } from './chroma-key';

interface Decoder { url: string; element: HTMLVideoElement | HTMLImageElement; gain?: GainNode; source?: MediaElementAudioSourceNode; keyed?: HTMLCanvasElement; bcc?: BccLayerRenderer }
/** One decoder per segment: overlapping uses of one source remain independent. */
export class TimelinePreview {
  private decoders = new Map<string, Decoder>();
  private audio: AudioContext | null = null;
  draw(ctx: CanvasRenderingContext2D, template: Template, assets: Record<string, string>, time: number, playing: boolean, muted: boolean, boxes: Map<string, Rect>, picking: string | null) {
    const timeline = template.timeline; if (!timeline) return;
    const active = new Set<string>();
    if (playing && this.audio?.state === 'suspended') void this.audio.resume().catch(() => {});
    for (const track of [...timeline.tracks].sort((a, b) => a.order_index - b.order_index)) for (const clip of track.clips) {
      if (clip.enabled === false) continue;
      const o = template.overlays.find(o => o.id === clip.overlay_id), local = time - clip.timeline_start_sec;
      const inRange = local >= 0 && local < clip.duration_sec, visible = track.type === 'video' && track.is_visible && o?.enabled !== false && inRange;
      const url = assets[clip.source_path];
      let decoder = this.decoders.get(clip.id);
      if (clip.media_type !== 'text' && url) {
        if (inRange || (playing && local > -1 && local < 0)) active.add(clip.id);
        if (decoder && decoder.url !== url) { this.release(decoder); this.decoders.delete(clip.id); decoder = undefined; }
        if (!decoder && (inRange || (playing && local > -1 && local < 0))) {
          const element = clip.media_type === 'image' ? new Image() : document.createElement('video');
          element.crossOrigin = 'anonymous';
          decoder = { url, element };
          if (element instanceof HTMLVideoElement) {
            element.preload = 'auto'; element.playsInline = true;
            try {
              this.audio ??= new AudioContext();
              const source = this.audio.createMediaElementSource(element), gain = this.audio.createGain();
              gain.gain.value = 0; source.connect(gain).connect(this.audio.destination); decoder.gain = gain; decoder.source = source;
            } catch { element.muted = true; }
          }
          element.src = url; this.decoders.set(clip.id, decoder);
        }
        if (decoder?.element instanceof HTMLVideoElement) {
          const video = decoder.element;
          const target = clip.source_in_sec + Math.max(0, Math.min(clip.duration_sec - 0.001, local));
          if (inRange && video.readyState >= 1 && !video.seeking && Math.abs(video.currentTime - target) > (playing ? 0.15 : 0.012)) video.currentTime = target;
          if (decoder.gain) decoder.gain.gain.value = muted ? 0 : clipGain(clip, track, timeline, time);
          if (playing && inRange) { if (video.paused) void video.play().catch(() => {}); } else video.pause();
        }
      }
      if (!visible) continue;
      ctx.save();
      if (o?.type === 'text') {
        const copy = structuredClone(o); copy.timing.full_duration = true;
        if (clip.transform) { copy.position.x = clip.transform.x; copy.position.y = clip.transform.y; copy.scale = clip.transform.scale; copy.opacity = clip.transform.opacity; }
        const box = drawRichText(ctx, copy, `acu_${o.id.replace(/[^a-zA-Z0-9]/g, '_')}`, local, clip.duration_sec);
        boxes.set(o.id, box); ctx.restore(); continue;
      }
      const visual = decoder?.element;
      const ready = visual instanceof HTMLVideoElement ? visual.readyState >= 2 : visual?.complete && visual.naturalWidth > 0;
      if (visual && ready) {
        if (clip.use_template_main_layout && visual instanceof HTMLVideoElement) {
          const w = template.canvas.width, h = template.canvas.height, blur = template.main_clip_layout.background_blur;
          const mainKey=videoBackgroundConfig(template,clip),keyed=mainKey?.enabled;
          if (!keyed && template.main_clip_layout.source_aspect_handling === 'blur_pad' && blur.enabled) {
            const r = Math.max(w / visual.videoWidth, h / visual.videoHeight), sw = w / r, sh = h / r;
            ctx.save(); ctx.filter = `blur(${blur.luma_radius}px) brightness(${Math.max(0, 1 + blur.brightness)})`;
            ctx.drawImage(visual, (visual.videoWidth - sw) / 2, (visual.videoHeight - sh) / 2, sw, sh, 0, 0, w, h); ctx.restore();
          } else if(!keyed) { ctx.fillStyle = template.canvas.background_color; ctx.fillRect(0, 0, w, h); }
          const geometry = mainGeometry(template, visual.videoWidth, visual.videoHeight), s = geometry.source, d = geometry.target;
          if(keyed && decoder) {decoder.bcc??=new BccLayerRenderer();decoder.bcc.drawCropped(ctx,visual,mainKey,geometry,picking==='main'||picking===mainPickerTarget(clip));}
          else ctx.drawImage(visual, s.x, s.y, s.width, s.height, d.x, d.y, d.width, d.height);
          boxes.set('main', { ...template.main_clip_layout.Position });
        } else {
          const mediaOverlay = o ?? null;
          const p = clip.transform ?? (mediaOverlay ? { ...mediaOverlay.position, scale: effectiveScale(mediaOverlay), opacity: mediaOverlay.opacity } : { x: 0, y: 0, width: template.canvas.width, height: template.canvas.height, scale: 1, opacity: 1 });
          const rect = { x: p.x, y: p.y, width: p.width * p.scale, height: p.height * p.scale };
          const copy = mediaOverlay ? { ...mediaOverlay, timing: { ...mediaOverlay.timing, full_duration: true } } as Overlay : null;
          ctx.globalAlpha = copy ? overlayAlpha(copy, local, clip.duration_sec) * (clip.transform ? p.opacity / Math.max(copy.opacity, 0.0001) : 1) : p.opacity;
          const angle = mediaOverlay?.position.rotation ?? 0;
          ctx.translate(rect.x + rect.width / 2, rect.y + rect.height / 2); ctx.rotate(angle * Math.PI / 180); ctx.translate(-rect.x - rect.width / 2, -rect.y - rect.height / 2);
          const key = mediaOverlay && picking !== mediaOverlay.id ? chromaSettings(mediaOverlay) : null;
          const background=videoBackgroundConfig(template,clip,mediaOverlay??undefined);
          const bcc=background?.enabled?background:null;
          if (bcc && decoder) {
            decoder.bcc ??= new BccLayerRenderer(); decoder.bcc.draw(ctx, visual, bcc, rect, picking === mediaOverlay?.id || picking===mainPickerTarget(clip));
          } else if (key && decoder) {
            decoder.keyed ??= document.createElement('canvas'); const canvas = decoder.keyed;
            const w = Math.max(1, Math.round(Math.min(512, rect.width))), h = Math.max(1, Math.round(rect.height * w / rect.width));
            if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
            const c = canvas.getContext('2d', { willReadFrequently: true })!; c.clearRect(0, 0, w, h); c.drawImage(visual, 0, 0, w, h);
            const pixels = c.getImageData(0, 0, w, h); applyChromaKey(pixels.data, key, !!mediaOverlay?.chroma_key); c.putImageData(pixels, 0, 0);
            ctx.drawImage(canvas, rect.x, rect.y, rect.width, rect.height);
          } else ctx.drawImage(visual, rect.x, rect.y, rect.width, rect.height);
          if (o) boxes.set(o.id, rect);
        }
      }
      ctx.restore();
    }
    for (const [id, decoder] of this.decoders) if (!active.has(id)) { this.release(decoder); this.decoders.delete(id); }
  }
  private release(decoder: Decoder) {
    decoder.bcc?.dispose();
    if (decoder.element instanceof HTMLVideoElement) { decoder.element.pause(); decoder.element.removeAttribute('src'); decoder.element.load(); decoder.source?.disconnect(); decoder.gain?.disconnect(); }
  }
  dispose() { for (const decoder of this.decoders.values()) this.release(decoder); this.decoders.clear(); void this.audio?.close(); this.audio = null; }
}

export function advanceTimeline(template: Template, time: number, deltaSec: number): number {
  const duration = template.timeline ? timelineDuration(template.timeline) : 0;
  return duration > 0 ? (time + deltaSec) % duration : 0;
}

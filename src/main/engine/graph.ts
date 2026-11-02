import path from 'node:path';
import type { Template, Overlay } from '../../shared/template';
import { bccSettings, chromaFilter, chromaSettings, effectiveScale, spillType } from '../../shared/layer-effects';
import { buildBccKey, buildLightWrap, layerAlphaFilters } from './bcc-chroma';
import { generateAss, isRichText } from './ass';
import { audioTrackActive, clipHasAudio, timelineDuration, type TimelineClip } from '../../shared/timeline';

export interface SupportFile { name: string; content: string }
export interface AssetCopy { name: string; sourcePath: string }
export interface GraphResult { graph: string; inputArgs: string[]; files: SupportFile[]; assetPaths: string[]; assetCopies: AssetCopy[]; hasAudio?: boolean }
const num = (v: number) => String(Number(v.toFixed(6)));
const rgb = (v: string) => v.replace('#', '0x');

function shadowColor(value: string): string {
  if (value.startsWith('#')) return rgb(value);
  const values = value.match(/[\d.]+/g)!.map(Number);
  if (values.slice(0, 3).some(n => n > 255)) throw new Error('Invalid RGB shadow color');
  return `0x${values.slice(0, 3).map(n => n.toString(16).padStart(2, '0')).join('')}@${values[3]}`;
}

export function overlayWindow(o: Overlay, duration: number): { start: number; end: number } {
  const start = o.timing.full_duration ? 0 : o.timing.start_offset_sec;
  const end = o.timing.full_duration ? duration : (o.timing.end_offset_sec ?? duration);
  if (start >= end || end > duration + 0.000001 || start >= duration)
    throw new Error(`Invalid timing for overlay ${o.id}: must lie within trimmed clip`);
  if (!(o.type === 'text' && o.animation) && o.timing.fade_in_sec + o.timing.fade_out_sec > end - start + 0.000001)
    throw new Error(`Fades overlap for overlay ${o.id}`);
  return { start, end };
}

export function buildGraph(t: Template, duration: number, templateDir: string, segment?: TimelineClip, includeAudio = true): GraphResult {
  if (t.timeline && !segment) return buildTimelineGraph(t, templateDir, includeAudio);
  const { width: w, height: h, fps, background_color } = t.canvas;
  const layout = t.main_clip_layout;
  const p = layout.Position;
  const filters: string[] = [];
  const inputArgs: string[] = [];
  const files: SupportFile[] = [];
  const assetPaths: string[] = [];
  const assetCopies: AssetCopy[] = [];
  const asset = (name: string) => {
    const resolved = path.resolve(templateDir, name);
    assetPaths.push(resolved);
    return resolved;
  };
  const onlyOverlay = segment && !segment.use_template_main_layout;
  if (onlyOverlay) {
    filters.push(`color=c=black@0:s=${w}x${h}:r=${fps}:d=${num(duration)},format=rgba[composite0]`);
  } else {
  filters.push(`[0:v]${segment ? `trim=start=${num(segment.source_in_sec)}:end=${num(segment.source_out_sec)}` : `trim=duration=${num(duration)}`},setpts=PTS-STARTPTS,fps=${fps},setsar=1[src]`);
  if (layout.source_aspect_handling === 'blur_pad' && layout.background_blur.enabled) {
    const blur = layout.background_blur;
    filters.push('[src]split=2[foreground][background]');
    // scale_height is a minimum intermediate height; the final canvas always has the requested dimensions.
    const bh = Math.max(h, blur.scale_height);
    const bw = Math.ceil(w * bh / h / 2) * 2;
    filters.push(`[background]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},` +
      `boxblur=luma_radius=${num(Math.min(blur.luma_radius, Math.min(bw, bh) / 4))}:luma_power=${blur.luma_power},` +
      `eq=brightness=${num(blur.brightness)},scale=${w}:${h}[base]`);
  } else {
    filters.push('[src]null[foreground]');
    filters.push(`color=c=${rgb(background_color)}:s=${w}x${h}:r=${fps}:d=${num(duration)}[base]`);
  }
  let main = '[foreground]';
  if (layout.source_aspect_handling === 'custom_crop') {
    const c = layout.source_crop!;
    main += `crop=${c.width}:${c.height}:${num(c.x)}:${num(c.y)},`;
  }
  const cover = layout.source_aspect_handling === 'center_crop' || p.scale_mode === 'cover';
  if (cover) main += `scale=${p.width}:${p.height}:force_original_aspect_ratio=increase,crop=${p.width}:${p.height}`;
  else if (p.scale_mode === 'fit_width') main += `scale=${p.width}:-2`;
  else main += `scale=${p.width}:${p.height}:force_original_aspect_ratio=decrease`;
  filters.push(`${main},setsar=1[main]`);
  // The position rectangle is a bounding box. fit_width is vertically centered in that box.
  filters.push(`[base][main]overlay=x='${num(p.x)}+(${p.width}-w)/2':y='${num(p.y)}+(${p.height}-h)/2':shortest=1[composite0]`);
  }
  let current = 'composite0';
  let inputIndex = onlyOverlay ? 0 : 1;
  const sorted = t.overlays.filter(o => o.enabled !== false).sort((a, b) => a.z_index - b.z_index);
  for (const [i, o] of sorted.entries()) {
    const { start, end } = overlayWindow(o, duration);
    const next = `composite${i + 1}`;
    const enable = `gte(t,${num(start)})*lt(t,${num(end)})`;
    if (o.type === 'text') {
      if (isRichText(o)) {
        const font = `font-${i}.ttf`, ass = `caption-${i}.ass`;
        assetCopies.push({ name: font, sourcePath: asset(o.style.font_file) });
        files.push({ name: ass, content: generateAss(o, w, h, fps, duration, path.resolve(templateDir, o.style.font_file)) });
        filters.push(`[${current}]ass=filename=${ass}:fontsdir=.[${next}]`);
        current = next; continue;
      }
      const file = `caption-${i}.txt`;
      files.push({ name: file, content: o.text_content });
      const font = `font-${i}.ttf`;
      assetCopies.push({ name: font, sourcePath: asset(o.style.font_file) });
      const s = o.style;
      const x = o.position.anchor === 'center' ? `${num(o.position.x)}-text_w/2` : num(o.position.x);
      const y = o.position.anchor === 'center' ? `${num(o.position.y)}-text_h/2` : num(o.position.y);
      const alpha = [num(o.opacity)];
      if (o.timing.fade_in_sec) alpha.push(`min(1,max(0,(t-${num(start)})/${num(o.timing.fade_in_sec)}))`);
      if (o.timing.fade_out_sec) alpha.push(`min(1,max(0,(${num(end)}-t)/${num(o.timing.fade_out_sec)}))`);
      filters.push(`[${current}]drawtext=textfile=${file}:expansion=none:fontfile=${font}:` +
        `fontsize=${num(s.font_size * o.scale)}:fontcolor=${rgb(s.font_color)}:bordercolor=${rgb(s.stroke_color)}:` +
        `borderw=${num(s.stroke_width * o.scale)}:shadowcolor=${shadowColor(s.shadow_color)}:` +
        `shadowx=${num(s.shadow_x)}:shadowy=${num(s.shadow_y)}:x='${x}':y='${y}':alpha='${alpha.join('*')}':enable='${enable}'[${next}]`);
    } else {
      const source = asset(o.source_path);
      // image2 -loop handles still images; stream_loop preserves animation for GIF/WebP and video.
      const animated = /\.(gif|webp)$/i.test(source);
      if (segment && o.type === 'video') inputArgs.push('-i', source);
      else inputArgs.push(...(o.type === 'image' && !animated ? ['-loop', '1'] : ['-stream_loop', '-1']), '-i', source);
      const ow = Math.max(1, Math.round(o.position.width * effectiveScale(o)));
      const oh = Math.max(1, Math.round(o.position.height * effectiveScale(o)));
      const chain = [`[${inputIndex++}:v]${segment ? `trim=start=${num(segment.source_in_sec)}:end=${num(segment.source_out_sec)},` : ''}setpts=PTS-STARTPTS`, `fps=${fps}`, `trim=duration=${num(end - start)}`,
        `scale=${ow}:${oh}`, 'format=rgba'];
      const key = chromaSettings(o);
      const bcc = bccSettings(o);
      if (bcc) {
        const keyed = buildBccKey(chain.join(','), `bcc${i}_`, bcc);
        filters.push(...keyed.filters); chain.splice(0, chain.length, `${keyed.output}null`, 'format=rgba');
      } else if (key) {
        filters.push(`${chain.join(',')},split=2[keyraw${i}][original${i}]`);
        filters.push(`[original${i}]alphaextract[oa${i}]`);
        const filter = o.background_removal ? chromaFilter(key.key_color) : 'colorkey';
        filters.push(`[keyraw${i}]${filter === 'chromakey' ? 'format=yuva444p,' : ''}${filter}=color=${rgb(key.key_color)}:similarity=${num(key.similarity)}:blend=${num(key.blend)},format=rgba,split=2[keycolor${i}][keyalpha${i}]`);
        filters.push(`[keyalpha${i}]alphaextract[ka${i}]`);
        filters.push(`[oa${i}][ka${i}]blend=all_expr='A*B/255'[combinedalpha${i}]`);
        filters.push(`[keycolor${i}]format=rgb24[keyrgb${i}]`);
        chain.splice(0, chain.length, `[keyrgb${i}][combinedalpha${i}]alphamerge`, 'format=rgba');
        if (key.despill) {
          const type = spillType(key.key_color);
          chain.push(`despill=type=${type}:red=0:green=${type === 'green' ? -1 : 0}:blue=${type === 'blue' ? -1 : 0}`);
        }
      }
      const deferredAlpha = bcc?.light_wrap.enabled && bcc.light_wrap.intensity > 0;
      if (!deferredAlpha) chain.push(layerAlphaFilters(o.opacity, 0, end - start, o.timing.fade_in_sec, o.timing.fade_out_sec));
      if (o.position.rotation) {
        const angle = num(o.position.rotation * Math.PI / 180);
        chain.push(`rotate=${angle}:ow=rotw(${angle}):oh=roth(${angle}):c=none`);
      }
      chain.push(`setpts=PTS+${num(start)}/TB[ov${i}]`);
      filters.push(chain.join(','));
      if (bcc?.light_wrap.enabled && bcc.light_wrap.intensity > 0 && !segment) {
        filters.push(`color=c=black@0:s=${w}x${h}:r=${fps}:d=${num(duration)},format=rgba[bccCanvas${i}]`,
          `[bccCanvas${i}][ov${i}]overlay=x='${num(o.position.x)}+(${ow}-w)/2':y='${num(o.position.y)}+(${oh}-h)/2':enable='${enable}':eof_action=pass:repeatlast=0:format=auto[bccPlaced${i}]`);
        const wrap = buildLightWrap(`[bccPlaced${i}]`, `[${current}]`, `wrap${i}_`, bcc); filters.push(...wrap.filters);
        filters.push(`${wrap.foreground}${layerAlphaFilters(o.opacity, start, end, o.timing.fade_in_sec, o.timing.fade_out_sec)}[wrapFaded${i}]`);
        filters.push(`${wrap.background}[wrapFaded${i}]overlay=x=0:y=0:eof_action=pass:repeatlast=0:format=auto[${next}]`);
      } else filters.push(`[${current}][ov${i}]overlay=x='${num(o.position.x)}+(${ow}-w)/2':y='${num(o.position.y)}+(${oh}-h)/2':enable='${enable}':eof_action=pass:repeatlast=0${segment ? ':format=auto' : ''}[${next}]`);
    }
    current = next;
  }
  filters.push(`[${current}]format=${segment ? 'rgba' : 'yuv420p'},setsar=1[vout]`);
  return { graph: filters.join(';\n'), inputArgs, files, assetPaths, assetCopies };
}

/** Compile each segment in local time, then place it on the shared canvas clock. */
function buildTimelineGraph(t: Template, directory: string, includeAudio: boolean): GraphResult {
  const timeline = t.timeline!, duration = timelineDuration(timeline);
  if (duration <= 0) throw new Error('Timeline has no active clips');
  const { width, height, fps, background_color } = t.canvas;
  const filters = [`color=c=${rgb(background_color)}:s=${width}x${height}:r=${fps}:d=${num(duration)}[stage0]`];
  const result: GraphResult = { graph: '', inputArgs: [], files: [], assetPaths: [], assetCopies: [], hasAudio: false };
  let index = 0, stage = 0, serial = 0;
  const audio: string[] = [];
  for (const track of [...timeline.tracks].sort((a, b) => a.order_index - b.order_index)) for (const clip of track.clips) {
    if (clip.enabled === false) continue;
    const overlay = t.overlays.find(o => o.id === clip.overlay_id);
    const visible = track.type === 'video' && track.is_visible && overlay?.enabled !== false;
    const audible = audioTrackActive(track, timeline) && clipHasAudio(clip) && !clip.muted && clip.volume * track.volume > 0;
    if (!visible && !audible) continue;
    const prefix = `seg${serial++}_`, firstInput = index;
    if (visible) {
      const local: Template = { ...t, timeline: undefined, overlays: [] };
      if (!clip.use_template_main_layout) {
        const o: Overlay = overlay ? structuredClone(overlay) : {
          id: clip.id, name: clip.name, type: clip.media_type === 'image' ? 'image' : 'video', source_path: clip.source_path,
          z_index: 0, position: { x: 0, y: 0, width, height }, scale: 1, opacity: 1,
          timing: { full_duration: true, start_offset_sec: 0, end_offset_sec: null, fade_in_sec: 0, fade_out_sec: 0 },
        };
        if (clip.media_type === 'text' && !overlay) throw new Error(`Missing text overlay for ${clip.id}`);
        if (o.type !== 'text') o.source_path = clip.source_path;
        if (clip.transform) { Object.assign(o.position, clip.transform); o.scale = clip.transform.scale; o.opacity = clip.transform.opacity; }
        o.timing = { ...o.timing, full_duration: true, fade_in_sec: Math.min(o.timing.fade_in_sec, clip.duration_sec / 2), fade_out_sec: Math.min(o.timing.fade_out_sec, clip.duration_sec / 2) };
        local.overlays = [o];
      } else { result.inputArgs.push('-i', path.resolve(directory, clip.source_path)); result.assetPaths.push(path.resolve(directory, clip.source_path)); index++; }
      const sub = buildGraph(local, clip.duration_sec, directory, clip);
      // Each subgraph owns its input labels, support filenames and intermediate labels.
      let graph = sub.graph.replace(/\[([^\]]+)\]/g, (_match, label: string) => {
        if (/^\d+:v$/.test(label)) return `[${firstInput + Number(label.split(':')[0])}:v]`;
        return `[${prefix}${label}]`;
      });
      for (const file of [...sub.files, ...sub.assetCopies]) graph = graph.replaceAll(file.name, `${prefix}${file.name}`);
      result.files.push(...sub.files.map(f => ({ ...f, name: prefix + f.name })));
      result.assetCopies.push(...sub.assetCopies.map(f => ({ ...f, name: prefix + f.name })));
      result.assetPaths.push(...sub.assetPaths); result.inputArgs.push(...sub.inputArgs);
      index += sub.inputArgs.filter(arg => arg === '-i').length;
      filters.push(graph, `[${prefix}vout]setpts=PTS-STARTPTS+${num(clip.timeline_start_sec)}/TB[${prefix}placed]`);
      let bg = `[stage${stage}]`, fg = `[${prefix}placed]`;
      const bcc = overlay && overlay.type !== 'text' ? bccSettings(overlay) : null;
      if (bcc?.light_wrap.enabled && bcc.light_wrap.intensity > 0) {
        const wrap = buildLightWrap(fg, bg, `${prefix}wrap_`, bcc); filters.push(...wrap.filters); bg = wrap.background; fg = wrap.foreground;
        const opacity = clip.transform?.opacity ?? overlay?.opacity ?? 1;
        filters.push(`${fg}${layerAlphaFilters(opacity, clip.timeline_start_sec, clip.timeline_start_sec + clip.duration_sec,
          Math.min(overlay?.timing.fade_in_sec ?? 0, clip.duration_sec / 2), Math.min(overlay?.timing.fade_out_sec ?? 0, clip.duration_sec / 2))}[${prefix}faded]`);
        fg = `[${prefix}faded]`;
      }
      filters.push(`${bg}${fg}overlay=x=0:y=0:enable='gte(t,${num(clip.timeline_start_sec)})*lt(t,${num(clip.timeline_start_sec + clip.duration_sec)})':eof_action=pass:repeatlast=0:format=auto[stage${++stage}]`);
    }
    if (audible) {
      // Visible video already has an input; hidden video/audio gets a dedicated input.
      let audioInput = firstInput;
      if (!visible) { audioInput = index++; const file = path.resolve(directory, clip.source_path); result.inputArgs.push('-i', file); result.assetPaths.push(file); }
      if (!includeAudio) continue;
      const name = `${prefix}audio`;
      const chain = [`[${audioInput}:a:0]atrim=start=${num(clip.source_in_sec)}:end=${num(clip.source_out_sec)}`, 'asetpts=PTS-STARTPTS',
        `aresample=${t.render_preset.audio.sample_rate}`, 'aformat=channel_layouts=stereo', `volume=${num(clip.volume * track.volume)}`];
      if (clip.fade_in_sec > 0) chain.push(`afade=t=in:st=0:d=${num(clip.fade_in_sec)}`);
      if (clip.fade_out_sec > 0) chain.push(`afade=t=out:st=${num(clip.duration_sec - clip.fade_out_sec)}:d=${num(clip.fade_out_sec)}`);
      chain.push(`adelay=${num(clip.timeline_start_sec * 1000)}:all=1[${name}]`); filters.push(chain.join(',')); audio.push(`[${name}]`);
    }
  }
  filters.push(`[stage${stage}]format=yuv420p,setsar=1[vout]`);
  if (audio.length) {
    // Rebuild master timestamps from sample count: adelay/amix can propagate AV_NOPTS_VALUE
    // with mixed demuxer time bases (notably WAV + MP4 on FFmpeg 9).
    filters.push(`${audio.join('')}amix=inputs=${audio.length}:duration=longest:dropout_transition=0:normalize=0,asetpts=N/SR/TB,apad,atrim=duration=${num(duration)}${t.render_preset.audio.normalize_loudness ? ',loudnorm=I=-14:TP=-1:LRA=11' : ''}[aout]`);
    result.hasAudio = true;
  }
  result.graph = filters.join(';\n'); return result;
}

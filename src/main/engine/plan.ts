import path from 'node:path';
import { templateSchema, validateTrim, type Template, type Trim, type MediaInfo } from '../../shared/template';
import { estimateFileSize } from '../../shared/estimate';
import { buildGraph, type SupportFile, type AssetCopy } from './graph';
import { encodingArgs } from './encoding';
import { timelineDuration } from '../../shared/timeline';

export interface RenderRequest {
  template: Template;
  templateDir: string;
  inputPath: string;
  outputPath: string;
  trim: Trim;
  media: MediaInfo;
}
export interface RenderCommand { args: string[]; pass: number }
export interface RenderPlan {
  commands: RenderCommand[];
  supportFiles: SupportFile[];
  assetPaths: string[];
  assetCopies: AssetCopy[];
  durationSec: number;
  estimate: ReturnType<typeof estimateFileSize>;
  codec: string;
  warnings: string[];
}

export function buildRenderPlan(request: RenderRequest): RenderPlan {
  const t = templateSchema.parse(request.template);
  const duration = t.timeline ? timelineDuration(t.timeline) : validateTrim(request.trim, request.media.durationSec);
  if (duration <= 0) throw new Error('Timeline has no active clips');
  for (const file of [request.inputPath, request.outputPath]) {
    if (!file || /[\x00-\x1f]/.test(file)) throw new Error('Invalid media path');
  }
  if (!Number.isFinite(request.media.width) || request.media.width <= 0 || !Number.isFinite(request.media.height) || request.media.height <= 0)
    throw new Error('Invalid source dimensions');
  if (path.resolve(request.inputPath).toLowerCase() === path.resolve(request.outputPath).toLowerCase())
    throw new Error('Output must differ from source');
  for (const track of t.timeline?.tracks ?? []) for (const clip of track.clips)
    if (clip.source_path && path.resolve(request.templateDir, clip.source_path).toLowerCase() === path.resolve(request.outputPath).toLowerCase()) throw new Error('Output must differ from every timeline source');
  if (path.extname(request.outputPath).toLowerCase() !== '.mp4') throw new Error('Output must be .mp4');
  const crop = t.main_clip_layout.source_crop;
  if (t.main_clip_layout.source_aspect_handling === 'custom_crop' && crop &&
    (crop.x < 0 || crop.y < 0 || crop.x + crop.width > request.media.width || crop.y + crop.height > request.media.height))
    throw new Error('Source crop exceeds source dimensions');
  const graph = buildGraph(t, duration, request.templateDir);
  const v = t.render_preset.video;
  const a = t.render_preset.audio;
  const common = ['-hide_banner', '-nostdin', '-loglevel', 'info', '-stats_period', '0.25', '-progress', 'pipe:1',
    ...(t.timeline ? [] : ['-ss', String(request.trim.inSec), '-t', String(duration), '-i', path.resolve(request.inputPath)]),
    ...graph.inputArgs, '-/filter_complex', 'filter.ffgraph', '-map', '[vout]',
    ...encodingArgs(v), '-r', String(t.canvas.fps)];
  const hasAudio = t.timeline ? graph.hasAudio : request.media.hasAudio;
  const finalAudio = t.timeline ? (hasAudio ? ['-map', '[aout]', '-c:a', a.codec, '-b:a', `${a.bitrate_kbps}k`, '-ar', String(a.sample_rate)] : ['-an']) : request.media.hasAudio ? ['-map', '0:a:0', '-af',
    `atrim=duration=${duration},asetpts=PTS-STARTPTS,aresample=${a.sample_rate}${a.normalize_loudness ? ',loudnorm=I=-14:TP=-1:LRA=11' : ''}`,
    '-c:a', a.codec, '-b:a', `${a.bitrate_kbps}k`, '-ar', String(a.sample_rate)] : ['-an'];
  const twoPass = v.rate_control === 'vbr_2pass' && !v.codec.endsWith('_nvenc');
  const commands: RenderCommand[] = [];
  // x265 implements its two-pass controls through x265-params; generic -pass is for libx264.
  const passArgs = (pass: number) => v.codec === 'libx265'
    ? ['-x265-params', `pass=${pass}:stats=x265.stats`]
    : ['-pass', String(pass), '-passlogfile', 'video-pass'];
  if (twoPass) commands.push({ pass: 1, args: [...common.map(arg => arg === 'filter.ffgraph' && t.timeline && hasAudio ? 'filter-pass1.ffgraph' : arg), ...passArgs(1), '-an', '-t', String(duration), '-f', 'null', '-'] });
  commands.push({ pass: twoPass ? 2 : 1, args: [...common, ...(twoPass ? passArgs(2) : []), ...finalAudio,
    '-t', String(duration), '-movflags', '+faststart', '-n', path.resolve(request.outputPath)] });
  const warnings: string[] = [];
  if (v.codec.endsWith('_nvenc') && v.rate_control === 'vbr_2pass') warnings.push('NVENC uses per-frame multipass=fullres, not two full file passes.');
  if (v.codec.endsWith('_nvenc') && v.rate_control === 'crf') warnings.push('NVENC CRF maps to VBR CQ; it is not libx264 CRF.');
  if (a.normalize_loudness) warnings.push('Loudness uses single-pass loudnorm; measured two-pass mastering is not enabled.');
  if (v.level !== 'auto') warnings.push('Explicit codec level must accommodate canvas size and FPS; use auto for custom resolutions.');
  return { commands, supportFiles: [{ name: 'filter.ffgraph', content: graph.graph }, ...(twoPass && t.timeline && hasAudio ? [{ name: 'filter-pass1.ffgraph', content: buildGraph(t, duration, request.templateDir, undefined, false).graph }] : []), ...graph.files],
    assetPaths: graph.assetPaths, assetCopies: graph.assetCopies, durationSec: duration, codec: v.codec, warnings,
    estimate: estimateFileSize(v, hasAudio ? a.bitrate_kbps : 0, { inSec: 0, outSec: duration }) };
}

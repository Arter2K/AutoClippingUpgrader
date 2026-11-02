import path from 'node:path';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { buildRenderPlan, type RenderRequest, type RenderPlan } from './plan';
import { probeMedia } from './probe';
import { runProcess } from './process';
import { ProgressParser, type RenderProgress } from './progress';
import { templateSchema } from '../../shared/template';
import { segmentNeedsMedia } from '../../shared/timeline';

export interface RenderOptions {
  ffmpegPath?: string;
  ffprobePath?: string;
  signal?: AbortSignal;
  allowSoftwareFallback?: boolean;
  onProgress?: (progress: RenderProgress) => void;
}
export type RenderInput = Omit<RenderRequest, 'media'>;

export async function renderVideo(input: RenderInput, options: RenderOptions = {}): Promise<RenderPlan> {
  options.signal?.throwIfAborted();
  const ffmpeg = options.ffmpegPath ?? process.env.FFMPEG_PATH ?? 'ffmpeg';
  const template = templateSchema.parse(input.template);
  const media = await probeMedia(input.inputPath, options.ffprobePath, options.signal);
  const checked = new Map<string, Awaited<ReturnType<typeof probeMedia>>>([[path.resolve(input.inputPath), media]]);
  for (const track of template.timeline?.tracks ?? []) for (const clip of track.clips) {
    if (!segmentNeedsMedia(clip, track, template.timeline!)) continue;
    if (clip.media_type === 'text' || clip.media_type === 'image') continue;
    const file = path.resolve(input.templateDir, clip.source_path);
    let info = checked.get(file);
    if (!info) { info = await probeMedia(file, options.ffprobePath, options.signal, clip.media_type === 'audio'); checked.set(file, info); }
    if (clip.source_out_sec > info.durationSec + 0.05) throw new Error(`Segment exceeds source duration: ${clip.name}`);
    if (clip.media_type === 'video' && (!info.width || !info.height)) throw new Error(`No video stream: ${clip.name}`);
    if (clip.media_type === 'audio' && !info.hasAudio) throw new Error(`No audio stream: ${clip.name}`);
    const crop = template.main_clip_layout.source_crop;
    if (clip.use_template_main_layout && template.main_clip_layout.source_aspect_handling === 'custom_crop' && crop &&
      (crop.x < 0 || crop.y < 0 || crop.x + crop.width > info.width || crop.y + crop.height > info.height)) throw new Error(`Source crop exceeds segment dimensions: ${clip.name}`);
    clip.has_audio = info.hasAudio;
  }
  // Validate before invoking an encoder or creating files.
  buildRenderPlan({ ...input, template, media });
  try {
    await access(input.outputPath);
    throw new Error('Output already exists; choose another filename');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const warnings: string[] = [];
  if (template.render_preset.video.codec.endsWith('_nvenc')) {
    try {
      await runProcess(ffmpeg, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=s=256x256:r=30',
        '-frames:v', '1', '-c:v', template.render_preset.video.codec, '-f', 'null', '-'], { signal: options.signal });
    } catch (error) {
      options.signal?.throwIfAborted();
      if (options.allowSoftwareFallback === false) throw error;
      warnings.push(`NVENC preflight failed; using ${template.render_preset.video.fallback_codec}. ${String(error)}`);
      template.render_preset.video.codec = template.render_preset.video.fallback_codec;
    }
  }
  // Isolated working directory: no caption/passlog collisions between concurrent jobs.
  const work = await mkdtemp(path.join(tmpdir(), 'acu-render-'));
  try {
    const stagingPath = path.join(work, 'output.mp4');
    const plan = buildRenderPlan({ ...input, template, media, outputPath: stagingPath });
    plan.warnings.push(...warnings);
    await Promise.all(plan.assetPaths.map(file => access(file, constants.R_OK)));
    await Promise.all(plan.supportFiles.map(file => writeFile(path.join(work, file.name), file.content, 'utf8')));
    await Promise.all(plan.assetCopies.map(file => copyFile(file.sourcePath, path.join(work, file.name))));
    for (const command of plan.commands) {
      const parser = new ProgressParser(plan.durationSec, command.pass, plan.commands.length, options.onProgress ?? (() => {}));
      await runProcess(ffmpeg, command.args, { cwd: work, signal: options.signal,
        onStdout: chunk => parser.push(chunk), onStderr: chunk => parser.push(chunk, 'stderr') });
    }
    options.signal?.throwIfAborted();
    await mkdir(path.dirname(path.resolve(input.outputPath)), { recursive: true });
    await copyFile(stagingPath, input.outputPath, constants.COPYFILE_EXCL);
    options.onProgress?.({ fraction: 1, timeSec: plan.durationSec, speed: null, pass: plan.commands.length, passes: plan.commands.length });
    return plan;
  } finally {
    // Only the mkdtemp directory owned by this job is removed; never source/output directories.
    await rm(work, { recursive: true, force: true });
  }
}

import path from 'node:path';
import { tmpdir } from 'node:os';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { templateSchema, validateTrim, type Template, type Trim } from '../../shared/template';
import { buildGraph } from './graph';
import { probeMedia } from './probe';
import { buildRenderPlan } from './plan';
import { runProcess } from './process';
import { timelineDuration } from '../../shared/timeline';

export async function renderPreview(inputPath: string, template: Template, trim: Trim, timeSec: number, outputPath: string, signal?: AbortSignal) {
  const t = templateSchema.parse(template), duration = t.timeline ? timelineDuration(t.timeline) : validateTrim(trim);
  if (!Number.isFinite(timeSec) || timeSec < 0 || timeSec >= duration) throw new Error('Кадр должен находиться внутри обрезки');
  const media = await probeMedia(inputPath, undefined, signal);
  buildRenderPlan({ template: t, templateDir: path.dirname(inputPath), inputPath, outputPath: `${outputPath}.mp4`, trim, media });
  const graph = buildGraph(t, duration, path.dirname(inputPath), undefined, false);
  const work = await mkdtemp(path.join(tmpdir(), 'acu-frame-'));
  try {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(path.join(work, 'filter.ffgraph'), graph.graph + (graph.hasAudio ? ';\n[aout]anullsink' : ''));
    await Promise.all(graph.files.map(file => writeFile(path.join(work, file.name), file.content)));
    await Promise.all(graph.assetCopies.map(file => copyFile(file.sourcePath, path.join(work, file.name))));
    await runProcess(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-v', 'error', '-nostdin', ...(t.timeline ? [] : ['-ss', String(trim.inSec), '-t', String(duration), '-i', inputPath]),
      ...graph.inputArgs, '-/filter_complex', 'filter.ffgraph', '-map', '[vout]', '-ss', String(timeSec), '-frames:v', '1', '-c:v', 'png', '-n', outputPath], { cwd: work, signal });
    return outputPath;
  } finally { await rm(work, { recursive: true, force: true }); }
}

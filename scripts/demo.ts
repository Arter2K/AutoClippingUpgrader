import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { templateSchema } from '../src/shared/template';
import { runProcess } from '../src/main/engine/process';
import { renderVideo } from '../src/main/engine/renderer';
import { probeMedia } from '../src/main/engine/probe';

const dir = path.resolve('out/demo');
await mkdir(dir, { recursive: true });
const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';
const inputPath = path.join(dir, 'synthetic-source.mp4');
await runProcess(ffmpeg, ['-v', 'error', '-n', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=60:d=4',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', inputPath]);
const template = templateSchema.parse(JSON.parse(await readFile('templates/clean-vertical.json', 'utf8')));
const plan = await renderVideo({ template, templateDir: path.resolve('templates'), inputPath,
  outputPath: path.join(dir, 'vertical-1080p60.mp4'), trim: { inSec: 0.5, outSec: 3.5 } }, {
  onProgress: p => process.stdout.write(`\r${(p.fraction * 100).toFixed(1)}% `),
});
await writeFile(path.join(dir, 'render-plan.json'), JSON.stringify(plan, null, 2));
await writeFile(path.join(dir, 'probe.json'), JSON.stringify(await probeMedia(path.join(dir, 'vertical-1080p60.mp4')), null, 2));
console.log(`\n${dir} (${plan.codec})`);

import path from 'node:path';
import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { templateSchema } from '../src/shared/template';
import { probeMedia } from '../src/main/engine/probe';
import { buildRenderPlan } from '../src/main/engine/plan';
import { renderVideo } from '../src/main/engine/renderer';

async function main() {
  const { values } = parseArgs({ options: {
    template: { type: 'string' }, input: { type: 'string' }, output: { type: 'string' },
    in: { type: 'string', default: '0' }, out: { type: 'string' },
    'plan-dir': { type: 'string' }, 'no-fallback': { type: 'boolean', default: false },
  } });
  if (!values.template || !values.input || !values.output || !values.out)
    throw new Error('Usage: npm run engine -- --template templates/gaming.json --input clip.mp4 --output renders/clip.mp4 --in 0 --out 10 [--plan-dir out/plan] [--no-fallback]');
  const templatePath = path.resolve(values.template);
  const template = templateSchema.parse(JSON.parse(await readFile(templatePath, 'utf8')));
  const input = { template, templateDir: path.dirname(templatePath), inputPath: path.resolve(values.input),
    outputPath: path.resolve(values.output), trim: { inSec: Number(values.in), outSec: Number(values.out) } };
  if (values['plan-dir']) {
    const dir = path.resolve(values['plan-dir']);
    const media = await probeMedia(input.inputPath);
    const plan = buildRenderPlan({ ...input, media });
    await mkdir(dir, { recursive: true });
    for (const file of plan.supportFiles) await writeFile(path.join(dir, file.name), file.content);
    for (const file of plan.assetCopies) await copyFile(file.sourcePath, path.join(dir, file.name));
    await writeFile(path.join(dir, 'plan.json'), JSON.stringify(plan, null, 2));
    console.log(`Plan saved to ${dir}; execute args via spawn with this cwd (shell:false).`);
  } else {
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    const plan = await renderVideo(input, { signal: controller.signal, allowSoftwareFallback: !values['no-fallback'],
      onProgress: p => process.stdout.write(`\r${(p.fraction * 100).toFixed(1)}% | pass ${p.pass}/${p.passes} | ${p.speed ?? '—'}x   `) });
    console.log(`\nRendered ${input.outputPath} (${plan.codec})`);
    for (const warning of plan.warnings) console.warn(warning);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

import fs from 'node:fs';
import path from 'node:path';
import { templateSchema, type Template } from '../src/shared/template';
import type { RenderRequest } from '../src/main/engine/plan';

export function fixture(): Template {
  return templateSchema.parse(JSON.parse(fs.readFileSync(path.resolve('templates/clean-vertical.json'), 'utf8')));
}
export function request(): RenderRequest {
  return { template: fixture(), inputPath: path.resolve('test input.mp4'), outputPath: path.resolve('test output.mp4'),
    templateDir: path.resolve('templates'), trim: { inSec: 2.1, outSec: 12.1 },
    media: { width: 1920, height: 1080, durationSec: 30, hasAudio: true } };
}

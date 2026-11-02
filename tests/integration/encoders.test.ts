import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { runProcess } from '../../src/main/engine/process';
import { renderVideo } from '../../src/main/engine/renderer';
import { probeMedia } from '../../src/main/engine/probe';
import { fixture } from '../helpers';

test('real codec/rate-control matrix; NVENC is opt-in for GPU hosts', { timeout: 180000 }, async t => {
  const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';
  const ffprobe = process.env.FFPROBE_PATH ?? 'ffprobe';
  const dir = await mkdtemp(path.join(tmpdir(), 'acu-encoders-'));
  try {
    const source = path.join(dir, 'source.mp4');
    await runProcess(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=1',
      '-c:v', 'libx264', source]);
    for (const codec of ['libx264', 'libx265', 'h264_nvenc', 'hevc_nvenc'] as const) {
      for (const rate_control of ['cbr', 'vbr', 'vbr_2pass', 'crf', 'cqp'] as const) {
        await t.test(`${codec} ${rate_control}`, { skip: codec.endsWith('_nvenc') && process.env.TEST_NVENC !== '1' }, async () => {
          const template = fixture();
          Object.assign(template.canvas, { width: 180, height: 320, fps: 30 });
          template.main_clip_layout.Position = { x: 0, y: 80, width: 180, height: 160, scale_mode: 'contain' };
          template.main_clip_layout.background_blur.scale_height = 320;
          const hevc = codec === 'hevc_nvenc' || codec === 'libx265';
          Object.assign(template.render_preset.video, { codec, fallback_codec: hevc ? 'libx265' : 'libx264',
            profile: hevc ? 'main' : 'high', level: 'auto', software_preset: 'ultrafast', nvenc_preset: 'p1',
            rate_control, target_bitrate_kbps: 500, max_bitrate_kbps: 800, bufsize_kbps: 1000 });
          const output = path.join(dir, `${codec}-${rate_control}.mp4`);
          const plan = await renderVideo({ template, templateDir: dir, inputPath: source, outputPath: output,
            trim: { inSec: 0.1, outSec: 0.8 } }, { ffmpegPath: ffmpeg, ffprobePath: ffprobe, allowSoftwareFallback: false });
          assert.equal(plan.codec, codec);
          const info = await probeMedia(output, ffprobe);
          assert.equal(info.width, 180); assert.equal(info.height, 320);
          assert.ok(Math.abs(info.durationSec - 0.7) < 0.08);
        });
      }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

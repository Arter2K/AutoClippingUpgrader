import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, copyFile, stat, readFile } from 'node:fs/promises';
import { runProcess } from '../../src/main/engine/process';
import { renderVideo } from '../../src/main/engine/renderer';
import { probeMedia } from '../../src/main/engine/probe';
import { fixture } from '../helpers';
import { templateSchema } from '../../src/shared/template';

const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH ?? 'ffprobe';

test('real FFmpeg: trim, audio, all layouts, text/media overlays, two passes and cancellation', { timeout: 180000 }, async t => {
  // Deliberately include spaces, Cyrillic and an apostrophe in source and asset paths.
  const dir = await mkdtemp(path.join(tmpdir(), "acu тест ' path-"));
  try {
    const source = path.join(dir, 'source video.mp4');
    await runProcess(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=3',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source]);
    const logo = path.join(dir, 'logo.png');
    await runProcess(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=32x32', '-frames:v', '1', logo]);
    const font = process.env.TEST_FONT_PATH ?? (process.platform === 'win32' ? 'C:/Windows/Fonts/arial.ttf' : '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf');
    await copyFile(font, path.join(dir, "font ' test.ttf"));
    for (const [index, mode] of (['blur_pad', 'center_crop', 'custom_crop'] as const).entries()) {
      await t.test(mode, async () => {
        const template = fixture();
        Object.assign(template.canvas, { width: 180, height: 320, fps: 30 });
        Object.assign(template.main_clip_layout, { source_aspect_handling: mode,
          Position: { x: 0, y: 80, width: 180, height: 160, scale_mode: 'contain' },
          source_crop: { x: 40, y: 20, width: 200, height: 140 } });
        template.main_clip_layout.background_blur.scale_height = 320;
        Object.assign(template.render_preset.video, { codec: 'libx264', level: 'auto', software_preset: 'ultrafast',
          rate_control: index === 1 ? 'vbr_2pass' : 'crf', target_bitrate_kbps: 500, max_bitrate_kbps: 800 });
        const ref = templateSchema.parse(JSON.parse(await readFile('templates/gaming-reference.json', 'utf8')));
        const text = ref.overlays.find(o => o.type === 'text')!;
        if (text.type !== 'text') throw Error();
        text.style.font_file = "font ' test.ttf";
        text.style.font_size = 12;
        text.text_content = "100% ' ; : [Привет] \\ test";
        text.position = { x: 90, y: 280, anchor: 'center' };
        text.timing = { full_duration: true, start_offset_sec: 0, end_offset_sec: null, fade_in_sec: 0.1, fade_out_sec: 0.1 };
        template.overlays = [text, { id: 'logo', name: 'logo', type: 'image', source_path: logo, z_index: 1,
          position: { x: 10, y: 10, width: 32, height: 32 }, scale: 1, opacity: 0.8,
          timing: { full_duration: false, start_offset_sec: 0.2, end_offset_sec: 1.2, fade_in_sec: 0.1, fade_out_sec: 0.1 } },
          { id: 'footage', name: 'footage', type: 'video', source_path: source, z_index: 2,
            position: { x: 120, y: 10, width: 48, height: 32 }, scale: 1, opacity: 0.5,
            chroma_key: { color: '#00ff00', similarity: 0.1, blend: 0.05 },
            timing: { full_duration: true, start_offset_sec: 0, end_offset_sec: null, fade_in_sec: 0, fade_out_sec: 0 } }];
        const output = path.join(dir, `output-${index}.mp4`);
        let progress = 0;
        const plan = await renderVideo({ template, templateDir: dir, inputPath: source, outputPath: output,
          trim: { inSec: 0.7, outSec: 2.2 } }, { ffmpegPath: ffmpeg, ffprobePath: ffprobe, onProgress: p => { progress = p.fraction; } });
        const media = await probeMedia(output, ffprobe);
        assert.equal(media.width, 180); assert.equal(media.height, 320);
        assert.equal(media.hasAudio, true);
        assert.ok(Math.abs(media.durationSec - 1.5) < 0.08, JSON.stringify(media));
        assert.ok((await stat(output)).size > 1000);
        assert.equal(progress, 1);
        assert.equal(plan.commands.length, index === 1 ? 2 : 1);
        await assert.rejects(() => renderVideo({ template, templateDir: dir, inputPath: source, outputPath: output,
          trim: { inSec: 0.7, outSec: 2.2 } }, { ffmpegPath: ffmpeg, ffprobePath: ffprobe }), /already exists/);
      });
    }
    await t.test('silent source, HEVC two-pass', async () => {
      const silent = path.join(dir, 'silent.mp4');
      await runProcess(ffmpeg, ['-v', 'error', '-i', source, '-c:v', 'copy', '-an', silent]);
      const template = fixture();
      Object.assign(template.canvas, { width: 180, height: 320, fps: 30 });
      template.main_clip_layout.Position = { x: 0, y: 80, width: 180, height: 160, scale_mode: 'contain' };
      template.main_clip_layout.background_blur.scale_height = 320;
      Object.assign(template.render_preset.video, { codec: 'libx265', fallback_codec: 'libx265', profile: 'main', level: 'auto',
        software_preset: 'ultrafast', rate_control: 'vbr_2pass', target_bitrate_kbps: 200, max_bitrate_kbps: 400 });
      const output = path.join(dir, 'hevc.mp4');
      await renderVideo({ template, templateDir: dir, inputPath: silent, outputPath: output, trim: { inSec: 0.1, outSec: 1.1 } }, { ffmpegPath: ffmpeg, ffprobePath: ffprobe });
      assert.equal((await probeMedia(output, ffprobe)).hasAudio, false);
    });
    await t.test('already aborted jobs create no output', async () => {
      const controller = new AbortController(); controller.abort();
      const output = path.join(dir, 'cancelled.mp4');
      await assert.rejects(() => renderVideo({ template: fixture(), templateDir: dir, inputPath: source,
        outputPath: output, trim: { inSec: 0, outSec: 1 } }, { signal: controller.signal }));
      await assert.rejects(() => stat(output));
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

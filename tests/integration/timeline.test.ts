import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { runProcess } from '../../src/main/engine/process';
import { renderVideo } from '../../src/main/engine/renderer';
import { renderPreview } from '../../src/main/engine/preview';
import { probeMedia } from '../../src/main/engine/probe';
import { newTemplate } from '../../src/shared/defaults';
import { newTrack, migrateTimeline } from '../../src/shared/timeline-migration';
import type { TimelineClip } from '../../src/shared/timeline';

test('real multitrack export: source trims, PTS offsets, gaps, transparency, track order, audio tail, fades, two-pass and reference frame', { timeout: 120000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "acu timeline ' тест-")), ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';
  try {
    const source = path.join(directory, 'source.mp4'), sound = path.join(directory, 'sound.wav');
    await runProcess(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', "color=red:s=160x160:r=30:d=3,drawbox=color=blue:t=fill:enable='gte(t,1)*lt(t,2)',drawbox=color=green:t=fill:enable='gte(t,2)'",
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', source]);
    await runProcess(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=2', sound]);
    const template = newTemplate(); Object.assign(template.canvas, { width: 160, height: 160, fps: 30, background_color: '#000000' });
    Object.assign(template.main_clip_layout, { source_aspect_handling: 'center_crop', Position: { x: 0, y: 0, width: 160, height: 160, scale_mode: 'cover' } });
    Object.assign(template.render_preset.video, { codec: 'libx264', level: 'auto', rate_control: 'vbr_2pass', software_preset: 'ultrafast', target_bitrate_kbps: 300, max_bitrate_kbps: 500 });
    template.render_preset.audio.normalize_loudness = false;
    template.timeline = migrateTimeline(template, { id: 'source', path: source, url: '', name: 'main', thumbnails: [], media: await probeMedia(source) }, { inSec: 1, outSec: 2 });
    const timeline = template.timeline, bottom = timeline.tracks[0]!, clip = bottom.clips[0]!;
    Object.assign(clip, { timeline_start_sec: 1, fade_in_sec: .2, fade_out_sec: .2 }); bottom.volume = .5;
    bottom.clips.push({ ...clip, id: 'end', timeline_start_sec: 2.5, source_in_sec: 2, source_out_sec: 3, duration_sec: 1, has_audio: false, muted: true });
    const upper = newTrack('video', timeline.tracks, 'upper'); upper.clips.push({ ...clip, id: 'pip', use_template_main_layout: false, source_in_sec: 0, source_out_sec: 1,
      timeline_start_sec: .5, muted: true, transform: { x: 40, y: 40, width: 40, height: 40, scale: 1, opacity: 1 } }); timeline.tracks.unshift(upper);
    const audio = newTrack('audio', timeline.tracks, 'audio'); audio.volume = .5;
    audio.clips.push({ ...clip, id: 'sound', media_type: 'audio', source_path: sound, source_duration_sec: 2, source_in_sec: .5, source_out_sec: 1.5, timeline_start_sec: 3, volume: .5, use_template_main_layout: false }); timeline.tracks.push(audio);
    const output = path.join(directory, 'output.mp4');
    const plan = await renderVideo({ template, templateDir: directory, inputPath: source, outputPath: output, trim: { inSec: 1, outSec: 2 } });
    assert.equal(plan.durationSec, 4); assert.equal(plan.commands.length, 2); assert.equal(plan.estimate.durationSec, 4);
    const media = await probeMedia(output); assert.ok(Math.abs(media.durationSec - 4) < .05); assert.equal(media.hasAudio, true);
    const frame = async (time: number, input = output) => {
      const file = path.join(directory, `frame-${time}-${path.basename(input)}.rgb`);
      await runProcess(ffmpeg, ['-v', 'error', '-ss', String(time), '-i', input, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', file]);
      return readFile(file);
    };
    const pixel = (data: Buffer, x: number, y: number) => [...data.subarray((y * 160 + x) * 3, (y * 160 + x) * 3 + 3)];
    const black = (p: number[]) => assert.ok(p.every(n => n < 20), String(p));
    black(pixel(await frame(.25), 5, 5));
    let data = await frame(.75); black(pixel(data, 5, 5)); assert.ok(pixel(data, 50, 50)[0]! > 200);
    data = await frame(1.25); assert.ok(pixel(data, 5, 5)[2]! > 200); assert.ok(pixel(data, 50, 50)[0]! > 200);
    data = await frame(1.75); assert.ok(pixel(data, 50, 50)[2]! > 200);
    black(pixel(await frame(2.25), 5, 5)); assert.ok(pixel(await frame(2.75), 5, 5)[1]! > 90);
    black(pixel(await frame(3.75), 5, 5));
    const pcm = path.join(directory, 'audio.f32');
    await runProcess(ffmpeg, ['-v', 'error', '-i', output, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', pcm]);
    const bytes = await readFile(pcm);
    const artifacts = path.resolve('out/timeline-qa'); await mkdir(artifacts, { recursive: true }); await copyFile(output, path.join(artifacts, 'timeline-render.mp4'));
    await writeFile(path.join(artifacts, 'filter.ffgraph'), plan.supportFiles[0]!.content);
    assert.ok(bytes.length >= 4 * 48000 * 3.9, `PCM bytes=${bytes.length}`);
    const rms = (time: number) => { let sum = 0; for (let i = 0; i < 2400; i++) sum += bytes.readFloatLE((Math.floor(time * 48000) + i) * 4) ** 2; return Math.sqrt(sum / 2400); };
    assert.ok(rms(.25) < .001); assert.ok(rms(1.4) > .025 && rms(1.4) < .055);
    assert.ok(rms(1.02) < rms(1.4) * .5); assert.ok(rms(1.92) < rms(1.4) * .5);
    assert.ok(rms(3.4) > .01); assert.ok(rms(3.4) < rms(1.4) * .65); assert.ok(rms(2.2) < .001);
    const preview = path.join(directory, 'preview.png'); await renderPreview(source, template, { inSec: 1, outSec: 2 }, 1.25, preview);
    const reference = await frame(0, preview); assert.ok(pixel(reference, 5, 5)[2]! > 200); assert.ok(pixel(reference, 50, 50)[0]! > 200);
    // Silent video metadata must be detected by probing, even if a project claims it has audio.
    const silent = path.join(directory, 'silent.mp4'); await runProcess(ffmpeg, ['-v', 'error', '-i', source, '-an', '-c:v', 'copy', silent]);
    const silentTemplate = structuredClone(template); silentTemplate.timeline!.tracks = [newTrack('video', [], 'silent')];
    silentTemplate.timeline!.tracks[0]!.clips = [{ ...clip, source_path: silent, has_audio: true }];
    silentTemplate.render_preset.video.rate_control = 'cbr';
    await renderVideo({ template: silentTemplate, templateDir: directory, inputPath: source, outputPath: path.join(directory, 'silent-output.mp4'), trim: { inSec: 0, outSec: 1 } });
    assert.equal((await probeMedia(path.join(directory, 'silent-output.mp4'))).hasAudio, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

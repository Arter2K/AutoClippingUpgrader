import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { templateSchema, validateTrim } from '../src/shared/template';
import { estimateFileSize } from '../src/shared/estimate';
import { buildRenderPlan } from '../src/main/engine/plan';
import { ProgressParser } from '../src/main/engine/progress';
import { fixture, request } from './helpers';

test('original user template is accepted without changing field names', () => {
  const t = templateSchema.parse(JSON.parse(fs.readFileSync('templates/gaming-reference.json', 'utf8')));
  assert.equal(t.main_clip_layout.Position.y, 420);
  assert.equal(t.overlays.length, 2);
});
test('requested bitrate formula responds to duration and audio', () => {
  const v = fixture().render_preset.video;
  assert.equal(estimateFileSize(v, 256, { inSec: 2, outSec: 62 }).megabytes, 133.7109375);
  assert.equal(estimateFileSize(v, 0, { inSec: 2, outSec: 32 }).megabytes, 65.91796875);
  v.rate_control = 'crf';
  assert.equal(estimateFileSize(v, 256, { inSec: 0, outSec: 60 }).megabytes, null);
});
test('rejects invalid trims, dimensions, crop and unsafe paths', () => {
  for (const trim of [{ inSec: -1, outSec: 2 }, { inSec: 1, outSec: 1 }, { inSec: NaN, outSec: 3 }])
    assert.throws(() => validateTrim(trim));
  const r = request();
  assert.throws(() => buildRenderPlan({ ...r, trim: { inSec: 0, outSec: 31 } }));
  assert.throws(() => buildRenderPlan({ ...r, outputPath: r.inputPath }));
  assert.throws(() => buildRenderPlan({ ...r, inputPath: 'bad\nfile.mp4' }));
  r.template.canvas.width = 1079;
  assert.throws(() => buildRenderPlan(r));
  const crop = request();
  crop.template.main_clip_layout.source_aspect_handling = 'custom_crop';
  crop.template.main_clip_layout.source_crop = { x: 1900, y: 0, width: 200, height: 200 };
  assert.throws(() => buildRenderPlan(crop));
});
test('single graph, zero-based trim, optional audio and safe argv paths', () => {
  const r = request();
  const p = buildRenderPlan(r);
  assert.equal(p.commands.length, 1);
  const args = p.commands[0]!.args;
  assert.equal(args[args.indexOf('-ss') + 1], '2.1');
  assert.equal(args[args.indexOf('-c:v') + 1], 'h264_nvenc');
  assert.ok(args.includes(r.inputPath));
  assert.match(p.supportFiles[0]!.content, /split=2/);
  assert.match(p.supportFiles[0]!.content, /boxblur/);
  r.media.hasAudio = false;
  const silent = buildRenderPlan(r);
  assert.ok(silent.commands[0]!.args.includes('-an'));
  assert.ok(!silent.commands[0]!.args.includes('0:a:0'));
  assert.equal(silent.estimate.megabytes, 18000 * 10 / 8192);
});
test('software two-pass and NVENC multipass are distinct', () => {
  const r = request();
  r.template.render_preset.video.rate_control = 'vbr_2pass';
  let p = buildRenderPlan(r);
  assert.equal(p.commands.length, 1);
  assert.ok(p.commands[0]!.args.includes('fullres'));
  r.template.render_preset.video.codec = 'libx264';
  p = buildRenderPlan(r);
  assert.equal(p.commands.length, 2);
  assert.ok(p.commands[0]!.args.includes('-pass'));
  assert.ok(p.commands[0]!.args.includes('-an'));
  assert.ok(p.commands[1]!.args.includes('0:a:0'));
  r.template.render_preset.video.codec = 'libx265';
  r.template.render_preset.video.fallback_codec = 'libx265';
  r.template.render_preset.video.profile = 'main';
  p = buildRenderPlan(r);
  assert.ok(p.commands[0]!.args.includes('pass=1:stats=x265.stats'));
  assert.ok(p.commands[1]!.args.includes('pass=2:stats=x265.stats'));
});
test('all codec/rate-control combinations create coherent encoder flags', () => {
  for (const codec of ['h264_nvenc', 'hevc_nvenc', 'libx264', 'libx265'] as const)
    for (const rate_control of ['cbr', 'vbr', 'vbr_2pass', 'crf', 'cqp'] as const) {
      const r = request();
      const hevc = codec === 'hevc_nvenc' || codec === 'libx265';
      Object.assign(r.template.render_preset.video, { codec, rate_control, profile: hevc ? 'main' : 'high', fallback_codec: hevc ? 'libx265' : 'libx264' });
      const args = buildRenderPlan(r).commands.at(-1)!.args;
      assert.equal(args[args.indexOf('-c:v') + 1], codec);
      assert.equal(args[args.indexOf('-preset') + 1], codec.endsWith('_nvenc') ? 'p6' : 'medium');
      if (rate_control === 'cbr') assert.equal(args[args.indexOf('-maxrate') + 1], '18000k');
      if (rate_control === 'crf' && codec.endsWith('_nvenc')) assert.ok(args.includes('-cq'));
    }
});
test('text content never enters filter syntax and layers sort by z-index', () => {
  const r = request();
  r.template = templateSchema.parse(JSON.parse(fs.readFileSync('templates/gaming-reference.json', 'utf8')));
  const text = r.template.overlays.find(o => o.type === 'text')!;
  if (text.type !== 'text') throw Error();
  text.text_content = "100% ' : ; [in] \\ Привет\nworld";
  text.z_index = -1;
  const p = buildRenderPlan(r);
  assert.equal(p.supportFiles[1]!.content, text.text_content);
  assert.ok(!p.supportFiles[0]!.content.includes('Привет'));
  assert.ok(p.supportFiles[0]!.content.indexOf('drawtext') < p.supportFiles[0]!.content.indexOf('colorchannelmixer'));
  assert.match(p.supportFiles[0]!.content, /expansion=none/);
});
test('rejects duplicate layers, timing overflow and overlapping fades', () => {
  const r = request();
  r.template = templateSchema.parse(JSON.parse(fs.readFileSync('templates/gaming-reference.json', 'utf8')));
  const o = r.template.overlays[0]!;
  r.template.overlays.push(structuredClone(o));
  assert.throws(() => buildRenderPlan(r));
  r.template.overlays.pop();
  o.timing = { full_duration: false, start_offset_sec: 9, end_offset_sec: 11, fade_in_sec: 0, fade_out_sec: 0 };
  assert.throws(() => buildRenderPlan(r));
  o.timing.end_offset_sec = 10;
  o.timing.fade_in_sec = 0.8;
  o.timing.fade_out_sec = 0.8;
  assert.throws(() => buildRenderPlan(r));
});
test('progress handles fragmented stdout/stderr and remains below 100% until successful completion', () => {
  const values: number[] = [];
  const p = new ProgressParser(10, 2, 2, v => values.push(v.fraction));
  p.push('out_time_us=500');
  p.push('0000\nspeed=2.0x\n');
  assert.equal(values.at(-1), 0.75);
  p.push('frame=10 time=00:00:03.00 speed= 1.0x\r', 'stderr');
  assert.equal(values.at(-1), 0.75);
  p.push('out_time=00:00:10.000\nprogress=end\n');
  assert.equal(values.at(-1), 0.999);
});

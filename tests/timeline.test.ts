import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { timelineSchema, timelineDuration, timelineHasAudio, segmentNeedsMedia, clipGain, splitSegment, trimmedSegment, snapClipStart, type TimelineClip } from '../src/shared/timeline';
import { newTrack, migrateTimeline } from '../src/shared/timeline-migration';
import { templateSchema } from '../src/shared/template';
import { newTemplate } from '../src/shared/defaults';
import { buildRenderPlan } from '../src/main/engine/plan';
import { useEditorStore } from '../src/renderer/stores/editor-store';
import { useTimelineStore } from '../src/renderer/stores/timeline-store';
import { advanceTimeline } from '../src/renderer/lib/timeline-preview';
import { resizeCanvas } from '../src/shared/geometry';
import { EditorRepository } from '../src/main/editor/repository';
import { MediaRegistry } from '../src/main/editor/media-registry';

const source = { id: 'source', path: 'source.mp4', url: 'acu-media://asset/source', name: 'source', media: { durationSec: 30, width: 320, height: 180, hasAudio: true }, thumbnails: [] };
const clip = (id = 'clip', patch: Partial<TimelineClip> = {}): TimelineClip => ({
  id, name: id, media_type: 'video', source_path: 'source.mp4', timeline_start_sec: 2, duration_sec: 4,
  source_in_sec: 10, source_out_sec: 14, source_duration_sec: 30, volume: 0.8, muted: false, has_audio: true,
  fade_in_sec: 1, fade_out_sec: 1, use_template_main_layout: true, ...patch,
});
const model = () => { const t = newTemplate(); t.timeline = migrateTimeline(t, source, { inSec: 10, outSec: 14 }); t.timeline.tracks[0]!.clips = [clip()]; return t; };
const request = () => ({ template: model(), templateDir: '.', inputPath: 'source.mp4', outputPath: 'output.mp4', trim: { inSec: 10, outSec: 14 }, media: source.media });

test('timeline schema keeps legacy JSON and derives duration; rejects inconsistent segments and IDs', () => {
  assert.equal(templateSchema.parse(newTemplate()).timeline, undefined);
  const t = model(); t.timeline!.total_duration_sec = 999;
  assert.equal(templateSchema.parse(t).timeline!.total_duration_sec, 6);
  t.timeline!.tracks[0]!.clips[0]!.duration_sec = 7; assert.equal(templateSchema.safeParse(t).success, false);
  const timeline = model().timeline!; timeline.tracks[0]!.clips.push(clip()); assert.equal(timelineSchema.safeParse(timeline).success, false);
  const invalid = model(); invalid.timeline!.tracks[0]!.clips[0]!.source_path = 'bad\npath'; assert.equal(templateSchema.safeParse(invalid).success, false);
  invalid.timeline!.tracks[0]!.clips[0] = clip('text', { media_type: 'text' }); assert.equal(templateSchema.safeParse(invalid).success, false);
});
test('duration includes leading gaps and active audio tails; Hide, Mute and Solo have independent meaning', () => {
  const t = model().timeline!, track = t.tracks[0]!;
  assert.equal(timelineDuration(t), 6); track.is_muted = true; assert.equal(timelineDuration(t), 6);
  track.is_visible = false; assert.equal(timelineDuration(t), 0); track.is_muted = false; assert.equal(timelineDuration(t), 6);
  const a = newTrack('audio', t.tracks, 'audio'); a.clips.push(clip('a', { media_type: 'audio', timeline_start_sec: 20 })); t.tracks.push(a);
  assert.equal(timelineDuration(t), 24); a.is_muted = true; assert.equal(timelineDuration(t), 6);
  a.is_solo = true; assert.equal(timelineDuration(t), 0); assert.equal(timelineHasAudio(t), false);
  a.is_muted = false; assert.equal(timelineHasAudio(t), true); assert.equal(timelineDuration(t), 24);
  assert.equal(segmentNeedsMedia(a.clips[0]!, a, t), true); a.is_muted = true; assert.equal(segmentNeedsMedia(a.clips[0]!, a, t), false);
  track.clips[0]!.enabled = false; assert.equal(timelineDuration(t), 0); assert.equal(segmentNeedsMedia(track.clips[0]!, track, t), false);
});
test('split/trim preserve source continuity, clamp bounds and keep outer fades', () => {
  const [left, right] = splitSegment(clip(), 3.5, 'right')!;
  assert.equal(left.source_out_sec, right.source_in_sec); assert.equal(left.duration_sec + right.duration_sec, 4);
  assert.equal(right.timeline_start_sec, 3.5); assert.equal(left.fade_out_sec, 0); assert.equal(right.fade_in_sec, 0);
  assert.equal(splitSegment(clip(), 2, 'x'), null); assert.equal(splitSegment(clip(), 6, 'x'), null);
  const trimmed = trimmedSegment(clip(), 'in', 11); assert.equal(trimmed.timeline_start_sec, 3); assert.equal(trimmed.duration_sec, 3);
  assert.equal(trimmedSegment(clip(), 'in', 0).timeline_start_sec, 0);
  assert.equal(trimmedSegment(clip(), 'out', 99).source_out_sec, 30);
  assert.ok(trimmedSegment(clip(), 'out', 0).duration_sec > 0);
  const shortened = trimmedSegment(clip('no-duration', { source_duration_sec: undefined }), 'out', 12);
  assert.equal(trimmedSegment(shortened, 'out', 14).source_out_sec, 14);
  assert.equal(trimmedSegment(clip('image', { media_type: 'image' }), 'out', 50).source_out_sec, 50);
});
test('snapping includes clip end, origin and playhead; gain matches fades and master volumes', () => {
  assert.deepEqual(snapClipStart(3.97, 2, [0, 6], .1), { value: 4, guide: 6 });
  assert.deepEqual(snapClipStart(.02, 2, [0], .1), { value: 0, guide: 0 });
  assert.deepEqual(snapClipStart(3, 2, [0], .1), { value: 3, guide: null });
  const t = model().timeline!, track = t.tracks[0]!; track.volume = .5;
  assert.equal(clipGain(clip(), track, t, 2.5), .2); assert.equal(clipGain(clip(), track, t, 5.5), .2);
  assert.equal(clipGain(clip(), track, t, 6), 0); track.is_muted = true; assert.equal(clipGain(clip(), track, t, 3), 0);
  assert.equal(advanceTimeline(model(), 5.9, .2).toFixed(1), '0.1');
});
test('graph compiles source trims, offsets, track order, fades, mix and size from the timeline', () => {
  const r = request(), t = r.template.timeline!, upper = newTrack('video', t.tracks, 'upper');
  upper.volume = .5; upper.clips = [clip('upper-clip', { use_template_main_layout: false, timeline_start_sec: 8, transform: { x: 40, y: 80, width: 100, height: 100, scale: 1, opacity: .7 } })]; t.tracks.unshift(upper);
  r.template.render_preset.video.rate_control = 'cbr'; r.template.render_preset.audio.normalize_loudness = false;
  const plan = buildRenderPlan(r), graph = plan.supportFiles[0]!.content;
  assert.equal(plan.durationSec, 12); assert.equal(plan.estimate.durationSec, 12);
  assert.match(graph, /trim=start=10:end=14,setpts=PTS-STARTPTS/);
  assert.match(graph, /setpts=PTS-STARTPTS\+2\/TB/); assert.match(graph, /setpts=PTS-STARTPTS\+8\/TB/);
  assert.ok(graph.indexOf('+2/TB') < graph.indexOf('+8/TB'));
  assert.match(graph, /volume=0.4,afade=t=in:st=0:d=1,afade=t=out:st=3:d=1,adelay=8000:all=1/);
  assert.match(graph, /amix=inputs=2:duration=longest:dropout_transition=0:normalize=0/);
  assert.ok(plan.commands[0]!.args.includes('[aout]')); assert.ok(!plan.commands[0]!.args.includes('-ss'));
  assert.equal(plan.commands[0]!.args.filter(v => v === '-i').length, 2);
  upper.is_muted = true; assert.match(buildRenderPlan(r).supportFiles[0]!.content, /amix=inputs=1:/);
  t.tracks.forEach(t => { t.is_muted = true; }); assert.ok(!buildRenderPlan(r).supportFiles[0]!.content.includes('amix='));
});
test('two-pass omits audio filters in first pass and maps the mix in final pass; protects every source', () => {
  const r = request(); Object.assign(r.template.render_preset.video, { codec: 'libx264', rate_control: 'vbr_2pass' });
  const p = buildRenderPlan(r); assert.equal(p.commands.length, 2); assert.ok(p.commands[0]!.args.includes('filter-pass1.ffgraph'));
  assert.ok(!p.supportFiles.find(f => f.name === 'filter-pass1.ffgraph')!.content.includes('amix='));
  r.template.timeline!.tracks[0]!.clips[0]!.source_path = r.outputPath; assert.throws(() => buildRenderPlan(r), /every timeline source/);
});
test('Zustand track editing, splitting, detach, lock, delete, undo/redo and view settings', () => {
  useEditorStore.setState({ template: newTemplate(), source: null, past: [], future: [] });
  useEditorStore.getState().setSource(source);
  const store = useTimelineStore.getState(), first = store.timeline.tracks[0]!.clips[0]!;
  store.trimClip(first.id, 'out', 20); assert.equal(useEditorStore.getState().trim.outSec, 20); store.trimClip(first.id, 'out', 30);
  store.selectClip(first.id); useEditorStore.setState({ playhead: 2 }); store.splitClipAtPlayhead();
  assert.equal(useTimelineStore.getState().timeline.tracks[0]!.clips.length, 2);
  store.setClipVolume(first.id, .25); store.trimClip(first.id, 'out', 1.5);
  let current = useTimelineStore.getState().timeline.tracks[0]!.clips[0]!; assert.equal(current.volume, .25); assert.equal(current.duration_sec, 1.5);
  store.detachAudio(first.id); let timeline = useTimelineStore.getState().timeline;
  assert.equal(timeline.tracks[0]!.clips[0]!.muted, true); assert.equal(timeline.tracks[1]!.clips[0]!.media_type, 'audio');
  const video = store.addTrack('video'); store.moveClipToTrack(first.id, video, 5);
  assert.equal(useTimelineStore.getState().timeline.tracks.find(t => t.id === video)!.clips[0]!.timeline_start_sec, 5);
  store.reorderTracks(['track-main', video]); assert.equal(useTimelineStore.getState().timeline.tracks.find(t => t.id === video)!.order_index, 1);
  store.updateTrack(video, { is_locked: true }); store.deleteClip(first.id);
  assert.ok(useTimelineStore.getState().timeline.tracks.find(t => t.id === video)!.clips.length);
  store.updateTrack(video, { is_locked: false }); store.deleteClip(first.id); assert.equal(useTimelineStore.getState().timeline.tracks.find(t => t.id === video)!.clips.length, 0);
  useEditorStore.getState().undo(); assert.equal(useTimelineStore.getState().timeline.tracks.find(t => t.id === video)!.clips.length, 1);
  useEditorStore.getState().redo(); assert.equal(useTimelineStore.getState().timeline.tracks.find(t => t.id === video)!.clips.length, 0);
  store.setView({ snap_enabled: false, zoom_px_per_sec: 200 }); assert.equal(useTimelineStore.getState().timeline.snap_enabled, false);
  const audio = store.addTrack('audio'); store.addClip(audio, clip('sound', { media_type: 'audio' })); store.updateClip('sound', { fade_in_sec: .5 });
  assert.equal(useTimelineStore.getState().timeline.tracks.find(t => t.id === audio)!.clips[0]!.fade_in_sec, .5);
  const beforeImport = useTimelineStore.getState().timeline.tracks.length;
  useEditorStore.getState().setSource({ ...source, path: 'second.mp4' });
  assert.equal(useTimelineStore.getState().timeline.tracks.length, beforeImport + 1);
  useEditorStore.getState().undo(); assert.equal(useTimelineStore.getState().timeline.tracks.length, beforeImport);
  const segments = useTimelineStore.getState().timeline.tracks.flatMap(t => t.clips).map(c => c.id);
  useEditorStore.getState().applyTemplate({ template: newTemplate(), assets: {}, warnings: [] });
  assert.deepEqual(useTimelineStore.getState().timeline.tracks.flatMap(t => t.clips).map(c => c.id), segments);
});
test('split without selection cuts all intersecting unlocked tracks and ignores boundary clips', () => {
  const t = model(), top = newTrack('video', t.timeline!.tracks, 'top'), locked = newTrack('video', [...t.timeline!.tracks, top], 'locked');
  top.clips = [clip('top-clip')]; locked.clips = [clip('locked-clip')]; locked.is_locked = true;
  t.timeline!.tracks.push(top, locked); useEditorStore.setState({ template: t, playhead: 3 }); useTimelineStore.getState().selectClip(null);
  useTimelineStore.getState().splitClipAtPlayhead();
  assert.deepEqual(useTimelineStore.getState().timeline.tracks.map(t => t.clips.length), [2, 2, 1]);
  useTimelineStore.getState().splitClipAtPlayhead(); assert.deepEqual(useTimelineStore.getState().timeline.tracks.map(t => t.clips.length), [2, 2, 1]);
});
test('canvas resize scales segment transforms; project hydration restores registered audio paths', async () => {
  const t = model(); t.timeline!.tracks[0]!.clips[0]!.transform = { x: 10, y: 20, width: 100, height: 200, scale: 1, opacity: 1 };
  const resized = resizeCanvas(t, t.canvas.width * 2, t.canvas.height * 2); assert.equal(resized.timeline!.tracks[0]!.clips[0]!.transform!.x, 20);
  const dir = await mkdtemp(path.join(tmpdir(), 'acu-timeline-'));
  try {
    const file = path.join(dir, 'audio.wav'); await writeFile(file, 'test');
    const registry = new MediaRegistry(), repo = new EditorRepository(dir, registry); await repo.initialize();
    const audio = newTrack('audio', [], 'audio'); audio.clips.push(clip('sound', { media_type: 'audio', source_path: 'audio.wav', use_template_main_layout: false }));
    t.timeline!.tracks = [audio]; const hydrated = await repo.hydrate(t, dir);
    assert.deepEqual(hydrated.warnings, []); assert.ok(hydrated.assets[file]); assert.equal(hydrated.template.timeline!.tracks[0]!.clips[0]!.source_path, file);
    const missing = newTrack('audio', t.timeline!.tracks, 'missing'); missing.is_muted = true; missing.clips = [clip('missing-clip', { media_type: 'audio', source_path: 'missing.wav', use_template_main_layout: false })];
    t.timeline!.tracks.push(missing); assert.deepEqual((await repo.hydrate(t, dir)).warnings, []);
    await repo.saveDraft({ format: 'AutoClippingUpgrader', version: 1, name: 'Timeline', sourcePath: null, template: hydrated.template, trim: { inSec: 0, outSec: 1 } });
    assert.equal((await new EditorRepository(dir, registry).draft())!.template.timeline!.tracks[0]!.clips[0]!.volume, .8);
    assert.equal((await registry.response(new Request(registry.register(file).url))).headers.get('Content-Type'), 'audio/wav');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

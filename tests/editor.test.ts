import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mainGeometry, resizeCanvas, snapPosition, overlayAlpha } from '../src/shared/geometry';
import { newTemplate } from '../src/shared/defaults';
import { templateSchema } from '../src/shared/template';
import { MediaRegistry } from '../src/main/editor/media-registry';
import { EditorRepository } from '../src/main/editor/repository';
import { RenderQueue } from '../src/main/editor/render-queue';
import { buildGraph } from '../src/main/engine/graph';
import { useEditorStore } from '../src/renderer/stores/editor-store';
import { applyColorKey } from '../src/renderer/lib/chroma-key';

test('preview geometry matches fit-width, cover and explicit source crop coordinates', () => {
  const t = newTemplate();
  let g = mainGeometry(t, 1920, 1080);
  assert.equal(g.target.width, 1080); assert.equal(g.target.height, 607.5); assert.equal(g.target.y, 656.25);
  t.main_clip_layout.source_aspect_handling = 'center_crop';
  g = mainGeometry(t, 1920, 1080);
  assert.deepEqual(g.target, t.main_clip_layout.Position); assert.equal(g.source.x, 420); assert.equal(g.source.width, 1080);
  t.main_clip_layout.source_aspect_handling = 'custom_crop';
  t.main_clip_layout.source_crop = { x: 10, y: 20, width: 800, height: 600 };
  t.main_clip_layout.Position.scale_mode = 'contain';
  g = mainGeometry(t, 1920, 1080); assert.deepEqual(g.source, t.main_clip_layout.source_crop);
  assert.equal(g.target.height, 810);
});
test('resolution changes scale coordinates while preserving source crop and fit mode', () => {
  const t = newTemplate(); t.main_clip_layout.source_crop = { x: 1, y: 2, width: 300, height: 400 };
  const resized = resizeCanvas(t, 1440, 2560);
  assert.equal(resized.main_clip_layout.Position.y, 560); assert.equal(resized.main_clip_layout.Position.scale_mode, 'fit_width');
  assert.equal(resized.canvas.aspect_ratio, '9:16'); assert.deepEqual(resized.main_clip_layout.source_crop, t.main_clip_layout.source_crop);
  assert.equal(t.canvas.width, 1080); assert.ok(templateSchema.safeParse(resized).success);
  assert.deepEqual(snapPosition(445, 20, 200, 100, 1080, 1920, 6), { x: 440, y: 20 });
});
test('hidden overlays do not enter graph or contribute any assets', () => {
  const t = newTemplate();
  t.overlays.push({ id: 'hidden', name: 'hidden', type: 'image', source_path: 'missing.png', enabled: false,
    position: { x: 0, y: 0, width: 100, height: 100 }, z_index: 1, opacity: 1, scale: 1,
    timing: { full_duration: true, start_offset_sec: 0, end_offset_sec: null, fade_in_sec: 0.3, fade_out_sec: 0.3 } });
  assert.equal(buildGraph(t, 10, process.cwd()).assetPaths.length, 0);
  assert.equal(overlayAlpha(t.overlays[0]!, 1, 10), 0);
  t.overlays[0]!.enabled = true; assert.equal(overlayAlpha(t.overlays[0]!, 0.15, 10), 0.5);
});
test('interactive chromakey removes green, preserves foreground and original alpha', () => {
  const pixels = new Uint8ClampedArray([0, 255, 0, 255, 255, 0, 0, 180, 0, 255, 0, 100]);
  applyColorKey(pixels, '#00ff00', 0.1, 0.05);
  assert.equal(pixels[3], 0); assert.equal(pixels[7], 180); assert.equal(pixels[11], 0);
});
test('Zustand edits and trim participate in undo/redo; source remains untouched', () => {
  const store = useEditorStore;
  store.setState({ template: newTemplate(), past: [], future: [], trim: { inSec: 0, outSec: 10 }, revision: 0, source: null });
  store.getState().change(t => { t.main_clip_layout.Position.x = 123; });
  store.getState().setTrim({ inSec: 1.2, outSec: 9.8 });
  store.getState().undo(); assert.equal(store.getState().trim.inSec, 0); assert.equal(store.getState().template.main_clip_layout.Position.x, 123);
  store.getState().undo(); assert.equal(store.getState().template.main_clip_layout.Position.x, 0);
  store.getState().redo(); assert.equal(store.getState().template.main_clip_layout.Position.x, 123);
  store.getState().change(t => { t.canvas.fps = 120; }); assert.equal(store.getState().future.length, 0);
});
test('media protocol serves only registered files with correct byte ranges', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'acu-media-test-'));
  try {
    const file = path.join(dir, 'test.mp4'); await writeFile(file, '0123456789');
    const registry = new MediaRegistry(), ref = registry.register(file);
    const response = await registry.response(new Request(ref.url, { headers: { Range: 'bytes=2-5' } }));
    assert.equal(response.status, 206); assert.equal(response.headers.get('Content-Range'), 'bytes 2-5/10'); assert.equal(await response.text(), '2345');
    assert.equal((await registry.response(new Request(ref.url, { method: 'HEAD' }))).headers.get('Content-Length'), '10');
    assert.equal((await registry.response(new Request(ref.url, { headers: { Range: 'bytes=50-' } }))).status, 416);
    assert.equal((await registry.response(new Request('acu-media://asset/../../secret.mp4'))).status, 404);
    assert.equal((await registry.response(new Request(ref.url, { headers: { Range: 'bytes=-3' } }))).status, 206);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('library templates and serialized drafts survive a fresh repository instance', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'acu-library-test-'));
  try {
    const registry = new MediaRegistry(), repository = new EditorRepository(dir, registry); await repository.initialize();
    const t = newTemplate(); t.template_id = '../../unsafe-file-name'; t.template_name = 'Saved';
    await repository.save(t);
    await repository.saveDraft({ format: 'AutoClippingUpgrader', version: 1, name: 'Project', template: t, sourcePath: null, trim: { inSec: 0, outSec: 10 } });
    const fresh = new EditorRepository(dir, registry); await fresh.initialize();
    assert.equal((await fresh.load(t.template_id)).template.template_name, 'Saved'); assert.equal((await fresh.draft())?.name, 'Project');
    assert.equal(JSON.parse(await readFile(path.join(dir, 'draft.json'), 'utf8')).template.template_id, t.template_id);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('render queue snapshots input, serializes tasks and cancels queued work', async () => {
  const calls: number[] = [], updates: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const queue = new RenderQueue<{ number: number }>(async (payload, update) => { calls.push(payload.number); if (payload.number === 1) await gate; update({ fraction: 1 }); }, job => updates.push(`${job.name}:${job.phase}`));
  const input = { number: 1 }; queue.enqueue('first', 'first.mp4', input); input.number = 999;
  const second = queue.enqueue('second', 'second.mp4', { number: 2 }); queue.cancel(second);
  queue.enqueue('third', 'third.mp4', { number: 3 }); release();
  for (let i = 0; i < 20 && !updates.includes('third:complete'); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(calls, [1, 3]); assert.ok(updates.includes('second:cancelled')); assert.ok(updates.includes('third:complete'));
});

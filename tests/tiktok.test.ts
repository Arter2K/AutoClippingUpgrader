import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tiktokChunkPlan, uploadTikTokChunks } from '../src/main/services/tiktok/chunk-upload';
import { TikTokPublishing } from '../src/main/services/tiktok/publishing';
import { TikTokOAuth, TIKTOK_SCOPES } from '../src/main/services/tiktok/oauth';
import { TestTokenStore, fetchMock, tikJson, token, streamLength } from './publishing-helpers';

const MiB = 1024 ** 2;
const creator = { creator_avatar_url: 'https://example.com/avatar.png', creator_username: 'test', creator_nickname: 'Test',
  privacy_level_options: ['SELF_ONLY'], comment_disabled: true, duet_disabled: false, stitch_disabled: false, max_video_post_duration_sec: 60 };
const info = { title: 'Тест #clips', privacy_level: 'SELF_ONLY', disable_comment: true, disable_duet: true, disable_stitch: true, video_cover_timestamp_ms: 0 };

test('TikTok chunk boundaries follow floor division and absorb trailing bytes', () => {
  for (const size of [1, 4 * MiB, 64 * MiB, 64 * MiB + 1, 70 * MiB + 123, 4 * 1024 ** 3]) {
    const p = tiktokChunkPlan(size);
    assert.equal(p.chunks.at(-1)!.end, size - 1);
    assert.equal(p.total_chunk_count, Math.max(1, Math.floor(size / p.chunk_size)));
    assert.equal(p.chunks.reduce((n, c) => n + c.end - c.start + 1, 0), size);
    assert.ok(p.chunks.every((c, i) => i === p.chunks.length - 1 ? c.end - c.start + 1 <= 128 * MiB : c.end - c.start + 1 >= 5 * MiB));
  }
  for (const size of [0, NaN, 4 * 1024 ** 3 + 1]) assert.throws(() => tiktokChunkPlan(size));
});
test('real file streaming: sequential Content-Range, 503 recovery and final 201', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'acu-tik-chunks-'));
  try {
    const filePath = path.join(dir, 'video.mp4'), size = 70 * MiB + 123;
    const file = await open(filePath, 'w'); await file.truncate(size); await file.close();
    const plan = tiktokChunkPlan(size); let offset = 0, failed = false, calls = 0, progress = 0;
    const fetcher = fetchMock(async (_url, init) => {
      calls++;
      const headers = new Headers(init.headers), range = headers.get('Content-Range')!;
      const chunk = plan.chunks.find(c => range === `bytes ${c.start}-${c.end}/${size}`)!;
      assert.ok(chunk); assert.equal(chunk.start, offset);
      assert.equal(await streamLength(init.body), chunk.end - chunk.start + 1);
      assert.equal(Number(headers.get('Content-Length')), chunk.end - chunk.start + 1);
      assert.equal(headers.has('Authorization'), false); // upload_url already contains a signed credential.
      if (chunk.start > 0 && !failed) { failed = true; return new Response('', { status: 503 }); }
      offset = chunk.end + 1; return new Response('', { status: offset === size ? 201 : 206 });
    });
    await uploadTikTokChunks({ filePath, uploadUrl: 'https://upload.us.tiktokapis.com/video/?upload_token=test', size, plan, fetcher,
      confirmedOffset: async () => offset, onProgress: p => { progress = p.fraction; } });
    assert.equal(progress, 1); assert.equal(offset, size); assert.equal(calls, plan.total_chunk_count + 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('TikTok uncertain transfer never blindly resends a partially accepted chunk', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'acu-tik-uncertain-'));
  try {
    const filePath = path.join(dir, 'video.mp4'); await writeFile(filePath, '12345678'); let calls = 0;
    await assert.rejects(() => uploadTikTokChunks({ filePath, uploadUrl: 'https://upload.us.tiktokapis.com/video/', size: 8, plan: tiktokChunkPlan(8),
      confirmedOffset: async () => 4, fetcher: fetchMock(async (_url, init) => { calls++; await streamLength(init.body); throw new Error('lost connection'); }) }), /upload_uncertain/);
    assert.equal(calls, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('Direct Post validates creator, sends metadata; inbox omits post_info and reaches inbox status', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'acu-tik-post-'));
  try {
    const filePath = path.join(dir, 'video.mp4'); await writeFile(filePath, '12345678');
    const store = new TestTokenStore(); await store.set('tiktok', token('client', TIKTOK_SCOPES));
    const initialized: Array<{ route: string; body: Record<string, unknown> }> = [];
    let queried = 0;
    const fetcher = fetchMock(async (url, init) => {
      if (url.includes('creator_info')) { queried++; return tikJson(creator); }
      if (url.includes('/init/')) { initialized.push({ route: url, body: JSON.parse(init.body as string) }); return tikJson({ publish_id: 'publish-1', upload_url: 'https://upload.us.tiktokapis.com/video/' }); }
      if (url.includes('status/fetch')) return tikJson({ status: 'SEND_TO_USER_INBOX', uploaded_bytes: 8 });
      await streamLength(init.body); return new Response('', { status: 201 });
    });
    const oauth = new TikTokOAuth('client', 'secret', store, fetcher);
    const service = new TikTokPublishing(oauth, fetcher, async () => ({ width: 1080, height: 1920, durationSec: 10, hasAudio: true }));
    await assert.rejects(() => service.upload({ filePath, mode: 'direct_post', consent: true, postInfo: { ...info, privacy_level: 'PUBLIC_TO_EVERYONE' } }));
    await assert.rejects(() => service.upload({ filePath, mode: 'direct_post', consent: true, postInfo: { ...info, disable_comment: false } }));
    assert.equal(initialized.length, 0);
    let savedId = '';
    assert.equal((await service.upload({ filePath, mode: 'direct_post', consent: true, postInfo: info }, { onInitialized: id => { savedId = id; } })).publishId, 'publish-1');
    assert.equal(savedId, 'publish-1'); assert.deepEqual(initialized[0]!.body.post_info, info);
    const prior = queried;
    await service.upload({ filePath, mode: 'inbox', consent: true });
    assert.equal(queried, prior); assert.ok(initialized[1]!.route.includes('/inbox/'));
    assert.equal('post_info' in initialized[1]!.body, false);
    assert.equal((await service.waitForStatus('publish-1', 'inbox')).status, 'SEND_TO_USER_INBOX');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('API error envelope is checked even on HTTP 200', async () => {
  const store = new TestTokenStore(); await store.set('tiktok', token('client', TIKTOK_SCOPES)); let calls = 0;
  const fetcher = fetchMock(() => { calls++; return tikJson({}, 200, 'scope_not_authorized'); });
  const service = new TikTokPublishing(new TikTokOAuth('client', 'secret', store, fetcher), fetcher);
  await assert.rejects(() => service.creatorInfo(), /scope_not_authorized/);
  assert.equal(calls, 1);
});
test('failed init is never retried and does not start file transfer', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'acu-tik-init-'));
  try {
    const filePath = path.join(dir, 'video.mp4'); await writeFile(filePath, 'data');
    const store = new TestTokenStore(); await store.set('tiktok', token('client', ['video.upload']));
    let calls = 0;
    const fetcher = fetchMock(url => { calls++; assert.ok(url.endsWith('/inbox/video/init/')); return tikJson({}, 500, 'internal_error'); });
    const service = new TikTokPublishing(new TikTokOAuth('client', 'secret', store, fetcher), fetcher,
      async () => ({ width: 1080, height: 1920, durationSec: 10, hasAudio: true }));
    await assert.rejects(() => service.upload({ filePath, mode: 'inbox', consent: true }), /internal_error/);
    assert.equal(calls, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

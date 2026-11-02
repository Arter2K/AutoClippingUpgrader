import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { GoogleOAuth, DRIVE_FILE_SCOPE } from '../src/main/services/google-drive/oauth';
import { DriveFolders } from '../src/main/services/google-drive/folders';
import { DriveUpload, driveOffset } from '../src/main/services/google-drive/resumable-upload';
import { renderAndArchive } from '../src/main/services/render-and-archive';
import { TestTokenStore, TestResumeStore, fetchMock, json, streamLength, token } from './publishing-helpers';
import { request as renderRequest } from './helpers';
import { buildRenderPlan } from '../src/main/engine/plan';

const UNIT = 256 * 1024;
const common = (url: string) => {
  if (url.includes('/about?')) return json({ user: { permissionId: 'owner' } });
  if (url.includes('/files/folder?')) return json({ id: 'folder', mimeType: 'application/vnd.google-apps.folder', capabilities: { canAddChildren: true } });
  return null;
};
test('Drive Range parser checks the actual server-confirmed offset', () => {
  assert.equal(driveOffset(new Response(null, { status: 308 }), 100), 0);
  assert.equal(driveOffset(new Response(null, { status: 308, headers: { range: 'bytes=0-42' } }), 100), 43);
  for (const range of ['bytes=2-42', 'bytes=0-100', 'bad'])
    assert.throws(() => driveOffset(new Response(null, { status: 308, headers: { range } }), 100));
});
test('Drive folders paginate, create metadata-only folder and check write capability', async () => {
  const store = new TestTokenStore(); await store.set('google', token('client', [DRIVE_FILE_SCOPE]));
  const oauth = new GoogleOAuth('client', undefined, [DRIVE_FILE_SCOPE], store, fetchMock((url, init) => {
    const u = new URL(url);
    if (init.method === 'POST') {
      assert.deepEqual(JSON.parse(init.body as string), { name: 'New folder', mimeType: 'application/vnd.google-apps.folder' });
      return json({ id: 'new', name: 'New folder' });
    }
    if (u.pathname.endsWith('/folder')) return common(url)!;
    assert.ok(u.searchParams.get('q')?.includes('trashed = false'));
    return json({ files: [{ id: 'folder', name: 'Folder' }], nextPageToken: 'page-2' });
  }));
  const folders = new DriveFolders(oauth);
  assert.equal((await folders.list()).nextPageToken, 'page-2');
  assert.equal((await folders.create(' New folder ')).id, 'new');
  await folders.assertWritable('folder');
});
test('Drive streaming resumes after 503 using queried server Range, not bytes attempted', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'acu-drive-resume-'));
  try {
    const source = path.join(dir, 'video.mp4'), size = 3 * UNIT + 7;
    await writeFile(source, Buffer.alloc(size, 42));
    const store = new TestTokenStore(); await store.set('google', token('client', [DRIVE_FILE_SCOPE]));
    const resume = new TestResumeStore(); let initCount = 0, offset = 0, failed = false, queries = 0;
    const ranges: string[] = [];
    const fetcher = fetchMock(async (url, init) => {
      const base = common(url); if (base) return base;
      if (url.includes('uploadType=resumable')) { initCount++; assert.deepEqual(JSON.parse(init.body as string).parents, ['folder']);
        return new Response(null, { status: 200, headers: { location: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=session' } }); }
      const headers = new Headers(init.headers), range = headers.get('Content-Range')!; ranges.push(range);
      if (range.startsWith('bytes */')) {
        queries++;
        if (queries === 1) return json({ error: { errors: [{ reason: 'rateLimitExceeded' }] } }, 403);
        return new Response(null, { status: 308, headers: { range: `bytes=0-${offset - 1}` } });
      }
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range)!;
      const start = Number(match[1]), end = Number(match[2]);
      assert.equal(await streamLength(init.body), end - start + 1); assert.equal(start, offset);
      if (!failed) { failed = true; offset = UNIT; return json({}, 503); }
      offset = end + 1;
      return offset === size ? json({ id: 'file-id', name: 'video.mp4', size: String(size) }, 201)
        : new Response(null, { status: 308, headers: { range: `bytes=0-${offset - 1}` } });
    });
    const oauth = new GoogleOAuth('client', undefined, [DRIVE_FILE_SCOPE], store, fetcher);
    let progress = 0;
    const result = await new DriveUpload(oauth, resume, fetcher).upload(source, 'folder', { chunkSize: 2 * UNIT, onProgress: p => { progress = p.fraction; } });
    assert.equal(result.id, 'file-id'); assert.equal(progress, 1); assert.equal(queries, 2); assert.equal(initCount, 1);
    assert.equal(ranges[1], `bytes */${size}`); assert.equal(ranges[2], `bytes */${size}`);
    assert.ok(ranges.includes(`bytes ${UNIT}-${3 * UNIT - 1}/${size}`));
    assert.equal(resume.data.size, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('Drive cancelled session survives a new service instance and resumes without new init', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'acu-drive-cancel-'));
  try {
    const source = path.join(dir, 'video.mp4'), size = 2 * UNIT + 17; await writeFile(source, Buffer.alloc(size));
    const store = new TestTokenStore(); await store.set('google', token('client', [DRIVE_FILE_SCOPE]));
    const resume = new TestResumeStore(); let offset = 0, initCount = 0;
    const fetcher = fetchMock(async (url, init) => {
      const base = common(url); if (base) return base;
      if (url.includes('uploadType=')) { initCount++; return new Response(null, { status: 200, headers: { location: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=session' } }); }
      const range = new Headers(init.headers).get('Content-Range')!;
      if (range.startsWith('bytes */')) return new Response(null, { status: 308, headers: { range: `bytes=0-${offset - 1}` } });
      const match = /^bytes (\d+)-(\d+)\//.exec(range)!; assert.equal(Number(match[1]), offset);
      await streamLength(init.body); offset = Number(match[2]) + 1;
      return offset === size ? json({ id: 'done', name: 'video.mp4' }, 201) : new Response(null, { status: 308, headers: { range: `bytes=0-${offset - 1}` } });
    });
    const oauth = new GoogleOAuth('client', undefined, [DRIVE_FILE_SCOPE], store, fetcher);
    const controller = new AbortController();
    await assert.rejects(() => new DriveUpload(oauth, resume, fetcher).upload(source, 'folder', { chunkSize: UNIT, signal: controller.signal,
      onProgress: p => { if (p.uploadedBytes > 0) controller.abort(); } }));
    assert.equal(offset, UNIT); assert.equal(resume.data.size, 1);
    assert.equal((await new DriveUpload(oauth, resume, fetcher).upload(source, 'folder', { chunkSize: UNIT })).id, 'done');
    assert.equal(initCount, 1); assert.equal(resume.data.size, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('Drive expired checkpoint is reinitialized; chunk size must be a multiple of 256 KiB', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'acu-drive-expired-'));
  try {
    const source = path.join(dir, 'video.mp4'); await writeFile(source, 'data');
    const store = new TestTokenStore(); await store.set('google', token('client', [DRIVE_FILE_SCOPE]));
    const resume = new TestResumeStore(); let sessions = 0;
    const controller = new AbortController();
    const fetcher = fetchMock(async (url, init) => {
      const base = common(url); if (base) return base;
      if (url.includes('uploadType=')) { sessions++; if (sessions === 1) controller.abort(); return new Response(null, { status: 200, headers: { location: `https://www.googleapis.com/upload/drive/v3/files?upload_id=${sessions}` } }); }
      if (new Headers(init.headers).get('Content-Range')?.startsWith('bytes */')) return json({}, 404);
      await streamLength(init.body); return json({ id: 'done', name: 'video.mp4' }, 201);
    });
    const oauth = new GoogleOAuth('client', undefined, [DRIVE_FILE_SCOPE], store, fetcher);
    await assert.rejects(() => new DriveUpload(oauth, resume, fetcher).upload(source, 'folder', { signal: controller.signal }));
    await assert.rejects(() => new DriveUpload(oauth, resume, fetcher).upload(source, 'folder', { chunkSize: 123 }));
    assert.equal((await new DriveUpload(oauth, resume, fetcher).upload(source, 'folder')).id, 'done');
    assert.equal(sessions, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('auto archive runs after successful render only and preserves render failure', async () => {
  const r = renderRequest(), { media: _media, ...input } = r;
  const order: string[] = [];
  const drive = { upload: async () => { order.push('upload'); return { id: 'file', name: 'output.mp4' }; } };
  const render = async () => { order.push('render'); return buildRenderPlan(r); };
  const result = await renderAndArchive(input, { autoUpload: true, driveFolderId: 'folder' }, drive, render);
  assert.deepEqual(order, ['render', 'upload']); assert.equal(result.driveFile?.id, 'file');
  order.length = 0;
  await assert.rejects(() => renderAndArchive(input, { autoUpload: true, driveFolderId: 'folder' }, drive, async () => { throw new Error('render failed'); }), /render failed/);
  assert.deepEqual(order, []);
  await renderAndArchive(input, { autoUpload: false }, drive, render);
  assert.deepEqual(order, ['render']);
});

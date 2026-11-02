import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { configurePackagedTools } from '../src/main/engine/tool-paths';

test('packaged runtime uses resource executables and respects explicit overrides', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'acu-tool-paths-'));
  try {
    await mkdir(path.join(root, 'ffmpeg'));
    for (const file of ['ffmpeg.exe', 'ffprobe.exe']) await writeFile(path.join(root, 'ffmpeg', file), 'path-resolution-fixture');
    const env: NodeJS.ProcessEnv = {};
    await configurePackagedTools(true, root, env);
    assert.equal(env.FFMPEG_PATH, path.join(root, 'ffmpeg', 'ffmpeg.exe'));
    assert.equal(env.FFPROBE_PATH, path.join(root, 'ffmpeg', 'ffprobe.exe'));
    await configurePackagedTools(false, 'not-installed', env);
    await configurePackagedTools(true, 'not-installed', env);
    await assert.rejects(() => configurePackagedTools(true, 'not-installed', {}));
  } finally { await rm(root, { recursive: true, force: true }); }
});

const { spawn } = require('node:child_process');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
async function main() {
  const tests = process.argv.slice(2);
  for (const test of tests.length ? tests : ['tests/electron/editor-smoke.cjs']) {
  const directory = await mkdtemp(path.join(tmpdir(), 'acu-editor-e2e-'));
  // Chromium profile files remain locked until Electron exits. Cleanup belongs to this parent process.
  try {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(require('electron'), [test], {
        stdio: 'inherit', windowsHide: true, env: { ...process.env, ACU_EDITOR_TEST_DIR: directory },
      });
      child.once('error', reject); child.once('close', code => resolve(code ?? 1));
    });
    process.exitCode = code;
    if (code !== 0) return;
  } finally {
    const resolved = path.resolve(directory), root = path.resolve(tmpdir());
    if (path.dirname(resolved) !== root || !path.basename(resolved).startsWith('acu-editor-e2e-')) throw new Error('Unexpected cleanup directory');
    await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

const { spawn } = require('node:child_process');
const { mkdtemp, mkdir, readFile, rm, writeFile, access } = require('node:fs/promises');
const path = require('node:path');
const { tmpdir } = require('node:os');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

class CDP {
  constructor(socket) {
    this.socket = socket; this.nextId = 0; this.pending = new Map();
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data)), pending = this.pending.get(message.id);
      if (!pending) return; this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
    });
  }
  async send(method, params = {}) {
    return new Promise((resolve, reject) => { const id = ++this.nextId; this.pending.set(id, { resolve, reject }); this.socket.send(JSON.stringify({ id, method, params })); });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
}
async function inspectExecutable(executable, label, artifacts, workerAsset, version) {
  const data = await mkdtemp(path.join(tmpdir(), 'acu-packaged-test-'));
  const env = { ...process.env };
  // Prove the binaries in resources are used, not the developer's PATH or FFmpeg settings.
  delete env.FFMPEG_PATH; delete env.FFPROBE_PATH; delete env.ELECTRON_RUN_AS_NODE;
  env.PATH = `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`;
  let child, socket, logs = '';
  try {
    child = spawn(executable, ['--hidden', `--user-data-dir=${data}`, '--remote-debugging-port=0'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-10000); }); child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-10000); });
    child.once('error', error => { logs += error.message; });
    const deadline = Date.now() + 60000;
    let port;
    while (Date.now() < deadline) {
      try { port = Number((await readFile(path.join(data, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); if (port) break; } catch {}
      if (child.exitCode !== null) throw new Error(`App exited early: ${logs}`); await pause(100);
    }
    if (!port) throw new Error(`No packaged renderer debug port: ${logs}`);
    let target;
    while (Date.now() < deadline) {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = targets.find(item => item.type === 'page' && item.url.startsWith('file:')); if (target) break; await pause(100);
    }
    assert.ok(target, 'Packaged renderer must load');
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    const cdp = new CDP(socket);
    await cdp.send('Network.enable');
    await cdp.send('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] });
    const waitFor = async (expression, timeout = 30000) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) { if (await cdp.evaluate(expression)) return; await pause(100); }
      throw new Error(`Packaged workflow timeout: ${expression}\n${await cdp.evaluate('document.body.innerText')}\n${logs}`);
    };
    await waitFor('document.querySelectorAll(".template-card").length === 3 && !document.querySelector(".media-loading")');
    assert.equal(await cdp.evaluate('typeof window.require'), 'undefined');
    assert.equal(await cdp.evaluate('Array.from(document.querySelectorAll(".project-menu button")).length'),6);
    assert.equal(await cdp.evaluate('typeof window.desktop.editor.importProject'), 'function');
    assert.equal(await cdp.evaluate('typeof window.desktop.editor.exportProject'), 'function');
    await cdp.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('Открыть тестовый клип')).click()`);
    await waitFor('document.querySelectorAll(".nle-clip").length===1 && document.querySelector("video.source-decoder")?.readyState>=2', 60000);
    assert.equal(await cdp.evaluate('document.querySelector(".version-pill").textContent'), `v${version}`);
    await cdp.evaluate(`(()=>{const ruler=document.querySelector('.nle-ruler > div'),r=ruler.getBoundingClientRect();ruler.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:r.x+60,clientY:r.y+10}));})()`);
    await cdp.evaluate(`document.querySelector('.nle-track[data-track-id="track-main"] .nle-clip').click()`);
    await cdp.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Split (S)').click()`);
    await waitFor('document.querySelectorAll(\'.nle-track[data-track-id="track-main"] .nle-clip\').length===2');
    await cdp.evaluate(`(()=>{const el=document.querySelector('input[aria-label="Clip Volume"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'0.4');el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await cdp.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Detach Audio').click()`);
    await waitFor('document.querySelectorAll(".nle-track.audio .nle-clip").length===1 && !!document.querySelector(".nle-track.audio .waveform path")');
    await cdp.evaluate(`(()=>{const ruler=document.querySelector('.nle-ruler > div'),r=ruler.getBoundingClientRect();ruler.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:r.x+15,clientY:r.y+10}));})()`);
    await cdp.evaluate(`document.querySelector('.nle-track[data-track-id="track-main"] .nle-clip').click()`);
    await cdp.evaluate(`document.querySelector('button[aria-label="Enable Chroma Key"]').click()`);
    await waitFor('!!document.querySelector(".bcc-controls")');
    await cdp.evaluate(`(()=>{const el=document.querySelector('select[aria-label="View Mode"]');el.value='alpha_matte';el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await waitFor(`(()=>{const c=document.querySelector('[data-testid="preview-canvas"]'),ctx=c.getContext('2d');const samples=[.2,.35,.5,.65,.8].map(x=>Array.from(ctx.getImageData(Math.round(c.width*x),Math.round(c.height*.52),1,1).data));return samples.every(p=>Math.abs(p[0]-p[1])<3&&Math.abs(p[1]-p[2])<3)&&samples.some(p=>p[0]>200)})()`);
    await cdp.evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='FFmpeg-кадр').click()`);
    await waitFor('!!document.querySelector(".reference-frame img")', 60000);
    assert.equal(await cdp.evaluate('document.querySelectorAll(".toast.error").length'), 0);
    const ai = await cdp.evaluate(`(async()=>{
      const canvas=document.createElement('canvas');canvas.width=128;canvas.height=128;const ctx=canvas.getContext('2d');
      ctx.fillStyle='green';ctx.fillRect(0,0,128,128);ctx.fillStyle='red';ctx.fillRect(40,20,48,90);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png')),bytes=await blob.arrayBuffer();
      const worker=new Worker(new URL(${JSON.stringify(workerAsset)},location.href),{type:'module'});
      return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{worker.terminate();reject(Error('Packaged AI timed out'))},120000);
        const stop=()=>{clearTimeout(timer);worker.terminate()};
        worker.onerror=e=>{stop();reject(Error(e.message))};
        worker.onmessage=e=>{if(e.data.kind==='complete'){stop();resolve({size:e.data.bytes.byteLength,signature:Array.from(new Uint8Array(e.data.bytes,0,8))})}else if(e.data.kind==='error'){stop();reject(Error(e.data.message))}};
        worker.postMessage({bytes,type:'image/png'},[bytes]);
      });
    })()`);
    assert.deepEqual(ai.signature, [137,80,78,71,13,10,26,10]); assert.ok(ai.size > 50);
    const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(path.join(artifacts, `${label}.png`), Buffer.from(screenshot.data, 'base64'));
    await cdp.evaluate('window.close()').catch(() => {});
    const result = await Promise.race([exited, pause(10000).then(() => null)]);
    if (!result) throw new Error('App did not close after its draft flush');
    assert.equal(result.code, 0);
    const draft = JSON.parse(await readFile(path.join(data, 'editor', 'draft.json'), 'utf8'));
    assert.equal(draft.template.canvas.width, 1080);
    assert.equal(draft.template.timeline.tracks.find(track => track.id === 'track-main').clips.length, 2);
    assert.equal(draft.template.timeline.tracks.find(track => track.id === 'track-main').clips[0].background_removal.mode,'bcc_chromakey_studio');
    const audio = draft.template.timeline.tracks.find(track => track.type === 'audio');
    assert.equal(audio.clips[0].volume, .4);
    assert.equal(draft.template.timeline.total_duration_sec, 8);
    assert.equal(draft.projectPath,null);
    console.log(`PASS: ${label} EXE v${version}, .acup menu/bridge/draft, main BCC/WebGL matte, multitrack split/gain/detach/waveform/draft, bundled FFmpeg, reference frame, offline AI, clean close`);
    return { label, passed: true, executable: path.basename(executable) };
  } finally {
    socket?.close(); if (child && child.exitCode === null) { child.kill(); await pause(800); }
    if (path.dirname(path.resolve(data)) !== path.resolve(tmpdir()) || !path.basename(data).startsWith('acu-packaged-test-')) throw new Error('Unexpected test directory');
    await rm(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}
async function main() {
  const root = path.resolve(__dirname, '..'), release = path.join(root, 'release'), artifacts = path.join(root, 'out', 'package-qa');
  await mkdir(artifacts, { recursive: true });
  const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const unpacked = path.join(release, 'win-unpacked');
  const builderRequire = createRequire(require.resolve('electron-builder'));
  const libRequire = createRequire(builderRequire.resolve('app-builder-lib'));
  const asar = libRequire('@electron/asar');
  const files = asar.listPackage(path.join(unpacked, 'resources', 'app.asar'));
  assert.equal(JSON.parse(asar.extractFile(path.join(unpacked, 'resources', 'app.asar'), 'package.json').toString()).version, metadata.version);
  assert.ok(files.some(file => file.replace(/\\/g, '/').endsWith('/dist/index.html')));
  const worker = files.find(file => /[\\/]ai\.worker-[^\\/]+\.js$/.test(file)); assert.ok(worker);
  const workerAsset = `assets/${path.basename(worker.replace(/\\/g, '/'))}`;
  assert.ok(!files.some(file => /(?:^|[\\/])(?:\.env|node_modules|tests|out|\.tools)(?:[\\/]|$)/.test(file)), 'No secrets or developer files in ASAR');
  await Promise.all(['ffmpeg/ffmpeg.exe', 'ffmpeg/ffprobe.exe', 'licenses/FFmpeg-GPLv3.txt', 'licenses/JavaScript-LICENSES.txt', 'ai-assets/resources.json', 'ai-assets/LICENSE.md'].map(file => access(path.join(unpacked, 'resources', file))));
  const installer = path.join(release, `AutoClippingUpgrader-${metadata.version}-Setup-x64.exe`);
  assert.equal((await readFile(installer)).subarray(0, 2).toString(), 'MZ');
  console.log('PASS: ASAR contents, bundled executables, licenses, installer PE header');
  const results = [];
  results.push(await inspectExecutable(path.join(unpacked, 'AutoClippingUpgrader.exe'), 'unpacked', artifacts, workerAsset, metadata.version));
  results.push(await inspectExecutable(path.join(release, `AutoClippingUpgrader-${metadata.version}-Portable-x64.exe`), 'portable', artifacts, workerAsset, metadata.version));
  await writeFile(path.join(artifacts, 'results.json'), JSON.stringify({ passed: true, results }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });

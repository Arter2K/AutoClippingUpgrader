const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
async function main() {
  const root = path.resolve(__dirname, '..'), from = path.join(root, '.tools', 'imgly-data', 'package', 'dist'), to = path.join(root, 'build', 'ai-assets');
  try { await fs.access(path.join(from, 'resources.json')); } catch {
    const base = path.join(root, '.tools', 'imgly-data'); await fs.mkdir(base, { recursive: true });
    console.log('Downloading official IMG.LY 1.7.0 assets for offline use…');
    const response = await fetch('https://staticimgly.com/@imgly/background-removal-data/1.7.0/package.tgz');
    if (!response.ok) throw new Error('AI asset download failed: ' + response.status);
    const archive = path.join(base, 'package.tgz'); await fs.writeFile(archive, Buffer.from(await response.arrayBuffer()));
    await promisify(execFile)('tar', ['-xf', archive, '-C', base]);
  }
  const resources = JSON.parse(await fs.readFile(path.join(from, 'resources.json'), 'utf8'));
  const keys = ['/models/isnet_quint8', '/onnxruntime-web/ort-wasm-simd-threaded.wasm', '/onnxruntime-web/ort-wasm-simd-threaded.mjs'];
  const selected = Object.fromEntries(keys.map(key => { if (!resources[key]) throw new Error(`Missing AI resource ${key}`); return [key, resources[key]]; }));
  await fs.mkdir(to, { recursive: true });
  const names = new Set(Object.values(selected).flatMap(entry => entry.chunks.map(chunk => chunk.name)));
  for (const name of names) { if (!/^[a-f0-9]{64}$/.test(name)) throw new Error('Unexpected model chunk filename'); await fs.copyFile(path.join(from, name), path.join(to, name)); }
  await Promise.all(['LICENSE.md', 'ThirdPartyLicenses.json'].map(name => fs.copyFile(path.join(from, '..', name), path.join(to, name))));
  await fs.writeFile(path.join(to, 'resources.json'), JSON.stringify(selected));
  console.log(`Prepared local IMG.LY 1.7.0 quantized model + WASM: ${names.size} chunks`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });

const path = require('node:path');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { build, Platform, Arch } = require('electron-builder');
const { createRequire } = require('node:module');

async function collectLicenses(metadata, root) {
  const visited = new Set(), notices = [];
  async function visit(name, parent) {
    const localRequire = createRequire(parent);
    let packageFile;
    try { packageFile = localRequire.resolve(`${name}/package.json`); }
    catch {
      let directory = path.dirname(localRequire.resolve(name));
      while (true) {
        const candidate = path.join(directory, 'package.json');
        try { if (JSON.parse(await fs.readFile(candidate, 'utf8')).name === name) { packageFile = candidate; break; } } catch {}
        const next = path.dirname(directory); if (next === directory) throw new Error(`Cannot find license metadata for ${name}`); directory = next;
      }
    }
    const pkg = JSON.parse(await fs.readFile(packageFile, 'utf8')), key = `${pkg.name}@${pkg.version}`;
    if (visited.has(key)) return; visited.add(key);
    const directory = path.dirname(packageFile), filenames = await fs.readdir(directory);
    const license = filenames.find(file => /^licen[cs]e(?:$|[.\-_])/i.test(file));
    const upstreamLicense = ['onnxruntime-web', 'onnxruntime-common'].includes(pkg.name) && pkg.version === '1.21.0'
      ? path.join(root, 'build', 'licenses', 'onnxruntime-1.21.0-LICENSE.txt') : null;
    const readme = filenames.find(file => /^readme\.md$/i.test(file));
    const declarationOnly = ['fontkit@2.0.4', 'brotli@1.3.3', 'dfa@1.2.0', 'guid-typescript@1.0.9'].includes(key);
    if (!license && !upstreamLicense && !(declarationOnly && readme)) throw new Error(`Missing license text: ${key}`);
    const notice = license || upstreamLicense ? await fs.readFile(license ? path.join(directory, license) : upstreamLicense, 'utf8')
      : `Upstream npm package declares ${pkg.license} but ships no complete LICENSE file. Original metadata and README are preserved below.\n${JSON.stringify({ name: pkg.name, version: pkg.version, author: pkg.author, license: pkg.license, repository: pkg.repository }, null, 2)}\n${await fs.readFile(path.join(directory, readme), 'utf8')}`;
    notices.push(`===== ${key} (${pkg.license ?? 'see license below'}) =====\n${notice}`);
    for (const dependency of Object.keys(pkg.dependencies ?? {})) await visit(dependency, packageFile);
    if (pkg.name === '@imgly/background-removal') await visit('onnxruntime-web', packageFile);
  }
  for (const name of Object.keys(metadata.dependencies)) await visit(name, path.join(root, 'package.json'));
  return notices.join('\n\n');
}

async function main() {
  if (process.platform !== 'win32') throw new Error('This packaging task targets Windows x64. Run it on Windows.');
  const root = path.resolve(__dirname, '..');
  const metadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const toolRoot = process.env.ACU_FFMPEG_BUNDLE_DIR ?? path.join(root, '.tools', 'ffmpeg-9.0.2-essentials_build');
  await Promise.all(['bin/ffmpeg.exe', 'bin/ffprobe.exe', 'LICENSE', 'README.txt'].map(name => fs.access(path.join(toolRoot, name))));
  await fs.access(path.join(root, 'build', 'ai-assets', 'resources.json'));
  const stageRoot = path.join(root, '.tools', 'windows-packaging');
  await fs.mkdir(stageRoot, { recursive: true });
  const stage = await fs.mkdtemp(path.join(stageRoot, 'build-'));
  const application = path.join(stage, 'app'); await fs.mkdir(application);
  const licensesFile = path.join(stage, 'JavaScript-LICENSES.txt');
  await fs.writeFile(licensesFile, await collectLicenses(metadata, root));
  await Promise.all(['dist', 'dist-electron'].map(name => fs.cp(path.join(root, name), path.join(application, name), { recursive: true })));
  // All runtime dependencies (including Zod) are bundled. A minimal package cannot collect .env or dev dependencies.
  await fs.writeFile(path.join(application, 'package.json'), JSON.stringify({ name: metadata.name, productName: metadata.productName,
    version: metadata.version, description: metadata.description, private: true, main: metadata.main, dependencies: {} }, null, 2));
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  const artifacts = await build({ projectDir: root, targets: Platform.WINDOWS.createTarget(['nsis', 'portable'], Arch.x64), publish: 'never', config: {
    appId: 'com.autoclippingupgrader.desktop', productName: metadata.productName,
    directories: { app: application, output: path.join(root, 'release'), buildResources: path.join(root, 'build') },
    electronVersion: require('electron/package.json').version, electronDist: path.dirname(require('electron')),
    asar: true, npmRebuild: false, compression: 'normal', forceCodeSigning: false,
    files: ['dist/**/*', 'dist-electron/**/*', 'package.json', '!node_modules/**/*'],
    extraResources: [
      { from: path.join(root, 'build', 'ai-assets'), to: 'ai-assets' },
      { from: path.join(root, 'build', 'licenses'), to: 'licenses', filter: ['*.txt'] },
      { from: path.join(toolRoot, 'bin'), to: 'ffmpeg', filter: ['ffmpeg.exe', 'ffprobe.exe'] },
      { from: path.join(toolRoot, 'LICENSE'), to: 'licenses/FFmpeg-GPLv3.txt' },
      { from: path.join(toolRoot, 'README.txt'), to: 'licenses/FFmpeg-build-info.txt' },
      { from: path.join(root, 'build', 'THIRD-PARTY-NOTICES.md'), to: 'licenses/THIRD-PARTY-NOTICES.md' },
      { from: licensesFile, to: 'licenses/JavaScript-LICENSES.txt' },
      { from: path.join(root, 'build', 'icon.png'), to: 'icon.png' },
      { from: path.join(root, '.env.example'), to: 'oauth.env.example' },
    ],
    win: { executableName: 'AutoClippingUpgrader', icon: path.join(root, 'build', 'icon.ico'), signExecutable: false },
    nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, runAfterFinish: false,
      createDesktopShortcut: true, deleteAppDataOnUninstall: false,
      artifactName: 'AutoClippingUpgrader-${version}-Setup-${arch}.${ext}' },
    portable: { requestExecutionLevel: 'user', artifactName: 'AutoClippingUpgrader-${version}-Portable-${arch}.${ext}' },
    publish: null,
  } });
  const executables = artifacts.filter(file => file.endsWith('.exe'));
  const checksums = [];
  for (const file of executables) {
    const hash = createHash('sha256').update(await fs.readFile(file)).digest('hex');
    checksums.push(`${hash}  ${path.basename(file)}`);
  }
  await fs.writeFile(path.join(root, 'release', 'SHA256SUMS.txt'), `${checksums.join('\n')}\n`);
  console.log(`Windows artifacts:\n${executables.join('\n')}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });

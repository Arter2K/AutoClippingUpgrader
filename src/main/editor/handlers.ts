import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { access, mkdir, stat, copyFile, writeFile } from 'node:fs/promises';
import { app, BrowserWindow, dialog, ipcMain, protocol, shell, nativeImage } from 'electron';
import { z } from 'zod';
import { projectSchema, type EditorDocument, type SourceMedia, type RenderSubmission } from '../../shared/editor';
import { templateSchema, validateTrim } from '../../shared/template';
import { MediaRegistry } from './media-registry';
import { EditorRepository, atomicJson } from './repository';
import { RenderQueue } from './render-queue';
import { probeMedia } from '../engine/probe';
import { runProcess } from '../engine/process';
import { aiAssetResponse } from './ai-assets';
import { fontMetadata, systemFonts } from './fonts';
import { renderVideo } from '../engine/renderer';
import { renderPreview } from '../engine/preview';
import { writeProjectFile, exportProjectWithMedia } from './project-files';
import { PROJECT_EXTENSION, projectFilename, isProjectFile } from '../../shared/project';
import type { registerPublishing } from '../services/publishing-hub';

export async function registerEditor(owner: () => BrowserWindow | null, publishing: ReturnType<typeof registerPublishing>) {
  const registry = new MediaRegistry(), root = path.join(app.getPath('userData'), 'editor'), cache = path.join(root, 'cache');
  const repository = new EditorRepository(root, registry);
  await repository.initialize(); await mkdir(cache, { recursive: true });
  const aiRoot = app.isPackaged ? path.join(process.resourcesPath, 'ai-assets') : path.resolve('build/ai-assets');
  protocol.handle('acu-media', request => new URL(request.url).hostname === 'ai' ? aiAssetResponse(request, aiRoot) : registry.response(request));
  let projectDirectory = path.join(root, 'workspace');
  let activeProjectPath: string | null = null;
  let unavailableSourcePath: string | null = null;
  const knownProjects = new Set<string>();
  const projectFilters = [{ name: 'AutoClippingUpgrader Project', extensions: ['acup'] }, { name: 'Legacy project (.acu.json)', extensions: ['json'] }];
  let preview: AbortController | undefined;
  const sources = new Map<string, SourceMedia>();
  const loadSource = async (file: string): Promise<SourceMedia> => {
    const media = await probeMedia(file);
    const registered = registry.register(file);
    const source: SourceMedia = { ...registered, path: file, name: path.basename(file), media, thumbnails: [] };
    // Seek independently, so a long input does not have to be decoded end to end for a filmstrip.
    for (let i = 0; i < 6; i += 2) {
      const thumbnails = await Promise.all([i, i + 1].map(async index => {
        const image = path.join(cache, `${randomUUID()}.jpg`);
        try {
          await runProcess(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-v', 'error', '-nostdin', '-ss', String(Math.max(0, (media.durationSec - 0.05) * index / 6)),
            '-i', file, '-frames:v', '1', '-vf', 'scale=240:136:force_original_aspect_ratio=decrease,pad=240:136:(ow-iw)/2:(oh-ih)/2', '-n', image]);
          return registry.register(image).url;
        } catch { return null; }
      }));
      source.thumbnails.push(...thumbnails.filter((value): value is string => !!value));
    }
    source.posterUrl = source.thumbnails[0]; sources.set(source.id, source); return source;
  };
  const resolveSource = (id: string) => { if (!sources.has(id)) throw new Error('Выберите исходный клип'); return registry.resolve(id); };
  const documentInput = z.object({ name: z.string().min(1).max(200), template: templateSchema, sourceId: z.string().uuid().nullable(),
    trim: z.object({ inSec: z.number().nonnegative(), outSec: z.number().positive() }), settings: projectSchema.shape.settings, projectPath:z.string().nullable().optional() });
  const makeDocument = async (value: unknown) => {
    const input = documentInput.parse(value), hydrated = await repository.hydrate(input.template);
    if (input.sourceId) validateTrim(input.trim, sources.get(input.sourceId)?.media.durationSec);
    return projectSchema.parse({ format: 'AutoClippingUpgrader', version: 1, name: input.name, template: hydrated.template,
      sourcePath: input.sourceId ? resolveSource(input.sourceId) : unavailableSourcePath, trim: input.trim, settings: input.settings });
  };
  const restore = async (project: z.infer<typeof projectSchema>, directory?: string): Promise<EditorDocument> => {
    if (directory) projectDirectory = directory;
    const hydrated = await repository.hydrate(project.template, directory);
    let source: SourceMedia | null = null;
    if (project.sourcePath) {
      try { source = await loadSource(path.resolve(directory ?? root, project.sourcePath)); }
      catch { hydrated.warnings.push('Исходный клип недоступен. Выберите его заново.'); }
    }
    const validTrim = source && project.trim.outSec <= source.media.durationSec && project.trim.inSec < project.trim.outSec;
    return { ...hydrated, source, name: project.name, settings: project.settings, projectPath: activeProjectPath, trim: !source || validTrim ? project.trim : { inSec: 0, outSec: Math.min(30, source.media.durationSec) } };
  };
  const queue = new RenderQueue<RenderSubmission & { outputPath: string }>(async (input, update, signal) => {
    const plan = await renderVideo({ template: input.template, templateDir: root, inputPath: resolveSource(input.sourceId),
      outputPath: input.outputPath, trim: input.trim }, { signal, allowSoftwareFallback: input.allowSoftwareFallback,
      onProgress: p => update({ fraction: p.fraction, speed: p.speed, pass: p.pass, passes: p.passes }) });
    const output = registry.register(input.outputPath), publishFile = await publishing.registerFile(input.outputPath);
    update({ outputUrl: output.url, publishFile, codec: plan.codec, warnings: plan.warnings });
    if (input.autoUpload) {
      update({ phase: 'uploading' });
      try { await publishing.archive(input.outputPath, input.driveFolderId!, { signal, onProgress: progress => update({ uploadProgress: progress }) }); }
      catch { signal.throwIfAborted(); throw new Error('Видео сохранено локально. Загрузка в Drive не завершена; её можно повторить во вкладке публикации.'); }
    }
  }, job => { const win = owner(); if (win && !win.isDestroyed()) win.webContents.send('editor:job', job); });
  const handle = (name: string, action: (...args: unknown[]) => Promise<unknown>) => {
    ipcMain.handle(`editor:${name}`, async (event, ...args: unknown[]) => {
      const win = owner();
      if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('Untrusted IPC sender');
      try { return await action(...args); }
      catch (error) {
        if (error instanceof z.ZodError) throw new Error(error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('\n').slice(0, 3000));
        throw error;
      }
    });
  };
  const window = () => { const win = owner(); if (!win) throw new Error('Окно закрыто'); return win; };
  const chooseSource = async () => {
    const result = await dialog.showOpenDialog(window(), { properties: ['openFile'], filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi'] }] });
    return result.canceled || !result.filePaths[0] ? null : loadSource(result.filePaths[0]);
  };
  handle('source-select', chooseSource);
  handle('source-drop', async value => {
    const file = z.string().min(1).max(32768).parse(value);
    if (!['.mp4', '.mov', '.mkv', '.webm', '.avi'].includes(path.extname(file).toLowerCase())) throw new Error('Перетащите видеофайл MP4, MOV, MKV, WebM или AVI');
    return loadSource(file);
  });
  handle('demo', async () => {
    const file = path.join(cache, 'demo-source.mp4');
    try { await access(file); } catch {
      await runProcess(process.env.FFMPEG_PATH ?? 'ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=60:d=8',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=8', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', '-n', file]);
    }
    return loadSource(file);
  });
  handle('asset-select', async raw => {
    const kind = z.enum(['image', 'video', 'audio', 'font']).parse(raw);
    const result = await dialog.showOpenDialog(window(), { properties: ['openFile'], filters: [{ name: kind,
      extensions: kind === 'font' ? ['ttf', 'otf'] : kind === 'audio' ? ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'mp4', 'webm'] : kind === 'image' ? ['png', 'gif', 'webp', 'jpg', 'jpeg'] : ['mp4', 'mov', 'webm', 'mkv'] }] });
    let file = result.filePaths[0]; if (result.canceled || !file) return null;
    const extension = path.extname(file).toLowerCase();
    const permitted = kind === 'font' ? ['.ttf', '.otf'] : kind === 'audio' ? ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.mp4', '.webm'] : kind === 'image' ? ['.png', '.jpg', '.jpeg', '.gif', '.webp'] : ['.mp4', '.mov', '.webm', '.mkv'];
    if (!permitted.includes(extension)) throw new Error('Выберите файл подходящего типа для этого слоя');
    if (kind === 'font') {
      const directory = path.join(projectDirectory, 'assets', 'fonts'); await mkdir(directory, { recursive: true });
      const destination = path.join(directory, `${randomUUID()}${extension}`); await copyFile(file, destination); file = destination;
    }
    return { path: file, name: path.basename(file), url: registry.register(file).url, kind,
      ...(['audio', 'video'].includes(kind) ? { media: await probeMedia(file, undefined, undefined, kind === 'audio') } : {}), ...(kind === 'font' ? fontMetadata(file) : {}) };
  });
  handle('system-fonts', async () => systemFonts());
  handle('system-font-adopt', async value => {
    const file = z.string().parse(value), font = (await systemFonts()).find(f => f.path === file); if (!font) throw new Error('Системный шрифт не найден');
    return { ...font, kind: 'font', url: registry.register(file).url };
  });
  handle('processed-image', async (source, value) => {
    const file = z.string().parse(source); if (!registry.hasPath(file)) throw new Error('Выберите исходное изображение в редакторе');
    if (!(value instanceof ArrayBuffer) || value.byteLength > 100 * 1024 * 1024) throw new Error('Некорректный результат обработки');
    const bytes = Buffer.from(value);
    if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || nativeImage.createFromBuffer(bytes).isEmpty()) throw new Error('AI должен вернуть валидный PNG');
    const directory = path.join(projectDirectory, 'assets', 'processed'); await mkdir(directory, { recursive: true });
    const destination = path.join(directory, `${path.parse(file).name.replace(/[^\p{L}\p{N}_-]/gu, '_')}_${randomUUID()}.png`);
    await writeFile(destination, bytes, { flag: 'wx' });
    return { path: destination, name: path.basename(destination), kind: 'image', url: registry.register(destination).url };
  });
  handle('hydrate', async template => repository.hydrate(templateSchema.parse(template)));
  handle('template-load', async id => repository.load(z.string().min(1).max(200).parse(id)));
  handle('template-save', async template => repository.save(templateSchema.parse(template)));
  handle('template-import', async () => {
    const result = await dialog.showOpenDialog(window(), { properties: ['openFile'], filters: [{ name: 'JSON template', extensions: ['json'] }] });
    return result.canceled || !result.filePaths[0] ? null : repository.readTemplate(result.filePaths[0]);
  });
  handle('template-export', async raw => {
    const hydrated = await repository.hydrate(templateSchema.parse(raw));
    const result = await dialog.showSaveDialog(window(), { defaultPath: `${hydrated.template.template_name.replace(/[^\p{L}\p{N} _-]/gu, '')}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return false;
    await atomicJson(result.filePath, hydrated.template); return true;
  });
  handle('project-save', async (value, rawSaveAs) => {
    const document = await makeDocument(value);
    const saveAs = z.boolean().optional().parse(rawSaveAs) ?? false;
    let file = !saveAs ? activeProjectPath : null;
    if (!file) {
      const result = await dialog.showSaveDialog(window(), { defaultPath: activeProjectPath ? path.join(path.dirname(activeProjectPath),projectFilename(document.name)) : projectFilename(document.name), filters: [projectFilters[0]!] });
      if (result.canceled || !result.filePath) return null;
      file = result.filePath.toLowerCase().endsWith(PROJECT_EXTENSION) ? result.filePath : result.filePath + PROJECT_EXTENSION;
    }
    await writeProjectFile(file,document); activeProjectPath = path.resolve(file);knownProjects.add(activeProjectPath);projectDirectory = path.dirname(file); return activeProjectPath;
  });
  const openProjectFile = async (file:string, imported=false) => {
    const project = await repository.readProject(file), previousDirectory=projectDirectory;
    try {
      const document=await restore(project,path.dirname(file));activeProjectPath=imported?null:path.resolve(file);
      unavailableSourcePath=document.source?null:project.sourcePath;
      if(activeProjectPath)knownProjects.add(activeProjectPath);if(imported)projectDirectory=path.join(root,'workspace');
      return {...document,projectPath:activeProjectPath};
    }catch(error){projectDirectory=previousDirectory;throw error;}
  };
  const chooseProject = async (imported=false) => {
    const result = await dialog.showOpenDialog(window(), { properties: ['openFile'], filters: projectFilters });
    if (result.canceled || !result.filePaths[0]) return null;
    return openProjectFile(result.filePaths[0],imported);
  };
  handle('project-open', async () => chooseProject());
  handle('project-import', async () => chooseProject(true));
  handle('project-drop', async value => {
    const file=z.string().min(1).max(32768).parse(value);if(!isProjectFile(file))throw new Error('Перетащите проект .acup или .acu.json');return openProjectFile(file);
  });
  handle('project-reset', async () => { activeProjectPath = null; unavailableSourcePath = null; projectDirectory = path.join(root,'workspace'); });
  handle('project-confirm-switch',async value=>{
    const name=z.string().max(200).parse(value);
    const result=await dialog.showMessageBox(window(),{type:'question',title:'Несохранённый проект',message:`Сохранить изменения в «${name.trim()||'Без названия'}»?`,buttons:['Сохранить','Не сохранять','Отмена'],defaultId:0,cancelId:2,noLink:true});
    return result.response===0?'save':result.response===1?'discard':'cancel';
  });
  handle('project-export', async value => {
    const document=await makeDocument(value),result=await dialog.showSaveDialog(window(),{defaultPath:projectFilename(`${document.name} portable`),filters:[projectFilters[0]!]});
    if(result.canceled||!result.filePath)return null;
    const file=result.filePath.toLowerCase().endsWith(PROJECT_EXTENSION)?result.filePath:result.filePath+PROJECT_EXTENSION;
    return exportProjectWithMedia(file,document);
  });
  handle('draft-save', async value => {
    const input=documentInput.parse(value),file=input.projectPath===undefined?activeProjectPath:input.projectPath;
    if(file&&!knownProjects.has(path.resolve(file)))throw new Error('Путь проекта не был выбран в редакторе');
    await repository.saveDraft(await makeDocument(input),file);
  });
  handle('close-ready', async () => { owner()?.destroy(); });
  handle('bootstrap', async () => {
    let defaultFont = null;
    for (const font of process.platform === 'win32' ? ['C:/Windows/Fonts/arialbd.ttf', 'C:/Windows/Fonts/arial.ttf']
      : ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/System/Library/Fonts/Supplemental/Arial Bold.ttf']) {
      try { await access(font); defaultFont = { path: font, name: path.basename(font), url: registry.register(font).url, kind: 'font' as const }; break; } catch { /* Try the next installed font. */ }
    }
    const draft = await repository.draft();
    activeProjectPath = draft?.projectPath && (isProjectFile(draft.projectPath) || draft.projectPath.toLowerCase().endsWith('.json')) ? path.resolve(draft.projectPath) : null;
    if(activeProjectPath)knownProjects.add(activeProjectPath);
    const restored=draft?await restore(draft,activeProjectPath?path.dirname(activeProjectPath):undefined):null;
    unavailableSourcePath=restored?.source?null:draft?.sourcePath??null;
    if(restored)restored.recoveredDraft=true;
    return { library: repository.list(), draft: restored, defaultFont, jobs: queue.list() };
  });
  handle('preview-cancel', async () => { preview?.abort(); });
  handle('preview', async (source, rawTemplate, rawTrim, rawTime) => {
    const id = z.string().uuid().parse(source), hydrated = await repository.hydrate(templateSchema.parse(rawTemplate));
    const trim = documentInput.shape.trim.parse(rawTrim), time = z.number().finite().nonnegative().parse(rawTime);
    preview?.abort(); const controller = new AbortController(); preview = controller;
    const file = path.join(cache, `${randomUUID()}.png`);
    try { await renderPreview(resolveSource(id), hydrated.template, trim, time, file, controller.signal); return registry.register(file).url; }
    finally { if (preview === controller) preview = undefined; }
  });
  handle('render-start', async raw => {
    const input = z.object({ sourceId: z.string().uuid(), template: templateSchema, trim: documentInput.shape.trim,
      name: z.string().min(1).max(200), autoUpload: z.boolean(), driveFolderId: z.string().min(1).optional(), allowSoftwareFallback: z.boolean() }).parse(raw);
    const source = sources.get(input.sourceId); if (!source) throw new Error('Выберите исходный клип');
    validateTrim(input.trim, source.media.durationSec);
    const hydrated = await repository.hydrate(input.template);
    if (hydrated.warnings.length) throw new Error(hydrated.warnings.join('\n'));
    if (input.autoUpload && (!input.driveFolderId || !await publishing.canArchive())) throw new Error('Подключите Google Drive и выберите папку для автозагрузки');
    const baseName = `${path.parse(source.name).name}_vertical_${Date.now()}.mp4`;
    const result = await dialog.showSaveDialog(window(), { defaultPath: path.join(app.getPath('videos'), baseName), filters: [{ name: 'MP4', extensions: ['mp4'] }] });
    if (result.canceled || !result.filePath) return null;
    try { await stat(result.filePath); throw new Error('Файл уже существует. Выберите новое имя, чтобы сохранить оба видео.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return queue.enqueue(input.name, result.filePath, { ...input, template: hydrated.template, outputPath: result.filePath });
  });
  handle('render-cancel', async id => { queue.cancel(z.string().uuid().parse(id)); });
  handle('jobs', async () => queue.list());
  handle('reveal', async id => {
    const job = queue.list().find(j => j.id === z.string().uuid().parse(id));
    if (!job?.outputUrl) throw new Error('Выходной файл ещё не создан'); shell.showItemInFolder(job.outputPath);
  });
  const shutdown = () => { preview?.abort(); queue.shutdown(); };
  app.on('before-quit', shutdown);
  return { registry, repository, queue, shutdown };
}

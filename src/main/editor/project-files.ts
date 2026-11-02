import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { stat, readFile, mkdir, mkdtemp, copyFile, rename, rm } from 'node:fs/promises';
import { projectSchema, type ProjectFile, type ProjectExport } from '../../shared/editor';
import { PROJECT_EXTENSION, projectFilename } from '../../shared/project';
import { atomicJson } from './atomic-json';

const pathKey = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
/** Update every persisted reference, including the original image needed by AI Restore. */
export function mapProjectPaths(raw: ProjectFile, mapper: (file: string) => string): ProjectFile {
  const project = projectSchema.parse(raw);
  if (project.sourcePath) project.sourcePath = mapper(project.sourcePath);
  for (const o of project.template.overlays) {
    if (o.type === 'text') o.style.font_file = mapper(o.style.font_file);
    else {
      o.source_path = mapper(o.source_path);
      if (o.background_removal?.mode === 'ai_matting') o.background_removal.original_source_path = mapper(o.background_removal.original_source_path);
    }
  }
  for (const track of project.template.timeline?.tracks ?? []) for (const clip of track.clips) if (clip.media_type !== 'text') clip.source_path = mapper(clip.source_path);
  return project;
}
export function resolveProjectPaths(project: ProjectFile, directory: string): ProjectFile { return mapProjectPaths(project, file => path.resolve(directory, file)); }
export function relativeProjectPaths(project: ProjectFile, directory: string): ProjectFile {
  return mapProjectPaths(project, file => {
    const relative = path.relative(directory, path.resolve(file));
    return path.isAbsolute(relative) ? file : relative.split(path.sep).join('/');
  });
}
export async function readProjectFile(file: string): Promise<ProjectFile> {
  if ((await stat(file)).size > 32 * 1024 * 1024) throw new Error('Файл проекта больше 32 MB');
  let data: unknown;
  try { data = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, '')); } catch { throw new Error('Не удалось прочитать проект: повреждённый JSON'); }
  if (!data || typeof data !== 'object' || !('format' in data) || data.format !== 'AutoClippingUpgrader') throw new Error('Это не проект AutoClippingUpgrader');
  if (!('version' in data) || data.version !== 1) throw new Error('Неподдерживаемая версия проекта');
  return resolveProjectPaths(projectSchema.parse(data), path.dirname(path.resolve(file)));
}
export async function writeProjectFile(file: string, project: ProjectFile): Promise<void> {
  const destination = path.resolve(file);
  mapProjectPaths(project, source => { if (pathKey(source) === pathKey(destination)) throw new Error('Проект не может перезаписать исходный медиафайл'); return source; });
  await atomicJson(destination, relativeProjectPaths(project, path.dirname(destination)));
}

/** Collect media into a new owned folder; publish the manifest only after every copy succeeds. */
export async function exportProjectWithMedia(file: string, raw: ProjectFile): Promise<ProjectExport> {
  const destination = path.resolve(file), parent = path.dirname(destination), project = projectSchema.parse(raw);
  if (path.extname(destination).toLowerCase() !== PROJECT_EXTENSION) throw new Error('Экспорт проекта требует расширение .acup');
  const files = new Map<string, { source: string; name: string; size: number; modified: number }>();
  mapProjectPaths(project, file => {
    const source = path.resolve(file), key = pathKey(source);
    if (key === pathKey(destination)) throw new Error('Проект не может перезаписать исходный медиафайл');
    if (!files.has(key)) {
      const hash = createHash('sha256').update(key).digest('hex').slice(0, 16);
      const name = `${hash}-${path.basename(source).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(-160)}`;
      files.set(key, { source, name, size: 0, modified: 0 });
    }
    return file;
  });
  for (const item of files.values()) {
    let info; try { info = await stat(item.source); } catch { throw new Error(`Для экспорта найдите недоступный файл: ${path.basename(item.source)}`); }
    if (!info.isFile()) throw new Error(`Это не медиафайл: ${path.basename(item.source)}`);
    item.size = info.size; item.modified = info.mtimeMs;
  }
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(path.join(parent, '.acup-export-'));
  const mediaName = `${path.parse(projectFilename(path.parse(destination).name)).name}.media-${randomUUID().slice(0,8)}`;
  const stagedMedia = path.join(staging, mediaName), finalMedia = path.join(parent, mediaName);
  let mediaPublished = false, complete = false;
  const cleanOwned = async (directory: string, expectedParent: string) => {
    if (path.dirname(path.resolve(directory)) !== path.resolve(expectedParent)) throw new Error('Unsafe project export cleanup');
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await mkdir(stagedMedia);
    for (const item of files.values()) {
      await copyFile(item.source, path.join(stagedMedia, item.name));
      const [current, copied] = await Promise.all([stat(item.source),stat(path.join(stagedMedia,item.name))]);
      if (current.size !== item.size || current.mtimeMs !== item.modified || copied.size !== item.size) throw new Error(`Исходник изменился во время экспорта: ${path.basename(item.source)}`);
    }
    const exported = mapProjectPaths(project, source => `${mediaName}/${files.get(pathKey(source))!.name}`);
    await rename(stagedMedia,finalMedia); mediaPublished = true;
    // atomicJson also preserves an existing manifest if writing fails.
    await atomicJson(destination,exported); complete = true;
    return { path:destination,mediaCount:files.size,bytes:[...files.values()].reduce((total,f)=>total+f.size,0) };
  } finally {
    if (mediaPublished && !complete) await cleanOwned(finalMedia,parent);
    await cleanOwned(staging,parent);
  }
}

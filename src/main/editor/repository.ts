import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { templateSchema, type Template } from '../../shared/template';
import { projectSchema, type HydratedTemplate, type LibraryEntry, type ProjectFile } from '../../shared/editor';
import { newTemplate } from '../../shared/defaults';
import { fontMetadata } from './fonts';
import { isRichText } from '../../shared/layer-effects';
import type { MediaRegistry } from './media-registry';
import { segmentNeedsMedia } from '../../shared/timeline';

export async function atomicJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temp, JSON.stringify(value, null, 2), { flag: 'wx', encoding: 'utf8' }); await rename(temp, file); }
  finally { await rm(temp, { force: true }); }
}
export class EditorRepository {
  private entries = new Map<string, { template: Template; builtIn: boolean }>();
  private writes: Promise<unknown> = Promise.resolve();
  constructor(readonly root: string, private registry: MediaRegistry) {}
  async initialize() {
    const clean = newTemplate();
    this.entries.set(clean.template_id, { template: clean, builtIn: true });
    const focus = newTemplate(); focus.template_id = 'tpl_focus_crop'; focus.template_name = 'Focus / Full Frame';
    focus.main_clip_layout.source_aspect_handling = 'center_crop';
    focus.main_clip_layout.Position = { x: 0, y: 0, width: 1080, height: 1920, scale_mode: 'cover' };
    this.entries.set(focus.template_id, { template: focus, builtIn: true });
    const square = newTemplate(); square.template_id = 'tpl_square_stage'; square.template_name = 'Gaming / Square Stage';
    square.main_clip_layout.Position = { x: 0, y: 420, width: 1080, height: 1080, scale_mode: 'cover' };
    this.entries.set(square.template_id, { template: square, builtIn: true });
    await mkdir(path.join(this.root, 'templates'), { recursive: true });
    for (const name of await readdir(path.join(this.root, 'templates'))) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      try {
        const template = templateSchema.parse(JSON.parse(await readFile(path.join(this.root, 'templates', name), 'utf8')));
        this.entries.set(template.template_id, { template, builtIn: false });
      } catch { /* A damaged individual template does not hide the rest of the library. */ }
    }
  }
  list(): LibraryEntry[] {
    return [...this.entries.values()].map(({ template: t, builtIn }) => ({ id: t.template_id, name: t.template_name,
      width: t.canvas.width, height: t.canvas.height, layers: t.overlays.length, builtIn }));
  }
  async hydrate(raw: Template, directory = this.root): Promise<HydratedTemplate> {
    const template = templateSchema.parse(raw), assets: Record<string, string> = {}, warnings: string[] = [];
    for (const overlay of template.overlays) {
      const original = overlay.type === 'text' ? overlay.style.font_file : overlay.source_path;
      const absolute = path.resolve(directory, original);
      if (overlay.type === 'text') overlay.style.font_file = absolute;
      else overlay.source_path = absolute;
      try {
        if (!(await stat(absolute)).isFile()) throw new Error('Not a file');
        const extension = path.extname(absolute).toLowerCase();
        if (!(overlay.type === 'text' ? ['.ttf', '.otf'] : overlay.type === 'image' ? ['.png', '.jpg', '.jpeg', '.gif', '.webp'] : ['.mp4', '.mov', '.webm', '.mkv', '.avi']).includes(extension))
          throw new Error('Unsupported asset');
        assets[absolute] = this.registry.register(absolute).url;
        if (overlay.type === 'text' && isRichText(overlay)) overlay.style.font_family = fontMetadata(absolute).family;
      } catch { if (overlay.enabled !== false) warnings.push(`«${overlay.name}»: файл недоступен — ${path.basename(absolute)}`); }
      if (overlay.type !== 'text' && overlay.background_removal?.mode === 'ai_matting') {
        overlay.background_removal.original_source_path = path.resolve(directory, overlay.background_removal.original_source_path);
        try { assets[overlay.background_removal.original_source_path] = this.registry.register(overlay.background_removal.original_source_path).url; } catch {}
      }
    }
    for (const track of template.timeline?.tracks ?? []) for (const clip of track.clips) {
      if (clip.media_type === 'text') continue;
      const absolute = path.resolve(directory, clip.source_path); clip.source_path = absolute;
      try {
        if (!(await stat(absolute)).isFile()) throw new Error('Not a file');
        const allowed = clip.media_type === 'image' ? ['.png', '.jpg', '.jpeg', '.gif', '.webp'] : ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'];
        if (!allowed.includes(path.extname(absolute).toLowerCase())) throw new Error('Unsupported media');
        assets[absolute] = this.registry.register(absolute).url;
      } catch { if (segmentNeedsMedia(clip, track, template.timeline!)) warnings.push(`«${clip.name}»: файл сегмента недоступен — ${path.basename(absolute)}`); }
    }
    return { template, assets, warnings };
  }
  async load(id: string): Promise<HydratedTemplate> {
    const entry = this.entries.get(id); if (!entry) throw new Error('Шаблон не найден');
    return this.hydrate(entry.template);
  }
  async save(raw: Template) {
    const hydrated = await this.hydrate(raw), template = hydrated.template;
    const file = path.join(this.root, 'templates', `${createHash('sha256').update(template.template_id).digest('hex')}.json`);
    await atomicJson(file, template); this.entries.set(template.template_id, { template, builtIn: false });
    return this.list();
  }
  async readTemplate(file: string) { return this.hydrate(JSON.parse(await readFile(file, 'utf8')), path.dirname(file)); }
  async readProject(file: string): Promise<ProjectFile> { return projectSchema.parse(JSON.parse(await readFile(file, 'utf8'))); }
  saveDraft(document: ProjectFile) {
    const value = structuredClone(document);
    const task = this.writes.then(() => atomicJson(path.join(this.root, 'draft.json'), value));
    this.writes = task.catch(() => {}); return task;
  }
  async draft(): Promise<ProjectFile | null> {
    try { return await this.readProject(path.join(this.root, 'draft.json')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; return null; }
  }
}

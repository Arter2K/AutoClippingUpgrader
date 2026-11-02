import { create } from 'zustand';
import { newTemplate } from '../../shared/defaults';
import { templateSchema, type Template, type Overlay, type Trim } from '../../shared/template';
import type { EditorDocument, HydratedTemplate, LibraryEntry, MediaAsset, SourceMedia, RenderJob } from '../../shared/editor';
import { resizeCanvas } from '../../shared/geometry';
import { resolvedTextStyle, chromaSettings } from '../../shared/layer-effects';
import { removeImageBackground } from '../features/background/ai-client';
import { migrateTimeline, syncOverlayClips, newTrack } from '../../shared/timeline-migration';
import { timelineDuration } from '../../shared/timeline';

interface Snapshot { template: Template; trim: Trim }
interface EditorStore {
  initialized: boolean; loading: boolean; name: string; template: Template; source: SourceMedia | null;
  assets: Record<string, string>; library: LibraryEntry[]; defaultFont: MediaAsset | null;
  trim: Trim; playhead: number; playing: boolean; muted: boolean; selectedId: string;
  grid: boolean; snap: boolean; zoom: number; revision: number; draftStatus: 'saved' | 'saving' | 'error';
  past: Snapshot[]; future: Snapshot[]; jobs: RenderJob[]; tab: 'render' | 'publish' | 'layer';
  pickingColorFor: string | null;
  aiTasks: Record<string, { running: boolean; message: string; fraction: number }>;
  pickColor(id: string, hex: string): void; removeBackground(id: string): Promise<void>; cancelBackground(id: string): void;
  autoUpload: boolean; driveFolderId: string; fallback: boolean;
  notification: { message: string; kind: 'error' | 'info' } | null;
  bootstrap(): Promise<void>; change(recipe: (template: Template) => void, record?: boolean): void;
  checkpoint(): void; undo(): void; redo(): void; select(id: string): void;
  setTrim(trim: Trim, record?: boolean): void; setSource(source: SourceMedia): void;
  applyTemplate(value: HydratedTemplate): void; applyDocument(document: EditorDocument): void;
  addText(): Promise<void>; addMedia(kind: 'image' | 'video'): Promise<void>;
  updateOverlay(id: string, update: (overlay: Overlay) => void, record?: boolean): void;
  duplicateLayer(id: string): void; deleteLayer(id: string): void; moveLayer(id: string, direction: number): void;
  resize(width: number, height: number): void; notify(message: string, kind?: 'error' | 'info'): void;
  upsertJob(job: RenderJob): void;
}
const snapshot = (state: EditorStore): Snapshot => ({ template: structuredClone(state.template), trim: { ...state.trim } });
const history = (state: EditorStore) => ({ past: [...state.past.slice(-49), snapshot(state)], future: [] as Snapshot[] });
export const useEditorStore = create<EditorStore>((set, get) => ({
  initialized: false, loading: false, name: 'Untitled project', template: newTemplate(), source: null,
  assets: {}, library: [], defaultFont: null, trim: { inSec: 0, outSec: 10 }, playhead: 0,
  playing: false, muted: false, selectedId: 'main', grid: false, snap: true, zoom: 1,
  revision: 0, draftStatus: 'saved', past: [], future: [], jobs: [], tab: 'render',
  autoUpload: false, driveFolderId: '', fallback: true, notification: null,
  pickingColorFor: null, aiTasks: {},
  async bootstrap() {
    if (get().initialized || get().loading) return;
    set({ loading: true });
    try {
      const value = await window.desktop.editor.bootstrap();
      set({ library: value.library, defaultFont: value.defaultFont, jobs: value.jobs,
        assets: value.defaultFont ? { [value.defaultFont.path]: value.defaultFont.url } : {} });
      if (value.draft) get().applyDocument(value.draft);
      set({ initialized: true, revision: 0, draftStatus: 'saved' });
    } catch (error) { get().notify(String(error)); set({ initialized: true }); }
    finally { set({ loading: false }); }
  },
  change(recipe, record = true) {
    const state = get(), template = structuredClone(state.template); recipe(template);
    if (template.timeline) {
      const added = template.overlays.filter(o => !state.template.overlays.some(previous => previous.id === o.id)).map(o => o.id);
      if (added.length) syncOverlayClips(template, template.timeline, added);
      for (const track of template.timeline.tracks) {
        track.clips = track.clips.filter(c => !c.overlay_id || template.overlays.some(o => o.id === c.overlay_id));
        for (const c of track.clips) {
          const o = template.overlays.find(o => o.id === c.overlay_id), previous = state.template.overlays.find(o => o.id === c.overlay_id);
          if (o) c.enabled = o.enabled !== false;
          if (o && o.type !== 'text') c.source_path = o.source_path;
          if (o && previous && JSON.stringify(o.timing) !== JSON.stringify(previous.timing)) {
            const duration = template.timeline.total_duration_sec;
            c.timeline_start_sec = o.timing.full_duration ? 0 : o.timing.start_offset_sec;
            c.duration_sec = Math.max(1 / template.canvas.fps, (o.timing.full_duration ? duration : o.timing.end_offset_sec ?? duration) - c.timeline_start_sec);
            c.source_out_sec = c.source_in_sec + c.duration_sec;
          }
        }
      }
      template.timeline.total_duration_sec = timelineDuration(template.timeline);
    }
    const main = template.timeline?.tracks.flatMap(t => t.clips).filter(c => c.use_template_main_layout);
    set({ template, ...(main?.length === 1 ? { trim: { inSec: main[0]!.source_in_sec, outSec: main[0]!.source_out_sec } } : {}), revision: state.revision + 1, ...(record ? history(state) : {}) });
  },
  checkpoint() { set(history(get())); },
  undo() {
    const state = get(), previous = state.past.at(-1); if (!previous) return;
    set({ ...structuredClone(previous), past: state.past.slice(0, -1), future: [...state.future, snapshot(state)],
      revision: state.revision + 1, playing: false, selectedId: 'main', playhead: previous.template.timeline ? 0 : previous.trim.inSec });
  },
  redo() {
    const state = get(), next = state.future.at(-1); if (!next) return;
    set({ ...structuredClone(next), past: [...state.past, snapshot(state)], future: state.future.slice(0, -1),
      revision: state.revision + 1, playing: false, selectedId: 'main', playhead: next.template.timeline ? 0 : next.trim.inSec });
  },
  select(selectedId) { set({ selectedId, tab: 'layer' }); },
  setTrim(trim, record = true) {
    const state = get(), duration = state.source?.media.durationSec ?? 86400;
    if (trim.inSec < 0 || trim.outSec > duration || trim.outSec <= trim.inSec) return;
    if (state.template.timeline) {
      const template = structuredClone(state.template), main = template.timeline!.tracks.flatMap(t => t.clips).filter(c => c.use_template_main_layout);
      if (main.length !== 1) return;
      Object.assign(main[0]!, { source_in_sec: trim.inSec, source_out_sec: trim.outSec, duration_sec: trim.outSec - trim.inSec });
      main[0]!.fade_in_sec = Math.min(main[0]!.fade_in_sec, main[0]!.duration_sec); main[0]!.fade_out_sec = Math.min(main[0]!.fade_out_sec, main[0]!.duration_sec);
      for (const track of template.timeline!.tracks) for (const c of track.clips) {
        const o = template.overlays.find(o => o.id === c.overlay_id);
        if (o?.timing.full_duration && template.timeline!.tracks.flatMap(t => t.clips).filter(clip => clip.overlay_id === o.id).length === 1) {
          c.duration_sec = Math.min(trim.outSec - trim.inSec, (c.source_duration_sec ?? Infinity) - c.source_in_sec); c.source_out_sec = c.source_in_sec + c.duration_sec;
          c.fade_in_sec = Math.min(c.fade_in_sec, c.duration_sec); c.fade_out_sec = Math.min(c.fade_out_sec, c.duration_sec);
        }
      }
      template.timeline!.total_duration_sec = timelineDuration(template.timeline!);
      set({ template, trim, playhead: 0, playing: false, revision: state.revision + 1, ...(record ? history(state) : {}) }); return;
    }
    set({ trim, playhead: Math.max(trim.inSec, Math.min(trim.outSec - 0.001, state.playhead)), playing: false,
      revision: state.revision + 1, ...(record ? history(state) : {}) });
  },
  setSource(source) {
    const state = get();
    if (state.source && state.template.timeline && source.path) {
      get().change(t => {
        const timeline = t.timeline!, track = newTrack('video', timeline.tracks, crypto.randomUUID());
        track.clips.push({ id: crypto.randomUUID(), name: source.name, media_type: 'video', source_path: source.path!,
          timeline_start_sec: state.playhead, duration_sec: source.media.durationSec, source_in_sec: 0, source_out_sec: source.media.durationSec,
          source_duration_sec: source.media.durationSec, has_audio: source.media.hasAudio, volume: 1, muted: false,
          fade_in_sec: 0, fade_out_sec: 0, use_template_main_layout: false,
          transform: { x: 0, y: 0, width: t.canvas.width, height: t.canvas.height, scale: 1, opacity: 1 } });
        timeline.tracks.push(track);
      });
      set({ assets: { ...get().assets, [source.path]: source.url }, playing: false }); return;
    }
    const out = Math.min(30, Math.floor(source.media.durationSec * 10) / 10 || source.media.durationSec);
    const template = structuredClone(get().template); delete template.timeline;
    if (source.path) template.timeline = migrateTimeline(template, source, { inSec: 0, outSec: out });
    set({ source, template, assets: { ...get().assets, ...(source.path ? { [source.path]: source.url } : {}) }, trim: { inSec: 0, outSec: out }, playhead: 0, playing: false, past: [], future: [], revision: get().revision + 1 });
  },
  applyTemplate(value) {
    const state = get();
    if (!value.template.timeline && state.template.timeline) {
      value.template.timeline = structuredClone(state.template.timeline);
      value.template.timeline.tracks = value.template.timeline.tracks.filter(track => !track.clips.length || track.clips.some(c => !c.overlay_id));
      for (const track of value.template.timeline.tracks) track.clips = track.clips.filter(c => !c.overlay_id);
      syncOverlayClips(value.template, value.template.timeline);
    } else if (!value.template.timeline && state.source?.path) value.template.timeline = migrateTimeline(value.template, state.source, state.trim);
    set({ ...history(state), template: value.template, assets: { ...state.assets, ...value.assets },
      selectedId: 'main', playing: false, playhead: Math.min(state.playhead, Math.max(0, (value.template.timeline?.total_duration_sec ?? state.trim.outSec) - .001)), revision: state.revision + 1 });
    if (value.warnings.length) get().notify(value.warnings.join('\n'));
  },
  applyDocument(document) {
    if (!document.template.timeline && document.source?.path) document.template.timeline = migrateTimeline(document.template, document.source, document.trim);
    set({ template: document.template, name: document.name, source: document.source, trim: document.trim,
      assets: { ...get().assets, ...document.assets, ...(document.source?.path ? { [document.source.path]: document.source.url } : {}) }, playhead: document.template.timeline ? Math.min(document.template.timeline.playhead_sec, Math.max(0, document.template.timeline.total_duration_sec - 0.001)) : document.trim.inSec, playing: false,
      selectedId: 'main', past: [], future: [], revision: get().revision + 1, autoUpload: document.settings?.autoUpload ?? false,
      driveFolderId: document.settings?.driveFolderId ?? '', fallback: document.settings?.fallback ?? true });
    if (document.warnings.length) get().notify(document.warnings.join('\n'));
  },
  async addText() {
    let font = get().defaultFont;
    if (!font) font = await window.desktop.editor.selectAsset('font');
    if (!font) return;
    set({ assets: { ...get().assets, [font.path]: font.url } });
    const id = crypto.randomUUID(), t = get().template;
    get().change(template => { template.overlays.push({ id, type: 'text', name: 'Hook title', text_content: 'HIGHLIGHT CLIP', z_index: Math.max(0, ...template.overlays.map(o => o.z_index)) + 1,
      position: { x: t.canvas.width / 2, y: Math.round(t.canvas.height * 0.8), anchor: 'center' }, scale: 1, opacity: 1,
      style: { font_file: font!.path, font_family: font!.family ?? 'Arial', font_size: Math.round(t.canvas.width * 0.0593), font_color: '#ffffff', stroke_color: '#000000', stroke_width: 3, shadow_color: 'rgba(0,0,0,0.6)', shadow_x: 2, shadow_y: 4,
        font_weight: '700', italic: false, uppercase: false, letter_spacing: 0, line_height: 1.15, text_align: 'center', fill_color: '#ffffff', fill_opacity: 1,
        stroke: { enabled: true, color: '#000000', width: 3 }, shadow: { enabled: true, color: '#000000', opacity: 0.6, offset_x: 2, offset_y: 4, blur: 0 },
        background_box: { enabled: false, color: '#6366f1', opacity: 0.9, padding_x: 28, padding_y: 14, border_radius: 16 } },
      animation: { in_preset: 'fade_in', out_preset: 'fade_out', duration_sec: 0.25 },
      timing: { full_duration: true, start_offset_sec: 0, end_offset_sec: null, fade_in_sec: 0.2, fade_out_sec: 0.2 } }); });
    set({ selectedId: id, tab: 'layer' });
  },
  async addMedia(kind) {
    const asset = await window.desktop.editor.selectAsset(kind); if (!asset) return;
    set({ assets: { ...get().assets, [asset.path]: asset.url } });
    const id = crypto.randomUUID(), t = get().template;
    get().change(template => { template.overlays.push({ id, type: kind, source_path: asset.path, name: asset.name,
      z_index: Math.max(0, ...template.overlays.map(o => o.z_index)) + 1, scale: 1, opacity: 1,
      position: { x: Math.round(t.canvas.width * 0.25), y: Math.round(t.canvas.height * 0.13), width: Math.round(t.canvas.width * 0.5), height: Math.round(t.canvas.width * (kind === 'image' ? 0.125 : 0.28125)) },
      timing: { full_duration: true, start_offset_sec: 0, end_offset_sec: null, fade_in_sec: 0.2, fade_out_sec: 0.2 } }); });
    if (kind === 'video' && asset.media) get().change(t => {
      const clip = t.timeline?.tracks.flatMap(track => track.clips).find(c => c.overlay_id === id);
      if (clip) { clip.has_audio = asset.media!.hasAudio; clip.muted = false; clip.source_duration_sec = asset.media!.durationSec;
        clip.duration_sec = Math.min(clip.duration_sec, asset.media!.durationSec); clip.source_out_sec = clip.source_in_sec + clip.duration_sec; }
    }, false);
    set({ selectedId: id, tab: 'layer' });
  },
  updateOverlay(id, update, record = true) { get().change(t => { const layer = t.overlays.find(o => o.id === id); if (layer) update(layer); }, record); },
  duplicateLayer(id) {
    const original = get().template.overlays.find(o => o.id === id); if (!original) return;
    const layer = structuredClone(original); layer.id = crypto.randomUUID(); layer.name += ' copy'; layer.position.x += 20; layer.position.y += 20; layer.z_index++;
    get().change(t => { t.overlays.push(layer); }); set({ selectedId: layer.id });
  },
  deleteLayer(id) { get().change(t => { t.overlays = t.overlays.filter(o => o.id !== id); }); set({ selectedId: 'main' }); },
  moveLayer(id, direction) {
    const sorted = [...get().template.overlays].sort((a, b) => a.z_index - b.z_index), index = sorted.findIndex(o => o.id === id), next = index + direction;
    if (index < 0 || next < 0 || next >= sorted.length) return;
    [sorted[index], sorted[next]] = [sorted[next]!, sorted[index]!];
    get().change(t => { t.overlays.forEach(o => { o.z_index = sorted.findIndex(item => item.id === o.id); }); });
  },
  resize(width, height) { const state = get(); set({ ...history(state), template: resizeCanvas(state.template, width, height), revision: state.revision + 1 }); },
  notify(message, kind = 'error') { set({ notification: { message, kind } }); },
  upsertJob(job) { set({ jobs: [...get().jobs.filter(j => j.id !== job.id), job].sort((a, b) => b.createdAt - a.createdAt) }); },
  pickColor(id, hex) {
    if (!/^#[a-f\d]{6}$/i.test(hex)) return;
    get().updateOverlay(id, o => {
      if (o.type === 'text') return;
      if (o.background_removal?.mode === 'bcc_chromakey_studio') { o.background_removal.primary_key.key_color = hex; return; }
      o.background_removal = { ...(chromaSettings(o) ?? { mode: 'chromakey', enabled: true, similarity: 0.15, blend: 0.05, despill: false }), key_color: hex };
      delete o.chroma_key;
    }); set({ pickingColorFor: null });
  },
  async removeBackground(id) {
    if (Object.values(get().aiTasks).some(task => task.running)) throw new Error('Дождитесь текущей AI-обработки или отмените её');
    const layer = get().template.overlays.find(o => o.id === id); if (!layer || layer.type !== 'image') return;
    const original = layer.source_path, url = get().assets[original]; if (!url) throw new Error('Исходное изображение недоступно');
    const controller = new AbortController(); aiControllers.set(id, controller);
    const progress = (message: string, fraction: number) => set(s => ({ aiTasks: { ...s.aiTasks, [id]: { running: true, message, fraction } } }));
    progress('Запуск локальной модели', 0);
      let completed = false;
      try {
        const bytes = await removeImageBackground(url, controller.signal, progress); controller.signal.throwIfAborted();
      const result = await window.desktop.editor.saveProcessedImage(original, bytes); controller.signal.throwIfAborted();
      set({ assets: { ...get().assets, [result.path]: result.url } });
        if (!get().template.overlays.some(o => o.id === id && o.type === 'image' && o.source_path === original)) return;
        get().updateOverlay(id, o => {
        if (o.type !== 'image' || o.source_path !== original) return;
        o.source_path = result.path; o.background_removal = { mode: 'ai_matting', enabled: true, original_source_path: original }; delete o.chroma_key;
      });
        completed = true; get().notify('Фон удалён локально. Прозрачный PNG сохранён в assets/processed.', 'info');
    } catch (error) { if (!controller.signal.aborted) throw error; }
      finally { aiControllers.delete(id); set(s => ({ aiTasks: { ...s.aiTasks, [id]: { running: false, message: controller.signal.aborted ? 'Отменено' : completed ? 'Готово' : 'Не применено', fraction: completed ? 1 : 0 } } })); }
  },
  cancelBackground(id) { aiControllers.get(id)?.abort(); },
}));
const aiControllers = new Map<string, AbortController>();

export function projectSnapshot() {
  const state = useEditorStore.getState();
  return { name: state.name, template: state.template.timeline ? { ...state.template, timeline: { ...state.template.timeline, playhead_sec: state.playhead } } : state.template, sourceId: state.source?.id ?? null, trim: state.trim,
    settings: { autoUpload: state.autoUpload, driveFolderId: state.driveFolderId, fallback: state.fallback } };
}
export async function task(action: () => Promise<unknown>) {
  try { await action(); } catch (error) { useEditorStore.getState().notify(error instanceof Error ? error.message : String(error)); }
}
export async function loadSource(action: () => Promise<SourceMedia | null>) {
  const request = ++sourceRequest;
  useEditorStore.setState({ loading: true });
  try { const source = await action(); if (source && request === sourceRequest) useEditorStore.getState().setSource(source); }
  catch (error) { if (request === sourceRequest) useEditorStore.getState().notify(error instanceof Error ? error.message : String(error)); }
  finally { if (request === sourceRequest) useEditorStore.setState({ loading: false }); }
}
let sourceRequest = 0;
export function validationMessage(t: Template): string | null {
  const result = templateSchema.safeParse(t); return result.success ? null : result.error.issues.map(i => i.message).join('\n');
}

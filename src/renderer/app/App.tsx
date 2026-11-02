import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowUpRight, Check, ChevronRight, Clapperboard, CloudUpload, Code2, FolderOpen, Keyboard, LoaderCircle, Plus, Redo2, Save, Settings2, SlidersHorizontal, Undo2, Upload, X } from 'lucide-react';
import { Button } from '../components/ui/button';
import { NumberField } from '../components/ui/fields';
import { useEditorStore, projectSnapshot, loadSource, task } from '../stores/editor-store';
import { TemplatePanel } from '../features/templates/TemplatePanel';
import { LayerPanel } from '../features/layers/LayerPanel';
import { PreviewCanvas } from '../features/canvas/PreviewCanvas';
import { MultiTrackTimeline, ClipInspector } from '../features/timeline/MultiTrackTimeline';
import { useTimelineStore } from '../stores/timeline-store';
import { RenderInspector, RenderAction } from '../features/render/RenderInspector';
import { ConnectionsPanel } from '../features/publishing/ConnectionsPanel';
import { templateSchema } from '../../shared/template';
import { ProjectMenu } from '../features/projects/ProjectMenu';
import { saveCurrentProject,openCurrentProject,newCurrentProject,dropCurrentProject,projectIsDirty } from '../features/projects/project-actions';
import { isProjectFile } from '../../shared/project';

export function App() {
  const name = useEditorStore(s => s.name), template = useEditorStore(s => s.template), source = useEditorStore(s => s.source), tab = useEditorStore(s => s.tab);
  const draftStatus = useEditorStore(s => s.draftStatus), initialized = useEditorStore(s => s.initialized), loading = useEditorStore(s => s.loading);
  const canUndo = useEditorStore(s => s.past.length > 0), canRedo = useEditorStore(s => s.future.length > 0), notification = useEditorStore(s => s.notification);
  const jobs = useEditorStore(s => s.jobs), lastOutput = jobs.find(job => !!job.publishFile)?.publishFile;
  const projectPath=useEditorStore(s=>s.projectPath),projectBusy=useEditorStore(s=>s.projectBusy);
  const dirty=useEditorStore(projectIsDirty);
  const [jsonOpen, setJsonOpen] = useState(false), [json, setJson] = useState(''), [jsonError, setJsonError] = useState('');
  const [canvasOpen, setCanvasOpen] = useState(false), [custom, setCustom] = useState({ width: 1080, height: 1920 });
  const [dragging, setDragging] = useState(false), [help, setHelp] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null), saveSequence = useRef(0);
  const openJson = () => { setJson(JSON.stringify(useEditorStore.getState().template, null, 2)); setJsonError(''); setJsonOpen(true); };
  const saveProject = () => task(()=>saveCurrentProject());
  useEffect(() => {
    void useEditorStore.getState().bootstrap();
    const offJob = window.desktop.editor.onJob(job => useEditorStore.getState().upsertJob(job));
    const offClose = window.desktop.editor.onPrepareClose(() => {
      void window.desktop.editor.saveDraft(projectSnapshot()).catch(() => {}).finally(() => void window.desktop.editor.confirmClose());
    });
    const offState = useEditorStore.subscribe((state, previous) => {
      if(state.projectBusy){if(saveTimer.current)clearTimeout(saveTimer.current);saveSequence.current++;return;}
      if (!state.initialized || !previous.projectBusy && state.revision === previous.revision && state.autoUpload === previous.autoUpload && state.driveFolderId === previous.driveFolderId && state.fallback === previous.fallback) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      useEditorStore.setState({ draftStatus: 'saving' }); const index = ++saveSequence.current;
      saveTimer.current = setTimeout(() => {
        void window.desktop.editor.saveDraft(projectSnapshot()).then(() => {
          if (index === saveSequence.current) useEditorStore.setState({ draftStatus: 'saved' });
        }).catch(() => { if (index === saveSequence.current) useEditorStore.setState({ draftStatus: 'error' }); });
      }, 650);
    });
    return () => { offJob(); offState(); offClose(); if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, []);
  useEffect(() => {
    if (!notification) return; const id = setTimeout(() => useEditorStore.setState({ notification: null }), notification.kind === 'error' ? 12000 : 3500);
    return () => clearTimeout(id);
  }, [notification]);
  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const state = useEditorStore.getState(), mod = event.ctrlKey || event.metaKey, key = event.key.toLowerCase();
      if (key === 'escape') { document.querySelector('.project-menu')?.removeAttribute('open'); setJsonOpen(false); setCanvasOpen(false); setHelp(false); useEditorStore.setState({ pickingColorFor: null }); return; }
      if (document.querySelector('[role="dialog"]')) return;
      if (mod && key === 's') { event.preventDefault(); target.blur(); const saveAs=event.shiftKey;setTimeout(() => void task(()=>saveCurrentProject(saveAs)), 0); return; }
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable) return;
      if (mod && key === 'o') { event.preventDefault(); void task(()=>openCurrentProject()); }
      else if (mod && key === 'i') { event.preventDefault(); void loadSource(() => window.desktop.editor.selectSource()); }
      else if (mod && key === 'z') { event.preventDefault(); if (event.shiftKey) state.redo(); else state.undo(); }
      else if (mod && key === 'y') { event.preventDefault(); state.redo(); }
      else if (state.template.timeline && ((!mod && (key === 's' || key === 'c')) || (mod && key === 'b'))) { event.preventDefault(); useTimelineStore.getState().splitClipAtPlayhead(); }
      else if (state.template.timeline && !mod && key === 'n') { event.preventDefault(); const s = useTimelineStore.getState(); s.setView({ snap_enabled: !s.timeline.snap_enabled }); }
      else if (state.template.timeline && ['delete', 'backspace'].includes(key) && useTimelineStore.getState().selectedClipId) { event.preventDefault(); useTimelineStore.getState().deleteClip(useTimelineStore.getState().selectedClipId!); }
      else if (!mod && key === 'g') { event.preventDefault(); useEditorStore.setState({ grid: !state.grid }); }
      else if (!mod && key === 'm') { event.preventDefault(); useEditorStore.setState({ muted: !state.muted }); }
      else if (state.source && !mod && key === ' ') { event.preventDefault(); useEditorStore.setState({ playing: !state.playing }); }
      else if (state.source && ['arrowleft', 'arrowright'].includes(key)) {
        event.preventDefault(); const step = event.shiftKey ? 0.1 : 1 / state.template.canvas.fps;
        useEditorStore.setState({ playhead: Math.max(0, Math.min((state.template.timeline?.total_duration_sec ?? state.source.media.durationSec) - 0.001, state.playhead + (key === 'arrowright' ? step : -step))), playing: false });
      } else if (state.source && !mod && (key === 'i' || key === 'o')) {
        event.preventDefault(); const value = Math.round(state.playhead * 10) / 10;
        state.setTrim(key === 'i' ? { ...state.trim, inSec: Math.min(state.trim.outSec - 0.1, value) } : { ...state.trim, outSec: Math.min(state.source.media.durationSec, Math.max(state.trim.inSec + 0.1, value)) });
      } else if (['delete', 'backspace'].includes(key) && state.selectedId !== 'main') { event.preventDefault(); state.deleteLayer(state.selectedId); }
    };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  }, []);
  useEffect(() => {
    if (!jsonOpen && !canvasOpen && !help) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]'); if (!dialog) return;
    const controls = () => Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea,select,[tabindex="0"]'));
    const frame = requestAnimationFrame(() => controls()[0]?.focus());
    const trap = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Tab') return; const all = controls(), first = all[0], last = all.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', trap);
    return () => { cancelAnimationFrame(frame); document.removeEventListener('keydown', trap); previous?.focus(); };
  }, [jsonOpen, canvasOpen, help]);
  const format = template.canvas.width === 1080 && template.canvas.height === 1920 ? '1080' : template.canvas.width === 1440 && template.canvas.height === 2560 ? '1440' : 'custom';
  return <div className="editor-app">
    <header className="app-header"><div className="brand"><span className="brand-icon"><Clapperboard size={21} strokeWidth={1.7} /></span><div><strong>AutoClipping<span>Upgrader</span></strong><small>CREATE. REFINE. SHARE.</small></div></div>
      <div className="project-breadcrumb"><ChevronRight size={13} /><input aria-label="Название проекта" value={name} onChange={event => useEditorStore.setState(s => ({ name: event.target.value, revision: s.revision + 1 }))} />
        <span className="project-file-state" title={projectPath??'Проект ещё не сохранён в файл'}>{projectPath?.split(/[\\/]/).at(-1)??'.acup'}{dirty?' *':''}</span>
        <span className={`autosave ${draftStatus}`} title="Автоматическое сохранение локального черновика">{draftStatus === 'saved' ? <Check size={11} /> : draftStatus === 'saving' ? <LoaderCircle size={11} className="spin" /> : <X size={11} />}{draftStatus === 'saved' ? 'Черновик сохранён' : draftStatus === 'saving' ? 'Сохранение…' : 'Не сохранён'}</span>
      </div>
      <div className="header-actions"><ProjectMenu/><Button size="icon" variant="ghost" disabled={projectBusy} title="Новый проект" aria-label="Новый проект" onClick={()=>void task(newCurrentProject)}><Plus size={16} /></Button><Button size="icon" variant="ghost" disabled={projectBusy} title="Открыть проект (Ctrl+O)" aria-label="Открыть проект" onClick={() => void task(()=>openCurrentProject())}><FolderOpen size={16} /></Button><Button size="icon" variant="ghost" disabled={projectBusy} title="Сохранить проект (Ctrl+S)" aria-label="Сохранить проект" onClick={saveProject}><Save size={16} /></Button>
        <span className="toolbar-divider" /><Button variant="default" size="sm" disabled={loading} onClick={() => void loadSource(() => window.desktop.editor.selectSource())}><Upload size={14} />Импорт медиа</Button>
      </div>
    </header>
    <div className={`workspace ${initialized ? '' : 'booting'}`}>
      <aside className="left-sidebar"><div className="sidebar-title"><span>PROJECT STUDIO</span><span className="version-pill">v0.7.0</span></div><TemplatePanel onJson={openJson} /><LayerPanel /></aside>
      <main className={`editor-center ${dragging ? 'is-dragging' : ''}`} onDragOver={event => { event.preventDefault(); if (event.dataTransfer.types.includes('Files')) setDragging(true); }}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }} onDrop={event => {
          event.preventDefault(); setDragging(false); const file = event.dataTransfer.files[0]; if (file) {if(isProjectFile(file.name))void task(()=>dropCurrentProject(file));else void loadSource(() => window.desktop.editor.dropSource(file));}
        }}>
        <div className="canvas-controls"><div><span className="workspace-heading">Холст</span><span className="aspect-badge">{template.canvas.aspect_ratio}</span>
          <select aria-label="Разрешение холста" value={format} onChange={event => {
            if (event.target.value === 'custom') { setCustom({ width: template.canvas.width, height: template.canvas.height }); setCanvasOpen(true); }
            else useEditorStore.getState().resize(event.target.value === '1080' ? 1080 : 1440, event.target.value === '1080' ? 1920 : 2560);
          }}><option value="1080">1080 × 1920</option><option value="1440">1440 × 2560</option><option value="custom">Свой размер…</option></select>
          <button title="Произвольное разрешение" aria-label="Свой размер холста" onClick={() => { setCustom({ width: template.canvas.width, height: template.canvas.height }); setCanvasOpen(true); }}><Settings2 size={13} /></button>
        </div><div><Button size="icon" variant="ghost" disabled={!canUndo} title="Отменить (Ctrl+Z)" aria-label="Отменить правку" onClick={() => useEditorStore.getState().undo()}><Undo2 size={15} /></Button>
          <Button size="icon" variant="ghost" disabled={!canRedo} title="Повторить (Ctrl+Shift+Z)" aria-label="Повторить правку" onClick={() => useEditorStore.getState().redo()}><Redo2 size={15} /></Button></div>
        </div>
        <PreviewCanvas /><MultiTrackTimeline />
        {dragging && <div className="drop-overlay"><Upload size={35} /><strong>Отпустите, чтобы открыть клип</strong><span>Исходник останется на своём месте</span></div>}
      </main>
      <aside className="right-sidebar"><div className="inspector-title"><SlidersHorizontal size={14} /><span>INSPECTOR</span><span className="tiny-muted">{template.canvas.fps} FPS</span></div>
        <div className="inspector-tabs"><button aria-selected={tab === 'render'} className={tab === 'render' ? 'is-active' : ''} onClick={() => useEditorStore.setState({ tab: 'render' })}><SlidersHorizontal size={14} />Экспорт</button>
          <button aria-selected={tab === 'publish'} className={tab === 'publish' ? 'is-active' : ''} onClick={() => useEditorStore.setState({ tab: 'publish' })}><CloudUpload size={14} />Публикация</button><button aria-selected={tab === 'layer'} className={tab === 'layer' ? 'is-active' : ''} onClick={() => useEditorStore.setState({ tab: 'layer' })}>Слой</button></div>
        <div className="inspector-scroll"><div hidden={tab !== 'render'}><RenderInspector /></div><div hidden={tab !== 'publish'}><ConnectionsPanel renderedFile={lastOutput} /></div><div hidden={tab !== 'layer'}><ClipInspector /><LayerPanel mode="properties" /></div></div>
        <div className="render-footer" hidden={tab !== 'render'}><RenderAction /></div>
      </aside>
    </div>
    <footer className="app-statusbar"><span><span className={`status-dot ${source ? 'green' : ''}`} />{source ? `${source.name} · ${source.media.width} × ${source.media.height}` : 'Готов к первому клипу'}<span className="status-separator">/</span>Локальный монтаж</span>
      <div>{!source && <button disabled={loading || !initialized} onClick={() => void loadSource(() => window.desktop.editor.demoSource())}>Открыть тестовый клип <ArrowUpRight size={11} /></button>}
        <button onClick={() => setHelp(true)}><Keyboard size={12} />Горячие клавиши</button><button onClick={openJson}><Code2 size={12} />JSON</button></div></footer>
    <AnimatePresence>{notification && <motion.div className={`toast ${notification.kind}`} role={notification.kind === 'error' ? 'alert' : 'status'} initial={{ y: 18, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 12, opacity: 0 }}>
      {notification.kind === 'info' ? <Check size={16} /> : <span className="toast-error-symbol">!</span>}<pre>{notification.message}</pre><button aria-label="Закрыть уведомление" onClick={() => useEditorStore.setState({ notification: null })}><X size={15} /></button></motion.div>}</AnimatePresence>
    {jsonOpen && <div className="modal-scrim" onClick={() => setJsonOpen(false)}><section className="json-modal" role="dialog" aria-modal="true" aria-label="Редактор JSON" onClick={event => event.stopPropagation()}>
      <div className="modal-header"><div><Code2 size={18} /><h2>Редактор шаблона</h2><span>JSON</span></div><Button size="icon" variant="ghost" aria-label="Закрыть JSON" onClick={() => setJsonOpen(false)}><X size={17} /></Button></div>
      <textarea aria-label="JSON шаблона" spellCheck={false} value={json} onChange={event => setJson(event.target.value)} />
      {jsonError && <pre className="json-error">{jsonError}</pre>}<div className="modal-footer"><span>Схема проверяется перед применением</span><Button onClick={() => setJsonOpen(false)}>Отмена</Button><Button variant="default" onClick={() => {
        void (async () => { try { const t = templateSchema.parse(JSON.parse(json)); useEditorStore.getState().applyTemplate(await window.desktop.editor.hydrate(t)); setJsonOpen(false); } catch (error) { setJsonError(error instanceof Error ? error.message : String(error)); } })();
      }}>Применить JSON</Button></div>
    </section></div>}
    {canvasOpen && <div className="modal-scrim" onClick={() => setCanvasOpen(false)}><section className="small-modal" role="dialog" aria-modal="true" aria-label="Размер холста" onClick={event => event.stopPropagation()}>
      <div className="modal-header"><h2>Размер холста</h2><Button size="icon" variant="ghost" onClick={() => setCanvasOpen(false)}><X size={16} /></Button></div>
      <p>Слои и основной клип масштабируются вместе с холстом.</p><div className="field-grid"><NumberField label="Ширина холста" value={custom.width} min={2} max={8192} step={2} onValue={value => setCustom(s => ({ ...s, width: Math.round(value / 2) * 2 }))} />
        <NumberField label="Высота холста" value={custom.height} min={2} max={8192} step={2} onValue={value => setCustom(s => ({ ...s, height: Math.round(value / 2) * 2 }))} /></div>
      <Button variant="default" onClick={() => { useEditorStore.getState().resize(custom.width, custom.height); setCanvasOpen(false); }}>Изменить размер</Button>
    </section></div>}
    {help && <div className="modal-scrim" onClick={() => setHelp(false)}><section className="small-modal" role="dialog" aria-modal="true" aria-label="Горячие клавиши" onClick={event => event.stopPropagation()}>
      <div className="modal-header"><h2>Горячие клавиши</h2><Button size="icon" variant="ghost" onClick={() => setHelp(false)}><X size={16} /></Button></div>
      {[['Space', 'Воспроизведение / пауза'], ['← / →', 'На один кадр'], ['Shift + ← / →', 'На 0.1 сек'], ['S / Ctrl+B / C', 'Разрезать сегмент'], ['N', 'Привязка таймлайна'], ['Ctrl + колесо', 'Масштаб таймлайна'], ['I / O', 'In / Out целого исходника'], ['G / M', 'Сетка / звук'], ['Ctrl + Z', 'Отменить'], ['Ctrl + Shift + Z', 'Повторить'], ['Ctrl + I', 'Импорт видео'], ['Ctrl + O / S', 'Открыть / сохранить проект'], ['Delete', 'Удалить сегмент или слой']].map(([key, description]) => <div className="shortcut-row" key={key}><span>{description}</span><kbd>{key}</kbd></div>)}
    </section></div>}
  </div>;
}

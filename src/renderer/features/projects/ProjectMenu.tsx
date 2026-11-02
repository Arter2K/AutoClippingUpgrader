import { useEffect, useRef } from 'react';
import { ChevronDown, LoaderCircle } from 'lucide-react';
import { useEditorStore, task } from '../../stores/editor-store';
import { saveCurrentProject,openCurrentProject,newCurrentProject,exportCurrentProject } from './project-actions';

export function ProjectMenu(){
  const ref=useRef<HTMLDetailsElement>(null),busy=useEditorStore(s=>s.projectBusy);
  useEffect(()=>{const close=(e:globalThis.PointerEvent)=>{if(!ref.current?.contains(e.target as Node))ref.current?.removeAttribute('open');};window.addEventListener('pointerdown',close);return()=>window.removeEventListener('pointerdown',close);},[]);
  const run=(action:()=>Promise<unknown>)=>{ref.current?.removeAttribute('open');void task(action);};
  return <details className="project-menu" ref={ref}><summary aria-label="Меню проекта">{busy?<LoaderCircle size={13} className="spin"/>:'Файл'}<ChevronDown size={12}/></summary>
    <div role="menu"><strong>AutoClippingUpgrader · .acup</strong>
      <button role="menuitem" disabled={busy} onClick={()=>run(newCurrentProject)}>Новый проект</button>
      <button role="menuitem" disabled={busy} onClick={()=>run(()=>openCurrentProject())}>Открыть проект… <kbd>Ctrl+O</kbd></button>
      <button role="menuitem" disabled={busy} onClick={()=>run(()=>saveCurrentProject())}>Сохранить <kbd>Ctrl+S</kbd></button>
      <button role="menuitem" disabled={busy} onClick={()=>run(()=>saveCurrentProject(true))}>Сохранить как… <kbd>Ctrl+Shift+S</kbd></button>
      <hr/><button role="menuitem" disabled={busy} onClick={()=>run(()=>openCurrentProject(true))}>Импорт проекта…</button>
      <button role="menuitem" disabled={busy} onClick={()=>run(exportCurrentProject)}>Экспорт проекта с медиа…</button>
    </div>
  </details>;
}

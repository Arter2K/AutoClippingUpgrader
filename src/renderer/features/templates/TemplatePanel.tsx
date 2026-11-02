import { Download, Upload, Plus, Save, Copy, LayoutTemplate, Check, Braces } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { useEditorStore, task } from '../../stores/editor-store';
import { newTemplate } from '../../../shared/defaults';
import type { Template } from '../../../shared/template';

export function TemplatePanel({ onJson }: { onJson: () => void }) {
  const library = useEditorStore(s => s.library), template = useEditorStore(s => s.template);
  const save = () => task(async () => {
    const entries = await window.desktop.editor.saveTemplate(useEditorStore.getState().template);
    useEditorStore.setState({ library: entries }); useEditorStore.getState().notify('Шаблон сохранён в библиотеке', 'info');
  });
  const create = (from?: Template) => {
    const t = from ? structuredClone(from) : newTemplate();
    t.template_id = `tpl_${crypto.randomUUID()}`; t.template_name = from ? `${from.template_name} copy` : 'New template';
    useEditorStore.getState().applyTemplate({ template: t, assets: {}, warnings: [] });
  };
  return <section className="template-panel">
    <div className="panel-eyebrow"><span><LayoutTemplate size={13} /> ШАБЛОНЫ</span><Button size="icon" variant="ghost" title="Новый шаблон" aria-label="Новый шаблон" onClick={() => create()}><Plus size={15} /></Button></div>
    <div className="template-list">{library.map(entry => <button key={entry.id} className={`template-card ${entry.id === template.template_id ? 'is-selected' : ''}`}
      onClick={() => void task(async () => useEditorStore.getState().applyTemplate(await window.desktop.editor.loadTemplate(entry.id)))}>
      <span className={`template-mini mini-${entry.id.includes('focus') ? 'focus' : entry.id.includes('square') ? 'square' : 'blur'}`}><i /><b /></span>
      <span><strong>{entry.name}</strong><small>{entry.width} × {entry.height} <span>·</span> {entry.builtIn ? 'Встроенный' : `${entry.layers} слоёв`}</small></span>
      {entry.id === template.template_id && <Check size={14} className="accent" />}
    </button>)}</div>
    <div className="template-name-row"><input aria-label="Название шаблона" value={template.template_name} onChange={e => useEditorStore.getState().change(t => { t.template_name = e.target.value; }, false)} />
      <Button size="icon" variant="ghost" title="Сохранить шаблон" aria-label="Сохранить шаблон" onClick={save}><Save size={14} /></Button>
      <Button size="icon" variant="ghost" title="Копия шаблона" aria-label="Копия шаблона" onClick={() => create(template)}><Copy size={14} /></Button>
    </div>
    <div className="template-actions"><Button size="sm" variant="ghost" onClick={() => void task(async () => {
      const result = await window.desktop.editor.importTemplate(); if (result) useEditorStore.getState().applyTemplate(result);
    })}><Upload size={13} />Импорт</Button><Button size="sm" variant="ghost" onClick={() => void task(() => window.desktop.editor.exportTemplate(template))}><Download size={13} />Экспорт</Button>
      <Button size="icon" variant="ghost" title="Редактор JSON" aria-label="Редактор JSON" onClick={onJson}><Braces size={14} /></Button></div>
  </section>;
}

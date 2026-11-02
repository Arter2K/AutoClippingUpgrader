import { ArrowDown, ArrowUp, Copy, Eye, EyeOff, ImagePlus, Layers, Lock, Film, Trash2, Type, Unlock } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { NumberField, Section, SelectField, Toggle } from '../../components/ui/fields';
import { useEditorStore, task } from '../../stores/editor-store';
import { RichTextPanel } from './RichTextPanel';
import { BackgroundPanel } from '../background/BackgroundPanel';
import { VideoBackgroundPanel } from '../background/VideoBackgroundPanel';
import { useTimelineStore } from '../../stores/timeline-store';
import type { Overlay } from '../../../shared/template';

export function LayerPanel({ mode = 'list' }: { mode?: 'list' | 'properties' }) {
  const template = useEditorStore(s => s.template), selectedId = useEditorStore(s => s.selectedId), source = useEditorStore(s => s.source);
  const selected = template.overlays.find(o => o.id === selectedId);
  const selectLayer = (id: string) => { useTimelineStore.getState().selectClip(null); useEditorStore.getState().select(id); };
  const update = (recipe: (o: Overlay) => void) => useEditorStore.getState().updateOverlay(selectedId, recipe);
  const p = selected?.position ?? template.main_clip_layout.Position;
  const coord = (key: 'x' | 'y' | 'width' | 'height', value: number) => {
    if (selected) update(o => { if (key === 'x' || key === 'y') o.position[key] = value; else if (o.type !== 'text') o.position[key] = value; });
    else useEditorStore.getState().change(t => { t.main_clip_layout.Position[key] = value; });
  };
  const duration = useEditorStore(s => s.trim.outSec - s.trim.inSec);
  return <section className="layers-panel">
    {mode === 'list' && <><div className="panel-eyebrow"><span><Layers size={13} /> СЛОИ <b>{template.overlays.length + 1}</b></span><span className="tiny-muted">верх → передний план</span></div>
    <div className="add-layer-row"><Button size="sm" variant="outline" onClick={() => void task(() => useEditorStore.getState().addText())}><Type size={13} />Текст</Button>
      <Button size="sm" variant="outline" onClick={() => void task(() => useEditorStore.getState().addMedia('image'))}><ImagePlus size={13} />Фото</Button>
      <Button size="sm" variant="outline" onClick={() => void task(() => useEditorStore.getState().addMedia('video'))}><Film size={13} />Видео</Button></div>
    <div className="layer-list">{[...template.overlays].sort((a, b) => b.z_index - a.z_index).map(o => <div key={o.id} className={`layer-row ${selectedId === o.id ? 'is-selected' : ''} ${o.enabled === false ? 'is-hidden' : ''}`}>
      <button className="layer-select" onClick={() => selectLayer(o.id)}><span className={`layer-symbol ${o.type}`}>
        {o.type === 'text' ? <Type size={14} /> : o.type === 'image' ? <ImagePlus size={14} /> : <Film size={14} />}</span><span>{o.name}<small>{o.type === 'text' ? 'TEXT' : o.type.toUpperCase()} · Z {o.z_index}</small></span></button>
      <button className="subtle-icon" aria-label={`Видимость ${o.name}`} title="Видимость" onClick={() => useEditorStore.getState().updateOverlay(o.id, layer => { layer.enabled = layer.enabled === false; })}>{o.enabled === false ? <EyeOff size={13} /> : <Eye size={13} />}</button>
      <button className="subtle-icon" aria-label={`Блокировка ${o.name}`} title="Блокировка" onClick={() => useEditorStore.getState().updateOverlay(o.id, layer => { layer.locked = !layer.locked; })}>{o.locked ? <Lock size={12} /> : <Unlock size={12} />}</button>
    </div>)}
      <div className={`layer-row ${selectedId === 'main' ? 'is-selected' : ''}`}><button className="layer-select" onClick={() => selectLayer('main')}>
        <span className="layer-symbol main"><Film size={14} /></span><span>Основной клип<small>{source ? source.name : 'SOURCE VIDEO'}</small></span></button><span className="tiny-muted">BASE</span></div>
    </div>
    </>}
    {mode === 'properties' && <div className="layer-properties">
      <div className="properties-header"><span>{selected ? 'ПАРАМЕТРЫ СЛОЯ' : 'КОМПОЗИЦИЯ КЛИПА'}</span>{selected && <div>
        <Button size="icon" variant="ghost" title="Слой выше" onClick={() => useEditorStore.getState().moveLayer(selected.id, 1)}><ArrowUp size={13} /></Button>
        <Button size="icon" variant="ghost" title="Слой ниже" onClick={() => useEditorStore.getState().moveLayer(selected.id, -1)}><ArrowDown size={13} /></Button>
        <Button size="icon" variant="ghost" title="Копировать слой" onClick={() => useEditorStore.getState().duplicateLayer(selected.id)}><Copy size={13} /></Button>
        <Button size="icon" variant="ghost" title="Удалить слой" aria-label="Удалить слой" onClick={() => useEditorStore.getState().deleteLayer(selected.id)}><Trash2 size={13} /></Button>
      </div>}</div>
      {selected && <label className="field-label">Название<input value={selected.name} onChange={e => update(o => { o.name = e.target.value; })} /></label>}
      <div className="field-grid"><NumberField label="X" value={p.x} onValue={value => coord('x', value)} /><NumberField label="Y" value={p.y} onValue={value => coord('y', value)} />
        {'width' in p && <><NumberField label="Width" value={p.width} min={1} max={16384} onValue={value => coord('width', value)} /><NumberField label="Height" value={p.height} min={1} max={16384} onValue={value => coord('height', value)} /></>}
      </div>
      {!selected ? <>
        <SelectField label="Режим композиции" value={template.main_clip_layout.source_aspect_handling} onValue={value => useEditorStore.getState().change(t => {
          t.main_clip_layout.source_aspect_handling = value as typeof t.main_clip_layout.source_aspect_handling;
          if (value === 'custom_crop' && !t.main_clip_layout.source_crop) t.main_clip_layout.source_crop = { x: 0, y: 0, width: source?.media.width ?? 1920, height: source?.media.height ?? 1080 };
        })} options={[{ value: 'blur_pad', label: 'Blur pad · размытый фон' }, { value: 'center_crop', label: 'Center crop · заполнить' }, { value: 'custom_crop', label: 'Custom crop · область' }]} />
        <SelectField label="Масштабирование" value={template.main_clip_layout.Position.scale_mode} onValue={value => useEditorStore.getState().change(t => { t.main_clip_layout.Position.scale_mode = value as typeof t.main_clip_layout.Position.scale_mode; })}
          options={[{ value: 'fit_width', label: 'По ширине' }, { value: 'contain', label: 'Вписать целиком' }, { value: 'cover', label: 'Заполнить область' }]} />
        {template.main_clip_layout.source_aspect_handling === 'custom_crop' && template.main_clip_layout.source_crop && <div className="field-grid">
          {(['x', 'y', 'width', 'height'] as const).map(key => <NumberField key={key} label={`Crop ${key}`} value={template.main_clip_layout.source_crop![key]} min={key === 'x' || key === 'y' ? 0 : 1}
            onValue={value => useEditorStore.getState().change(t => { t.main_clip_layout.source_crop![key] = value; })} />)}</div>}
        {template.main_clip_layout.source_aspect_handling === 'blur_pad' && <>
          <Toggle label="Размытый задний план" checked={template.main_clip_layout.background_blur.enabled} onChange={value => useEditorStore.getState().change(t => { t.main_clip_layout.background_blur.enabled = value; })} />
          <div className="field-grid"><NumberField label="Размытие" value={template.main_clip_layout.background_blur.luma_radius} min={0} max={100} onValue={value => useEditorStore.getState().change(t => { t.main_clip_layout.background_blur.luma_radius = value; })} />
            <NumberField label="Яркость фона" value={template.main_clip_layout.background_blur.brightness} min={-1} max={1} step={0.05} onValue={value => useEditorStore.getState().change(t => { t.main_clip_layout.background_blur.brightness = value; })} /></div>
        </>}
        <VideoBackgroundPanel /><label className="color-field">Цвет холста<input type="color" value={template.canvas.background_color} onChange={e => useEditorStore.getState().change(t => { t.canvas.background_color = e.target.value; })} /><code>{template.canvas.background_color}</code></label>
      </> : <>
        <div className="field-grid"><NumberField label="Scale" value={selected.scale * (selected.position.scale ?? 1)} min={0.01} max={16} step={0.05} onValue={value => update(o => { if (o.position.scale !== undefined) { o.position.scale = value; o.scale = 1; } else o.scale = value; })} /><NumberField label="Opacity" value={Math.round(selected.opacity * 100)} min={0} max={100} suffix="%" onValue={value => update(o => { o.opacity = value / 100; })} />
          <NumberField label="Z-index" value={selected.z_index} onValue={value => update(o => { o.z_index = value; })} /></div>
        <NumberField label="Rotation" value={selected.position.rotation ?? 0} min={-180} max={180} suffix="°" onValue={value => update(o => { o.position.rotation = value; })} />
        {selected.type === 'text' ? <RichTextPanel key={selected.id} layer={selected} /> : <>
          <Button size="sm" variant="outline" onClick={() => void task(async () => {
            const asset = await window.desktop.editor.selectAsset(selected.type); if (!asset) return;
            useEditorStore.setState(s => ({ assets: { ...s.assets, [asset.path]: asset.url } })); update(o => { if (o.type !== 'text') { o.source_path = asset.path; delete o.background_removal; delete o.chroma_key; } });
          })}>Заменить файл</Button><span className="asset-name">{selected.source_path.split(/[\\/]/).at(-1)}</span>
          <BackgroundPanel key={selected.id} layer={selected} />
        </>}
        <Section title="ТАЙМИНГ"><Toggle label="На всю длину клипа" checked={selected.timing.full_duration} onChange={value => update(o => { o.timing.full_duration = value; })} />
          {!selected.timing.full_duration && <div className="field-grid"><NumberField label="Start" value={selected.timing.start_offset_sec} min={0} max={duration} step={0.1} suffix="s" onValue={value => update(o => { o.timing.start_offset_sec = value; })} />
            <NumberField label="End" value={selected.timing.end_offset_sec ?? duration} min={0.1} max={duration} step={0.1} suffix="s" onValue={value => update(o => { o.timing.end_offset_sec = value; })} /></div>}
          <div className="field-grid"><NumberField label="Fade in" value={selected.timing.fade_in_sec} min={0} max={duration / 2} step={0.1} suffix="s" onValue={value => update(o => { o.timing.fade_in_sec = value; })} />
            <NumberField label="Fade out" value={selected.timing.fade_out_sec} min={0} max={duration / 2} step={0.1} suffix="s" onValue={value => update(o => { o.timing.fade_out_sec = value; })} /></div>
        </Section>
      </>}
    </div>}
  </section>;
}

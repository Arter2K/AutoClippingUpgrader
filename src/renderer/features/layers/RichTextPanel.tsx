import { useEffect, useState } from 'react';
import { Type, Upload } from 'lucide-react';
import { NumberField, SelectField, Section, Toggle } from '../../components/ui/fields';
import { Button } from '../../components/ui/button';
import { useEditorStore, task } from '../../stores/editor-store';
import { resolvedTextStyle, type TextOverlay } from '../../../shared/layer-effects';
import type { SystemFont } from '../../../shared/editor';

export function RichTextPanel({ layer }: { layer: TextOverlay }) {
  const s = resolvedTextStyle(layer), [fonts, setFonts] = useState<SystemFont[]>([]);
  useEffect(() => { void window.desktop.editor.systemFonts().then(setFonts).catch(() => {}); }, []);
  const update = (recipe: (o: TextOverlay) => void) => useEditorStore.getState().updateOverlay(layer.id, o => { if (o.type === 'text') recipe(o); });
  const font = async (path?: string) => {
    const asset = path ? await window.desktop.editor.adoptSystemFont(path) : await window.desktop.editor.selectAsset('font'); if (!asset) return;
    useEditorStore.setState(state => ({ assets: { ...state.assets, [asset.path]: asset.url } }));
    update(o => { o.style.font_file = asset.path; o.style.font_family = asset.family ?? asset.name; });
  };
  const animation = layer.animation ?? { in_preset: 'none', out_preset: 'none', duration_sec: 0.25 };
  return <div className="rich-text-controls">
    <label className="field-label">Текст<textarea aria-label="Текст слоя" rows={3} value={layer.text_content} onChange={e => update(o => { o.text_content = e.target.value; })} /></label>
    <SelectField label="Системный шрифт" value={fonts.some(f => f.path === layer.style.font_file) ? layer.style.font_file : ''}
      options={[{ value: '', label: layer.style.font_family ?? 'Выберите шрифт' }, ...fonts.map(f => ({ value: f.path, label: f.name }))]} onValue={value => { if (value) void task(() => font(value)); }} />
    <Button size="sm" variant="outline" onClick={() => void task(() => font())}><Upload size={12} />Загрузить TTF / OTF в проект</Button>
    <span className="asset-name">{layer.style.font_file.split(/[\\/]/).at(-1)}</span>
    <div className="field-grid"><NumberField label="Размер шрифта" value={s.font_size} min={1} max={2048} onValue={value => update(o => { o.style.font_size = value; })} />
      <SelectField label="Font Weight" value={s.font_weight} options={['100', '200', '300', '400', '500', '600', '700', '800', '900'].map(value => ({ value, label: value }))} onValue={value => update(o => { o.style.font_weight = value as typeof o.style.font_weight; })} />
      <NumberField label="Letter spacing" value={s.letter_spacing} min={-20} max={100} step={0.1} onValue={value => update(o => { o.style.letter_spacing = value; })} />
      <NumberField label="Line height" value={s.line_height} min={0.5} max={4} step={0.05} onValue={value => update(o => { o.style.line_height = value; })} /></div>
    <div className="text-toggles"><Toggle label="Italic" checked={s.italic} onChange={value => update(o => { o.style.italic = value; })} /><Toggle label="UPPERCASE" checked={s.uppercase} onChange={value => update(o => { o.style.uppercase = value; })} /></div>
    <div className="field-grid"><SelectField label="Выравнивание" value={s.text_align} options={['left', 'center', 'right'].map(value => ({ value, label: value }))} onValue={value => update(o => { o.style.text_align = value as typeof o.style.text_align; })} />
      <SelectField label="Привязка" value={layer.position.anchor} options={[{ value: 'center', label: 'Центр' }, { value: 'top_left', label: 'Левый верх' }]} onValue={value => update(o => { o.position.anchor = value as 'center' | 'top_left'; })} /></div>
    <Section title="ЗАЛИВКА"><label className="color-field">Цвет текста<input aria-label="Цвет текста" type="color" value={s.fill_color} onChange={e => update(o => { o.style.fill_color = e.target.value; })} /><code>{s.fill_color}</code></label>
      <NumberField label="Fill opacity" value={Math.round(s.fill_opacity * 100)} min={0} max={100} suffix="%" onValue={value => update(o => { o.style.fill_opacity = value / 100; })} /></Section>
    <Section title="ОБВОДКА"><Toggle label="Обводка текста" checked={s.stroke.enabled} onChange={value => update(o => { o.style.stroke = { ...s.stroke, enabled: value }; })} />
      {s.stroke.enabled && <div className="field-grid"><label className="field-label">Цвет обводки<input type="color" value={s.stroke.color} onChange={e => update(o => { o.style.stroke = { ...s.stroke, color: e.target.value }; })} /></label>
        <NumberField label="Stroke width" value={Math.min(20, s.stroke.width)} min={0} max={20} onValue={value => update(o => { o.style.stroke = { ...s.stroke, width: value }; })} /></div>}</Section>
    <Section title="ТЕНЬ" open={false}><Toggle label="Тень текста" checked={s.shadow.enabled} onChange={value => update(o => { o.style.shadow = { ...s.shadow, enabled: value }; })} />
      {s.shadow.enabled && <><label className="color-field">Цвет тени<input type="color" value={s.shadow.color} onChange={e => update(o => { o.style.shadow = { ...s.shadow, color: e.target.value }; })} /></label>
        <div className="field-grid">{(['opacity', 'blur', 'offset_x', 'offset_y'] as const).map(key => <NumberField key={key} label={`Shadow ${key}`} value={s.shadow[key]} min={key === 'opacity' || key === 'blur' ? 0 : -500} max={key === 'opacity' ? 1 : key === 'blur' ? 100 : 500} step={key === 'opacity' ? 0.05 : 1} onValue={value => update(o => { o.style.shadow = { ...s.shadow, [key]: value }; })} />)}</div></>}</Section>
    <Section title="ФОНОВАЯ ПЛАШКА"><Toggle label="Background box / pill" checked={s.background_box.enabled} onChange={value => update(o => { o.style.background_box = { ...s.background_box, enabled: value }; })} />
      {s.background_box.enabled && <><label className="color-field">Цвет плашки<input type="color" value={s.background_box.color} onChange={e => update(o => { o.style.background_box = { ...s.background_box, color: e.target.value }; })} /></label>
        <div className="field-grid">{(['opacity', 'padding_x', 'padding_y', 'border_radius'] as const).map(key => <NumberField key={key} label={`Box ${key}`} value={s.background_box[key]} min={0} max={key === 'opacity' ? 1 : 500} step={key === 'opacity' ? 0.05 : 1} onValue={value => update(o => { o.style.background_box = { ...s.background_box, [key]: value }; })} />)}</div></>}</Section>
    <Section title="АНИМАЦИЯ"><div className="field-grid"><SelectField label="Появление" value={animation.in_preset} options={[{ value: 'none', label: 'None' }, { value: 'fade_in', label: 'Fade In' }, { value: 'pop_bounce', label: 'Pop-Up Bounce' }, { value: 'slide_up', label: 'Slide Up' }, { value: 'slide_down', label: 'Slide Down' }]}
      onValue={value => update(o => { o.animation = { ...animation, in_preset: value as typeof animation.in_preset }; })} />
      <SelectField label="Исчезновение" value={animation.out_preset} options={[{ value: 'none', label: 'None' }, { value: 'fade_out', label: 'Fade Out' }, { value: 'pop_bounce', label: 'Pop-Up Bounce' }, { value: 'slide_up', label: 'Slide Up' }, { value: 'slide_down', label: 'Slide Down' }]}
        onValue={value => update(o => { o.animation = { ...animation, out_preset: value as typeof animation.out_preset }; })} /></div>
      <label className="field-label">Animation duration · {animation.duration_sec.toFixed(2)} s<input aria-label="Animation duration" type="range" min={0.05} max={2} step={0.05} value={animation.duration_sec}
        onPointerDown={() => useEditorStore.getState().checkpoint()} onChange={e => useEditorStore.getState().updateOverlay(layer.id, o => { if (o.type === 'text') o.animation = { ...animation, duration_sec: Number(e.target.value) }; }, false)} /></label>
      <p className="field-note"><Type size={10} /> Сложный текст рендерится через ASS. Для точной проверки используйте FFmpeg-кадр.</p>
    </Section>
  </div>;
}

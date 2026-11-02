import { Pipette, Crosshair, LoaderCircle, Wand2, Undo2, RotateCcw } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Section, SelectField, Toggle } from '../../components/ui/fields';
import { useEditorStore, task } from '../../stores/editor-store';
import { chromaSettings, type MediaOverlay } from '../../../shared/layer-effects';
import { newBccChroma, type BccChromaConfig } from '../../../shared/bcc-chroma';

export function BackgroundPanel({ layer, onConfig }: { layer: MediaOverlay; onConfig?: (config: BccChromaConfig, record: boolean) => void }) {
  const legacy = chromaSettings(layer), bg = layer.background_removal;
  const config = bg?.mode === 'bcc_chromakey_studio' ? bg : newBccChroma();
  const enabled = bg?.mode === 'bcc_chromakey_studio' ? bg.enabled : !!legacy;
  const ai = useEditorStore(s => s.aiTasks[layer.id]);
  const update = (recipe: (value: BccChromaConfig) => void, record = true) => {
    const next = structuredClone(config); recipe(next);
    if (onConfig) onConfig(next,record);
    else useEditorStore.getState().updateOverlay(layer.id,o => { if(o.type !== 'text') {o.background_removal=next;delete o.chroma_key;} },record);
  };
  const range = (label: string, value: number, min: number, max: number, step: number, change: (c: BccChromaConfig, value: number) => void) =>
    <label className="field-label bcc-slider">{label}<span>{Number(value.toFixed(2))}</span><input aria-label={label} type="range" min={min} max={max} step={step} value={value}
      onPointerDown={() => useEditorStore.getState().checkpoint()} onKeyDown={() => useEditorStore.getState().checkpoint()}
      onChange={e => update(c => change(c, +e.target.value), false)} /></label>;
  const pick = () => useEditorStore.setState({ pickingColorFor: layer.id, playing: false });
  const p = config.primary_key, m = config.matte_cleanup, s = config.spill_suppression, w = config.light_wrap;
  return <Section title="BCC-STYLE CHROMA KEY STUDIO">
    <Toggle label="Enable Chroma Key" checked={enabled} onChange={value => update(c => { c.enabled = value; })} />
    {enabled && legacy && <><p className="field-note">Сохранён старый Chroma Key; исходный результат не изменён.</p><Button size="sm" onClick={() => update(c => {
      c.primary_key.key_color = legacy.key_color; c.primary_key.similarity = legacy.similarity; c.spill_suppression.enabled = legacy.despill;
    })}>Перевести в BCC Studio</Button></>}
    {enabled && !legacy && <div className="bcc-controls">
      <div className="key-presets">{['#00FF00', '#0000FF', '#000000'].map(color => <button key={color} title={color} aria-label={`Ключ ${color}`} style={{ background: color }} className={p.key_color.toUpperCase() === color ? 'is-selected' : ''} onClick={() => update(c => {
        c.primary_key.key_color = color; if (color === '#000000') { c.primary_key.luma_weight = 1; c.spill_suppression.enabled = false; }
      })} />)}<input type="color" aria-label="Ключевой цвет" value={p.key_color} onChange={e => update(c => { c.primary_key.key_color = e.target.value; })} /><code>{p.key_color}</code></div>
      <div className="background-pickers"><Button size="sm" variant="outline" onClick={pick}><Pipette size={12} />Пипетка 3×3</Button><Button size="sm" variant="outline" title="Усреднение 3×3 пикселя на исходнике" onClick={pick}><Crosshair size={12} />С холста</Button></div>
      <SelectField label="View Mode" value={config.view_mode} options={[{ value: 'final_composite', label: 'Final Composite' }, { value: 'alpha_matte', label: 'Alpha Matte (B&W)' }, { value: 'source_only', label: 'Source Only' }]}
        onValue={value => update(c => { c.view_mode = value as BccChromaConfig['view_mode']; })} />
      <Section title="Primary Key">
        {range('Similarity', p.similarity, .01, 1, .01, (c,v) => { c.primary_key.similarity = v; })}
        {range('Hue Weight', p.hue_weight, 0, 2, .05, (c,v) => { c.primary_key.hue_weight = v; })}
        {range('Saturation Weight', p.saturation_weight, 0, 2, .05, (c,v) => { c.primary_key.saturation_weight = v; })}
        {range('Luma Weight', p.luma_weight, 0, 2, .05, (c,v) => { c.primary_key.luma_weight = v; })}
      </Section>
      <Section title="Matte Cleanup">
        {range('Black Clip (%)', m.black_clip * 100, 0, 99, 1, (c,v) => { c.matte_cleanup.black_clip = Math.min(v / 100, c.matte_cleanup.white_clip - .001); })}
        {range('White Clip (%)', m.white_clip * 100, 1, 100, 1, (c,v) => { c.matte_cleanup.white_clip = Math.max(v / 100, c.matte_cleanup.black_clip + .001); })}
        {range('Matte Choke (px)', m.matte_choke_px, -20, 20, .5, (c,v) => { c.matte_cleanup.matte_choke_px = v; })}
        {range('Matte Softness (px)', m.matte_softness_px, 0, 20, .5, (c,v) => { c.matte_cleanup.matte_softness_px = v; })}
        {range('Matte Gamma', m.matte_gamma, .2, 3, .05, (c,v) => { c.matte_cleanup.matte_gamma = v; })}
      </Section>
      <Section title="Spill Suppression">
        <Toggle label="Enable Despill" checked={s.enabled} onChange={v => update(c => { c.spill_suppression.enabled = v; })} />
        <Toggle label="Despill: только края" checked={s.edges_only} onChange={v => update(c => { c.spill_suppression.edges_only = v; })} />
        {range('Spill Strength (%)', s.strength * 100, 0, 100, 1, (c,v) => { c.spill_suppression.strength = v / 100; })}
        {range('Despill Balance', s.balance, 0, 1, .01, (c,v) => { c.spill_suppression.balance = v; })}
        <Toggle label="Restore Luminance" checked={s.restore_luminance} onChange={v => update(c => { c.spill_suppression.restore_luminance = v; })} />
      </Section>
      <Section title="Light Wrap">
        <p className="field-note">Подмешивает цвет нижнего фона по краям. Для исходного оттенка оставьте выключенным.</p>
        <Toggle label="Enable Light Wrap" checked={w.enabled} onChange={v => update(c => { c.light_wrap.enabled = v; })} />
        {range('Light Wrap Intensity (%)', w.intensity * 100, 0, 100, 1, (c,v) => { c.light_wrap.intensity = v / 100; })}
        {range('Light Wrap Width (px)', w.width_px, 1, 30, .5, (c,v) => { c.light_wrap.width_px = v; })}
      </Section>
      <Button size="sm" variant="outline" onClick={() => update(c => Object.assign(c, newBccChroma()))}><RotateCcw size={12} />Reset to Default</Button>
    </div>}
    {layer.type === 'image' && <div className="ai-removal"><Button variant="outline" disabled={ai?.running} onClick={() => void task(() => useEditorStore.getState().removeBackground(layer.id))}>
      {ai?.running ? <LoaderCircle size={13} className="spin" /> : <Wand2 size={13} />}Удалить фон (AI)</Button>
      {ai?.running && <><progress aria-label="AI background progress" max={1} value={ai.fraction} /><span className="field-note">{ai.message}</span><Button size="sm" onClick={() => useEditorStore.getState().cancelBackground(layer.id)}>Отменить AI</Button></>}
      <p className="field-note">Локальная ONNX-модель. Изображение не отправляется в интернет.</p>
      {layer.background_removal?.mode === 'ai_matting' && <Button size="sm" variant="ghost" onClick={() => useEditorStore.getState().updateOverlay(layer.id, o => {
        if (o.type === 'image' && o.background_removal?.mode === 'ai_matting') { o.source_path = o.background_removal.original_source_path; o.background_removal.enabled = false; }
      })}><Undo2 size={12} />Вернуть оригинал</Button>}
    </div>}
  </Section>;
}

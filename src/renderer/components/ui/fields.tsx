import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

export function NumberField({ label, value, onValue, min, max, step = 1, suffix, disabled = false }: {
  label: string; value: number; onValue: (value: number) => void; min?: number; max?: number; step?: number; suffix?: string; disabled?: boolean;
}) {
  const [draft, setDraft] = useState(String(value)), editing = useRef(false);
  useEffect(() => { if (!editing.current) setDraft(String(Number(value.toFixed(3)))); }, [value]);
  const commit = () => {
    editing.current = false; const parsed = Number(draft);
    if (!Number.isFinite(parsed) || !draft.trim()) { setDraft(String(value)); return; }
    const next = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, parsed));
    const rounded = step >= 1 ? Math.round(next) : Number(next.toFixed(3));
    setDraft(String(rounded)); if (rounded !== value) onValue(rounded);
  };
  return <label className="field-label">{label}<span className="number-wrap"><input aria-label={label} type="number" value={draft} disabled={disabled}
    min={min} max={max} step={step} onFocus={() => { editing.current = true; }} onChange={e => setDraft(e.target.value)}
    onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} />{suffix && <span>{suffix}</span>}</span></label>;
}
export function SelectField({ label, value, onValue, options, disabled = false }: {
  label: string; value: string | number; onValue: (value: string) => void; options: Array<{ value: string | number; label: string }>; disabled?: boolean;
}) {
  return <label className="field-label">{label}<span className="select-wrap"><select aria-label={label} value={value} onChange={e => onValue(e.target.value)} disabled={disabled}>
    {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select><ChevronDown size={12} /></span></label>;
}
export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean }) {
  return <label className="toggle-row"><span>{label}</span><button type="button" role="switch" aria-label={label} aria-checked={checked} disabled={disabled}
    className={`toggle ${checked ? 'is-on' : ''}`} onClick={() => onChange(!checked)}><span /></button></label>;
}
export function Section({ title, children, badge, open = true }: { title: string; children: ReactNode; badge?: ReactNode; open?: boolean }) {
  return <details className="inspector-section" open={open}><summary><span>{title}</span>{badge}<ChevronDown size={12} /></summary><div className="section-body">{children}</div></details>;
}

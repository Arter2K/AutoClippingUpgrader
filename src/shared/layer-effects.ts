import type { Overlay } from './template';
export type TextOverlay = Extract<Overlay, { type: 'text' }>;
export type MediaOverlay = Exclude<Overlay, { type: 'text' }>;
export function effectiveScale(o: Overlay): number { return o.scale * (o.position.scale ?? 1); }
export function bccSettings(o: MediaOverlay) { const bg = o.background_removal; return bg?.mode === 'bcc_chromakey_studio' && bg.enabled ? bg : null; }
export function chromaSettings(o: MediaOverlay) {
  const bg = o.background_removal;
  if (bg) return bg.mode === 'chromakey' && bg.enabled ? bg : null;
  return o.chroma_key ? { mode: 'chromakey' as const, enabled: true, key_color: o.chroma_key.color,
    similarity: o.chroma_key.similarity, blend: o.chroma_key.blend, despill: false } : null;
}
export function spillType(color: string): 'green' | 'blue' {
  return parseInt(color.slice(5, 7), 16) > parseInt(color.slice(3, 5), 16) ? 'blue' : 'green';
}
export function chromaFilter(color: string): 'chromakey' | 'colorkey' {
  const rgb = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
  // Chroma alone cannot distinguish black from white. Neutral backgrounds require RGB keying.
  return Math.max(...rgb) - Math.min(...rgb) < 10 ? 'colorkey' : 'chromakey';
}
export function resolvedTextStyle(o: TextOverlay) {
  const s = o.style;
  const rgba = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(s.shadow_color);
  const shadowColor = rgba ? `#${rgba.slice(1, 4).map(v => Number(v).toString(16).padStart(2, '0')).join('')}` : s.shadow_color;
  return {
    font_size: s.font_size, font_weight: s.font_weight ?? '400', italic: s.italic ?? false, uppercase: s.uppercase ?? false,
    text_align: s.text_align ?? 'left', letter_spacing: s.letter_spacing ?? 0, line_height: s.line_height ?? 1.2,
    fill_color: s.fill_color ?? s.font_color, fill_opacity: s.fill_opacity ?? 1,
    stroke: s.stroke ?? { enabled: s.stroke_width > 0, color: s.stroke_color, width: s.stroke_width },
    shadow: s.shadow ?? { enabled: s.shadow_x !== 0 || s.shadow_y !== 0, color: shadowColor,
      opacity: rgba ? Number(rgba[4]) : 1, offset_x: s.shadow_x, offset_y: s.shadow_y, blur: 0 },
    background_box: s.background_box ?? { enabled: false, color: '#6366f1', opacity: 0.9, padding_x: 28, padding_y: 14, border_radius: 16 },
  };
}
export function textLines(o: TextOverlay) { return (o.style.uppercase ? o.text_content.toLocaleUpperCase('ru-RU') : o.text_content).replace(/\r\n?/g, '\n').split('\n'); }
export function isRichText(o: TextOverlay): boolean {
  const s = o.style;
  return !!o.animation || !!o.position.rotation || o.position.scale !== undefined || s.font_weight !== undefined || s.fill_color !== undefined ||
    s.italic !== undefined || s.uppercase !== undefined || s.text_align !== undefined || s.letter_spacing !== undefined || s.line_height !== undefined ||
    !!s.stroke || !!s.shadow || !!s.background_box;
}
export function layerWindow(o: Overlay, duration: number) {
  return { start: o.timing.full_duration ? 0 : o.timing.start_offset_sec, end: o.timing.full_duration ? duration : o.timing.end_offset_sec ?? duration };
}
const clamp = (value: number) => Math.max(0, Math.min(1, value));
export function bounce(p: number): number {
  if (p < 0.6) return p / 0.6 * 1.12;
  if (p < 0.8) return 1.12 - (p - 0.6) / 0.2 * 0.16;
  return 0.96 + (p - 0.8) / 0.2 * 0.04;
}
export function textMotion(o: TextOverlay, time: number, duration: number) {
  const { start, end } = layerWindow(o, duration), a = o.animation;
  let alpha = time >= start && time < end && o.enabled !== false ? o.opacity : 0, scale = effectiveScale(o), offsetY = 0;
  if (!a) {
    alpha *= Math.min(1, o.timing.fade_in_sec ? clamp((time - start) / o.timing.fade_in_sec) : 1, o.timing.fade_out_sec ? clamp((end - time) / o.timing.fade_out_sec) : 1);
  } else {
    const d = Math.min(a.duration_sec, (end - start) / 2), entry = clamp((time - start) / d), exit = clamp((end - time) / d), distance = o.style.font_size * 1.25;
    if (a.in_preset === 'fade_in') alpha *= entry;
    if (a.out_preset === 'fade_out') alpha *= exit;
    if (a.in_preset === 'pop_bounce') scale *= bounce(entry);
    if (a.out_preset === 'pop_bounce') scale *= bounce(exit);
    if (a.in_preset === 'slide_up') offsetY += (1 - entry) * distance;
    if (a.in_preset === 'slide_down') offsetY -= (1 - entry) * distance;
    if (a.out_preset === 'slide_up') offsetY -= (1 - exit) * distance;
    if (a.out_preset === 'slide_down') offsetY += (1 - exit) * distance;
  }
  return { alpha, scale, offsetY, rotation: o.position.rotation ?? 0 };
}
export function textLayout(o: TextOverlay, measure: (line: string) => number) {
  const s = resolvedTextStyle(o), lines = textLines(o), widths = lines.map(measure);
  const width = Math.max(1, ...widths), height = s.font_size + Math.max(0, lines.length - 1) * s.font_size * s.line_height;
  const x = o.position.anchor === 'center' ? -width / 2 : 0, y = o.position.anchor === 'center' ? -height / 2 : 0;
  return { width, height, x, y, rows: lines.map((text, i) => ({ text, x: x + (s.text_align === 'center' ? (width - widths[i]!) / 2 : s.text_align === 'right' ? width - widths[i]! : 0), y: y + i * s.font_size * s.line_height })) };
}

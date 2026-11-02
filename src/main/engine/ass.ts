import { openSync } from 'fontkit';
import { isRichText, layerWindow, resolvedTextStyle, textLayout, textMotion, type TextOverlay } from '../../shared/layer-effects';

const n = (value: number) => String(Number(value.toFixed(3)));
const color = (hex: string) => `&H${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}&`;
const opacity = (value: number) => `&H${Math.round((1 - Math.max(0, Math.min(1, value))) * 255).toString(16).padStart(2, '0')}&`;
function timestamp(seconds: number) {
  const cs = Math.round(seconds * 100); return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}
export function escapeAssText(value: string): string { return value.replace(/\\/g, '\\\u2060').replace(/{/g, '\\{').replace(/}/g, '\\}').replace(/\r|\n/g, ''); }
export function roundedAssPath(w: number, h: number, radius: number): string {
  const r = Math.min(radius, w / 2, h / 2), k = r * 0.55228475;
  return `m ${n(r)} 0 l ${n(w - r)} 0 b ${n(w - r + k)} 0 ${n(w)} ${n(r - k)} ${n(w)} ${n(r)} l ${n(w)} ${n(h - r)} b ${n(w)} ${n(h - r + k)} ${n(w - r + k)} ${n(h)} ${n(w - r)} ${n(h)} l ${n(r)} ${n(h)} b ${n(r - k)} ${n(h)} 0 ${n(h - r + k)} 0 ${n(h - r)} l 0 ${n(r)} b 0 ${n(r - k)} ${n(r - k)} 0 ${n(r)} 0`;
}
/** Per-frame motion sampling avoids ASS's one-move-per-event limitation and shares Canvas timing. */
export function generateAss(o: TextOverlay, width: number, height: number, fps: number, duration: number, fontPath = o.style.font_file): string {
  const font = openSync(fontPath), style = resolvedTextStyle(o), family = font.familyName.replace(/[,\r\n{}\\]/g, ' ');
  const layout = textLayout(o, text => font.layout(text).positions.reduce((sum, p) => sum + p.xAdvance, 0) / font.unitsPerEm * style.font_size + Math.max(0, [...text].length - 1) * style.letter_spacing);
  const { start, end } = layerWindow(o, duration), points = new Set([start, end]);
  const d = Math.min(o.animation?.duration_sec ?? Math.max(o.timing.fade_in_sec, o.timing.fade_out_sec), (end - start) / 2);
  if (d > 0) {
    points.add(start + d); points.add(end - d);
    for (let frame = Math.ceil(start * fps); frame / fps < Math.min(end, start + d); frame++) points.add(frame / fps);
    for (let frame = Math.ceil((end - d) * fps); frame / fps < end; frame++) points.add(frame / fps);
  }
  const boundaries = [...points].sort((a, b) => a - b), dialogues: string[] = [];
  const event = (layer: number, from: number, to: number, tags: string, text: string) => {
    if (timestamp(from) === timestamp(to)) return;
    dialogues.push(`Dialogue: ${layer},${timestamp(from)},${timestamp(to)},Text,,0,0,0,,{${tags}}${text}`);
  };
  for (let index = 0; index < boundaries.length - 1; index++) {
    const from = boundaries[index]!, to = boundaries[index + 1]!, m = textMotion(o, from + Math.min(0.000001, (to - from) / 2), duration);
    const angle = m.rotation * Math.PI / 180;
    const position = (x: number, y: number) => ({ x: o.position.x + (x * Math.cos(angle) - y * Math.sin(angle)) * m.scale,
      y: o.position.y + m.offsetY + (x * Math.sin(angle) + y * Math.cos(angle)) * m.scale });
    const tags = (x: number, y: number) => { const p = position(x, y); return `\\an7\\q2\\pos(${n(p.x)},${n(p.y)})\\frz${n(-m.rotation)}\\fscx${n(m.scale * 100)}\\fscy${n(m.scale * 100)}\\shad0`; };
    const box = style.background_box;
    if (box.enabled) event(0, from, to, `${tags(layout.x - box.padding_x, layout.y - box.padding_y)}\\bord0\\1c${color(box.color)}\\1a${opacity(m.alpha * box.opacity)}\\p1`, roundedAssPath(layout.width + box.padding_x * 2, layout.height + box.padding_y * 2, box.border_radius));
    for (const row of layout.rows) {
      const common = `\\fn${family}\\fs${n(style.font_size)}\\b${style.font_weight}\\i${Number(style.italic)}\\fsp${n(style.letter_spacing)}`;
      const stroke = style.stroke.enabled ? style.stroke.width : 0;
      if (style.shadow.enabled) event(1, from, to, `${tags(row.x + style.shadow.offset_x, row.y + style.shadow.offset_y)}${common}\\bord${n(stroke)}\\blur${n(style.shadow.blur)}\\1c${color(style.shadow.color)}\\3c${color(style.shadow.color)}\\alpha${opacity(m.alpha * style.shadow.opacity)}`, escapeAssText(row.text));
      event(2, from, to, `${tags(row.x, row.y)}${common}\\bord${n(stroke)}\\blur0\\1c${color(style.fill_color)}\\1a${opacity(m.alpha * style.fill_opacity)}\\3c${color(style.stroke.color)}\\3a${opacity(m.alpha)}`, escapeAssText(row.text));
    }
  }
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nScaledBorderAndShadow: yes\nWrapStyle: 2\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Text,${family},${style.font_size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${dialogues.join('\n')}\n`;
}
export { isRichText };

import type { Template, Overlay } from './template';

export interface Rect { x: number; y: number; width: number; height: number }
export function mainGeometry(t: Template, sourceWidth: number, sourceHeight: number): { source: Rect; target: Rect } {
  const layout = t.main_clip_layout, p = layout.Position;
  const source = layout.source_aspect_handling === 'custom_crop' && layout.source_crop
    ? { ...layout.source_crop } : { x: 0, y: 0, width: sourceWidth, height: sourceHeight };
  const cover = layout.source_aspect_handling === 'center_crop' || p.scale_mode === 'cover';
  if (cover) {
    const ratio = Math.max(p.width / source.width, p.height / source.height);
    const width = p.width / ratio, height = p.height / ratio;
    return { source: { x: source.x + (source.width - width) / 2, y: source.y + (source.height - height) / 2, width, height }, target: { ...p } };
  }
  const ratio = p.scale_mode === 'fit_width' ? p.width / source.width : Math.min(p.width / source.width, p.height / source.height);
  const width = source.width * ratio, height = source.height * ratio;
  return { source, target: { x: p.x + (p.width - width) / 2, y: p.y + (p.height - height) / 2, width, height } };
}
export function overlayAlpha(o: Overlay, time: number, duration: number): number {
  if (o.enabled === false) return 0;
  const start = o.timing.full_duration ? 0 : o.timing.start_offset_sec;
  const end = o.timing.full_duration ? duration : o.timing.end_offset_sec ?? duration;
  if (time < start || time >= end) return 0;
  return o.opacity * Math.min(1, o.timing.fade_in_sec ? (time - start) / o.timing.fade_in_sec : 1,
    o.timing.fade_out_sec ? (end - time) / o.timing.fade_out_sec : 1);
}
export function snapPosition(x: number, y: number, width: number, height: number, canvasWidth: number, canvasHeight: number, threshold: number) {
  const snap = (value: number, size: number, total: number) => {
    const options = [0, (total - size) / 2, total - size];
    const closest = options.reduce((a, b) => Math.abs(value - a) < Math.abs(value - b) ? a : b);
    return Math.abs(value - closest) <= threshold ? closest : Math.round(value / 10) * 10;
  };
  return { x: snap(x, width, canvasWidth), y: snap(y, height, canvasHeight) };
}
export function resizeCanvas(template: Template, width: number, height: number): Template {
  const t = structuredClone(template), rx = width / t.canvas.width, ry = height / t.canvas.height;
  const rect = (r: Rect) => ({ ...r, x: Math.round(r.x * rx), y: Math.round(r.y * ry), width: Math.max(1, Math.round(r.width * rx)), height: Math.max(1, Math.round(r.height * ry)) });
  t.main_clip_layout.Position = rect(t.main_clip_layout.Position) as typeof t.main_clip_layout.Position;
  // Keep scale_mode when resizing the coordinate rectangle.
  t.main_clip_layout.Position.scale_mode = template.main_clip_layout.Position.scale_mode;
  t.main_clip_layout.background_blur.scale_height = height;
  const ratio = Math.min(rx, ry);
  t.overlays = t.overlays.map(o => {
    if (o.type !== 'text') return { ...o, position: rect(o.position) };
    const s = o.style;
    return { ...o, position: { ...o.position, x: Math.round(o.position.x * rx), y: Math.round(o.position.y * ry) },
      style: { ...s, font_size: Math.max(1, s.font_size * ratio), stroke_width: s.stroke_width * ratio,
        shadow_x: s.shadow_x * ratio, shadow_y: s.shadow_y * ratio,
        ...(s.letter_spacing !== undefined ? { letter_spacing: s.letter_spacing * ratio } : {}),
        ...(s.stroke ? { stroke: { ...s.stroke, width: s.stroke.width * ratio } } : {}),
        ...(s.shadow ? { shadow: { ...s.shadow, offset_x: s.shadow.offset_x * ratio, offset_y: s.shadow.offset_y * ratio, blur: s.shadow.blur * ratio } } : {}),
        ...(s.background_box ? { background_box: { ...s.background_box, padding_x: s.background_box.padding_x * ratio, padding_y: s.background_box.padding_y * ratio, border_radius: s.background_box.border_radius * ratio } } : {}),
      } };
  });
  t.canvas.width = width; t.canvas.height = height;
  for (const track of t.timeline?.tracks ?? []) for (const clip of track.clips) if (clip.transform) Object.assign(clip.transform, rect(clip.transform));
  const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
  const divisor = gcd(width, height); t.canvas.aspect_ratio = `${width / divisor}:${height / divisor}`;
  t.render_preset.video.level = 'auto';
  return t;
}

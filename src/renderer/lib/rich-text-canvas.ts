import { resolvedTextStyle, textLayout, textMotion, type TextOverlay } from '../../shared/layer-effects';
import type { Rect } from '../../shared/geometry';

export function transformedBounds(r: Rect, x: number, y: number, scale: number, degrees: number): Rect {
  const a = degrees * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const points = [[r.x, r.y], [r.x + r.width, r.y], [r.x, r.y + r.height], [r.x + r.width, r.y + r.height]]
    .map(([px, py]) => ({ x: x + scale * (px! * c - py! * s), y: y + scale * (px! * s + py! * c) }));
  const left = Math.min(...points.map(p => p.x)), top = Math.min(...points.map(p => p.y));
  return { x: left, y: top, width: Math.max(...points.map(p => p.x)) - left, height: Math.max(...points.map(p => p.y)) - top };
}
export function drawRichText(ctx: CanvasRenderingContext2D, o: TextOverlay, family: string, time: number, duration: number): Rect {
  const s = resolvedTextStyle(o), m = textMotion(o, time, duration);
  ctx.font = `${s.italic ? 'italic ' : ''}${s.font_weight} ${s.font_size}px "${family}", Arial, sans-serif`;
  ctx.letterSpacing = `${s.letter_spacing}px`;
  const layout = textLayout(o, line => ctx.measureText(line).width);
  const bounds = transformedBounds({ x: layout.x, y: layout.y, width: layout.width, height: layout.height }, o.position.x, o.position.y + m.offsetY, m.scale, m.rotation);
  if (m.alpha <= 0 || m.scale <= 0) return bounds;
  ctx.translate(o.position.x, o.position.y + m.offsetY); ctx.rotate(m.rotation * Math.PI / 180); ctx.scale(m.scale, m.scale);
  ctx.textBaseline = 'top'; ctx.lineJoin = 'round';
  const box = s.background_box;
  if (box.enabled) {
    ctx.globalAlpha = m.alpha * box.opacity; ctx.fillStyle = box.color; ctx.beginPath();
    ctx.roundRect(layout.x - box.padding_x, layout.y - box.padding_y, layout.width + box.padding_x * 2, layout.height + box.padding_y * 2, box.border_radius); ctx.fill();
  }
  if (s.shadow.enabled) {
    ctx.save(); ctx.globalAlpha = m.alpha * s.shadow.opacity; ctx.fillStyle = s.shadow.color;
    // Blur is expressed in display pixels by the Canvas filter API.
    const transform = ctx.getTransform(); ctx.filter = `blur(${s.shadow.blur * Math.hypot(transform.a, transform.b)}px)`;
    for (const row of layout.rows) ctx.fillText(row.text, row.x + s.shadow.offset_x, row.y + s.shadow.offset_y);
    ctx.restore();
  }
  ctx.globalAlpha = m.alpha;
  if (s.stroke.enabled && s.stroke.width > 0) {
    ctx.strokeStyle = s.stroke.color; ctx.lineWidth = s.stroke.width * 2;
    for (const row of layout.rows) ctx.strokeText(row.text, row.x, row.y);
  }
  ctx.globalAlpha = m.alpha * s.fill_opacity; ctx.fillStyle = s.fill_color;
  for (const row of layout.rows) ctx.fillText(row.text, row.x, row.y);
  return bounds;
}

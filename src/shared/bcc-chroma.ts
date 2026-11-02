import { z } from 'zod';

const finite = z.number().finite();
const unit = finite.min(0).max(1);
export const bccChromaSchema = z.object({
  mode: z.literal('bcc_chromakey_studio'), enabled: z.boolean().default(true),
  view_mode: z.enum(['final_composite', 'alpha_matte', 'source_only']).default('final_composite'),
  primary_key: z.object({ key_color: z.string().regex(/^#[\da-fA-F]{6}$/).default('#00FF00'),
    similarity: finite.min(.01).max(1).default(.14), hue_weight: finite.min(0).max(2).default(1),
    saturation_weight: finite.min(0).max(2).default(.8), luma_weight: finite.min(0).max(2).default(.3),
  }).prefault({}),
  matte_cleanup: z.object({ black_clip: unit.default(.1), white_clip: unit.default(.9),
    matte_choke_px: finite.min(-20).max(20).default(-1.5), matte_softness_px: finite.min(0).max(20).default(1.5),
    matte_gamma: finite.min(.2).max(3).default(1),
  }).prefault({}).refine(v => v.white_clip - v.black_clip >= .001, 'White Clip must exceed Black Clip by at least 0.001'),
  spill_suppression: z.object({ enabled: z.boolean().default(true), strength: unit.default(.85),
    balance: unit.default(.5), restore_luminance: z.boolean().default(true), edges_only: z.boolean().default(true),
  }).prefault({}),
  light_wrap: z.object({ enabled: z.boolean().default(false), intensity: unit.default(.15), width_px: finite.min(1).max(30).default(6) }).prefault({}),
});
export type BccChromaConfig = z.infer<typeof bccChromaSchema>;
export const newBccChroma = (): BccChromaConfig => bccChromaSchema.parse({ mode: 'bcc_chromakey_studio' });
export const clampUnit = (v: number) => Math.min(1, Math.max(0, v));
export function rgbToYcbcr(rgb: readonly number[]): [number, number, number] {
  const [r = 0, g = 0, b = 0] = rgb;
  return [.299 * r + .587 * g + .114 * b, -.169 * r - .331 * g + .5 * b, .5 * r - .419 * g - .081 * b];
}
export function keyRgb(color: string): [number, number, number] { return [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255) as [number, number, number]; }
export function bccRawAlpha(rgb: readonly number[], config: BccChromaConfig): number {
  const a = rgbToYcbcr(rgb), b = rgbToYcbcr(keyRgb(config.primary_key.key_color)), p = config.primary_key;
  if (p.hue_weight === 1 && p.saturation_weight === 1 && p.luma_weight === 0) {
    const key = keyRgb(p.key_color), delta = rgb.map((v,i) => v - key[i]!);
    const neutral = Math.max(...key) - Math.min(...key) < 10 / 255;
    const distance = neutral ? Math.hypot(...delta) / Math.sqrt(3) : Math.hypot(-.148 * delta[0]! - .291 * delta[1]! + .439 * delta[2]!, .439 * delta[0]! - .368 * delta[1]! - .071 * delta[2]!) / Math.SQRT2;
    return clampUnit((distance - p.similarity) / .25);
  }
  return clampUnit((Math.hypot((a[1] - b[1]) * p.hue_weight, (a[2] - b[2]) * p.saturation_weight, (a[0] - b[0]) * p.luma_weight) - p.similarity) / .25);
}
export function bccMatteLevel(alpha: number, config: BccChromaConfig): number {
  const c = config.matte_cleanup;
  return clampUnit((alpha - c.black_clip) / (c.white_clip - c.black_clip)) ** (1 / c.matte_gamma);
}
export function bccSpillChannel(color: string): 'green' | 'blue' | null {
  const [r,g,b] = keyRgb(color);
  return g > r + .05 && g >= b ? 'green' : b > r + .05 && b > g ? 'blue' : null;
}
/** Remove excess screen colour, then restore Y by moving within the RGB gamut. */
export function bccDespill(rgb: readonly number[], config: BccChromaConfig, edgeWeight = 1): number[] {
  const s = config.spill_suppression, [r = 0, g = 0, b = 0] = rgb;
  const channel = bccSpillChannel(config.primary_key.key_color);
  if (!s.enabled || s.strength === 0 || !channel) return [r, g, b];
  const blue = channel === 'blue', other = blue ? g : b, high = Math.max(r, other);
  const limit = s.balance <= .5 ? r + (high - r) * (s.balance * 2) : high + (other - high) * ((s.balance - .5) * 2);
  const spill = Math.max(0, (blue ? b : g) - limit) * s.strength;
  let color = [r, g - (blue ? 0 : spill), b - (blue ? spill : 0)];
  if (s.restore_luminance) {
    const y = .299*r + .587*g + .114*b, changedY = .299*color[0]! + .587*color[1]! + .114*color[2]!;
    const factor = clampUnit((y - changedY) / Math.max(.000001, 1 - changedY));
    color = color.map(v => v + (1 - v) * factor);
  }
  const amount = s.edges_only ? clampUnit(edgeWeight) : 1;
  return color.map((v,i) => clampUnit(rgb[i]! + (v - rgb[i]!) * amount));
}
export function morphologyPasses(choke: number): { count: number; fraction: number; expand: boolean } {
  return { count: Math.floor(Math.abs(choke)), fraction: Math.abs(choke) % 1, expand: choke > 0 };
}
export function averagePixelColor(data: Uint8ClampedArray): string {
  let count = 0, r = 0, g = 0, b = 0;
  for (let i = 0; i < data.length; i += 4) { const a = data[i + 3]! / 255; count += a; r += data[i]! * a; g += data[i + 1]! * a; b += data[i + 2]! * a; }
  return '#' + [r, g, b].map(v => Math.round(count ? v / count : 0).toString(16).padStart(2, '0')).join('');
}

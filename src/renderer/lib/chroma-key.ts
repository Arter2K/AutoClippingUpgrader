/** FFmpeg colorkey-style RGB distance. Used only for the downscaled interactive preview. */
export function applyColorKey(data: Uint8ClampedArray, color: string, similarity: number, blend: number): void {
  const rgb = [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16));
  for (let i = 0; i < data.length; i += 4) {
    const distance = Math.sqrt(((data[i]! - rgb[0]!) ** 2 + (data[i + 1]! - rgb[1]!) ** 2 + (data[i + 2]! - rgb[2]!) ** 2) / (255 ** 2 * 3));
    const alpha = blend > 0 ? Math.max(0, Math.min(1, (distance - similarity) / blend)) : Number(distance > similarity);
    data[i + 3] = Math.round(data[i + 3]! * alpha);
  }
}

import { chromaFilter, spillType } from '../../shared/layer-effects';
export function applyChromaKey(data: Uint8ClampedArray, settings: { key_color: string; similarity: number; blend: number; despill: boolean }, legacy = false): void {
  const { key_color: color, similarity, blend, despill } = settings;
  if (legacy || chromaFilter(color) === 'colorkey') applyColorKey(data, color, similarity, blend);
  else {
    const rgb = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
    const uv = (r: number, g: number, b: number) => [-0.148 * r - 0.291 * g + 0.439 * b, 0.439 * r - 0.368 * g - 0.071 * b];
    const key = uv(rgb[0]!, rgb[1]!, rgb[2]!);
    for (let i = 0; i < data.length; i += 4) {
      const p = uv(data[i]!, data[i + 1]!, data[i + 2]!);
      const distance = Math.hypot(p[0]! - key[0]!, p[1]! - key[1]!) / (255 * Math.SQRT2);
      const alpha = blend ? Math.max(0, Math.min(1, (distance - similarity) / blend)) : Number(distance > similarity);
      data[i + 3] = Math.round(data[i + 3]! * alpha);
    }
  }
  if (despill) {
    const channel = spillType(color) === 'green' ? 1 : 2;
    for (let i = 0; i < data.length; i += 4) data[i + channel] = Math.min(data[i + channel]!, (data[i]! + data[i + (channel === 1 ? 2 : 1)]!) / 2);
  }
}

import { morphologyPasses, rgbToYcbcr, keyRgb, type BccChromaConfig } from '../../shared/bcc-chroma';
import { chromaFilter, spillType } from '../../shared/layer-effects';

const n = (v: number) => String(Number(v.toFixed(8)));
export function layerAlphaFilters(opacity: number, start: number, end: number, fadeIn: number, fadeOut: number): string {
  return [`colorchannelmixer=aa=${n(opacity)}`, ...(fadeIn > 0 ? [`fade=t=in:st=${n(start)}:d=${n(fadeIn)}:alpha=1`] : []),
    ...(fadeOut > 0 ? [`fade=t=out:st=${n(end - fadeOut)}:d=${n(fadeOut)}:alpha=1`] : [])].join(',');
}
export function weightedAlphaExpression(c: BccChromaConfig): string {
  const k = rgbToYcbcr(keyRgb(c.primary_key.key_color)), p = c.primary_key;
  const y = '(.299*r(X,Y)+.587*g(X,Y)+.114*b(X,Y))/255';
  const u = '(-.169*r(X,Y)-.331*g(X,Y)+.5*b(X,Y))/255';
  const v = '(.5*r(X,Y)-.419*g(X,Y)-.081*b(X,Y))/255';
  return `255*clip((sqrt(pow((${u}-(${n(k[1])}))*${n(p.hue_weight)},2)+pow((${v}-(${n(k[2])}))*${n(p.saturation_weight)},2)+pow((${y}-(${n(k[0])}))*${n(p.luma_weight)},2))-${n(p.similarity)})/.25,0,1)`;
}
export function buildBccKey(input: string, prefix: string, c: BccChromaConfig): { filters: string[]; output: string } {
  const f: string[] = [], p = c.primary_key, m = c.matte_cleanup, s = c.spill_suppression;
  const l = (name: string) => `[${prefix}${name}]`;
  f.push(`${input},split=3${l('rgb_raw')}${l('key_src')}${l('original')}`, `${l('original')}alphaextract${l('original_alpha')}`);
  // Native chromakey has no weighted 3D YCbCr metric. Preserve the native path for
  // unweighted chroma; geq implements the same weighted metric as the WebGL shader.
  if (p.hue_weight === 1 && p.saturation_weight === 1 && p.luma_weight === 0) {
    const filter = chromaFilter(p.key_color);
    f.push(`${l('key_src')}${filter === 'chromakey' ? 'format=yuva444p,' : ''}${filter}=color=${p.key_color.replace('#', '0x')}:similarity=${n(p.similarity)}:blend=0.25,format=yuva420p,alphaextract${l('raw_matte')}`);
  } else {
    f.push(`${l('key_src')}format=gbrap,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${weightedAlphaExpression(c)}',alphaextract${l('raw_matte')}`);
  }
  let current = 'raw_matte'; const morph = morphologyPasses(m.matte_choke_px), op = morph.expand ? 'dilation' : 'erosion';
  for (let i = 0; i < morph.count; i++) { const next = `morph${i}`; f.push(`${l(current)}${op}=coordinates=255${l(next)}`); current = next; }
  if (morph.fraction > 0) {
    f.push(`${l(current)}split=2${l('fraction_original')}${l('fraction_morph')}`,
      `${l('fraction_morph')}${op}=coordinates=255${l('fraction_result')}`,
      `${l('fraction_original')}${l('fraction_result')}blend=all_expr='A*${n(1 - morph.fraction)}+B*${n(morph.fraction)}'${l('fraction_matte')}`);
    current = 'fraction_matte';
  }
  f.push(`${l(current)}${m.matte_softness_px > 0 ? `gblur=sigma=${n(m.matte_softness_px)}:steps=1,` : ''}format=gbrp,` +
    `colorlevels=rimin=${n(m.black_clip)}:rimax=${n(m.white_clip)}:gimin=${n(m.black_clip)}:gimax=${n(m.white_clip)}:bimin=${n(m.black_clip)}:bimax=${n(m.white_clip)},` +
    `format=gray,eq=gamma=${n(m.matte_gamma)}${l('polished_matte')}`);
  f.push(`${l('polished_matte')}${l('original_alpha')}blend=all_expr='A*B/255'${l('alpha_clean')}`);
  const blue = spillType(p.key_color) === 'blue', strength = s.enabled ? s.strength : 0;
  f.push(`${l('rgb_raw')}${strength > 0 ? `despill=type=${blue ? 'blue' : 'green'}:mix=${n(s.balance)}:expand=0:red=0:green=${n(blue ? 0 : -strength)}:blue=${n(blue ? -strength : 0)}:brightness=${n(s.restore_luminance ? strength * (blue ? .114 : .587) : 0)},` : ''}format=rgb24${l('rgb_despilled')}`);
  f.push(`${l('rgb_despilled')}${l('alpha_clean')}alphamerge,format=rgba${l('keyed_layer')}`);
  return { filters: f, output: l('keyed_layer') };
}

/** Both inputs use canvas coordinates and the composition clock, including rotation. */
export function buildLightWrap(foreground: string, background: string, prefix: string, c: BccChromaConfig): { filters: string[]; foreground: string; background: string } {
  const l = (name: string) => `[${prefix}${name}]`, w = c.light_wrap;
  return { foreground: l('wrapped'), background: l('base'), filters: [
    `${background}split=2${l('base')}${l('bg_light')}`,
    `${foreground}split=2${l('fg_color')}${l('fg_alpha')}`,
    `${l('fg_alpha')}alphaextract,split=3${l('alpha_keep')}${l('edge_inside')}${l('edge_blur')}`,
    `${l('edge_blur')}gblur=sigma=${n(w.width_px)}:steps=1${l('edge_soft')}`,
    `${l('edge_inside')}${l('edge_soft')}blend=all_expr='min(255,max(0,4*A*(1-B/255)*${n(w.intensity)}))'${l('edge')}`,
    `${l('bg_light')}gblur=sigma=${n(w.width_px)}:steps=1,format=gbrp${l('bg_rgb')}`,
    `${l('fg_color')}format=gbrp${l('fg_rgb')}`,
    `${l('fg_rgb')}${l('bg_rgb')}${l('edge')}maskedmerge=planes=7${l('wrap_rgb')}`,
    `${l('wrap_rgb')}${l('alpha_keep')}alphamerge,format=rgba${l('wrapped')}`,
  ] };
}

import { z } from 'zod';
import { timelineSchema } from './timeline';
import { bccChromaSchema } from './bcc-chroma';

const finite = z.number().finite();
const positive = finite.positive();
const pixels = positive.int().max(16384);
const color = z.string().regex(/^#[\da-fA-F]{6}$/);
const pathString = z.string().min(1).refine(v => !/[\x00-\x1f]/.test(v), 'Control characters in path');
const rectangle = z.object({ x: finite, y: finite, width: pixels, height: pixels });
const rotation = finite.min(-180).max(180);
export const backgroundRemovalSchema = z.discriminatedUnion('mode', [
  bccChromaSchema,
  z.object({ mode: z.literal('chromakey'), enabled: z.boolean(), key_color: color,
    similarity: finite.min(0.01).max(1).default(0.15), blend: finite.min(0).max(1).default(0.05), despill: z.boolean().default(false) }),
  z.object({ mode: z.literal('ai_matting'), enabled: z.boolean(), original_source_path: pathString }),
]);
export type BackgroundRemovalConfig = z.infer<typeof backgroundRemovalSchema>;
export const richStrokeSchema = z.object({ enabled: z.boolean(), color, width: finite.min(0).max(20) });
export const richShadowSchema = z.object({ enabled: z.boolean(), color, opacity: finite.min(0).max(1),
  offset_x: finite.min(-500).max(500), offset_y: finite.min(-500).max(500), blur: finite.min(0).max(100) });
export const textBoxSchema = z.object({ enabled: z.boolean(), color, opacity: finite.min(0).max(1),
  padding_x: finite.min(0).max(500), padding_y: finite.min(0).max(500), border_radius: finite.min(0).max(500) });
export const textAnimationSchema = z.object({
  in_preset: z.enum(['none', 'fade_in', 'pop_bounce', 'slide_up', 'slide_down']),
  out_preset: z.enum(['none', 'fade_out', 'pop_bounce', 'slide_up', 'slide_down']),
  duration_sec: finite.min(0.01).max(10).default(0.25),
});
const timing = z.object({
  full_duration: z.boolean(), start_offset_sec: finite.nonnegative().default(0),
  end_offset_sec: finite.nonnegative().nullable().default(null),
  fade_in_sec: finite.nonnegative().default(0), fade_out_sec: finite.nonnegative().default(0),
});
const overlayBase = {
  id: z.string().min(1), name: z.string(), z_index: finite.int(),
  enabled: z.boolean().optional(), locked: z.boolean().optional(),
  opacity: finite.min(0).max(1).default(1), scale: positive.max(16).default(1), timing,
};
const media = z.object({
  ...overlayBase, type: z.enum(['image', 'video']), source_path: pathString,
  position: rectangle.extend({ rotation: rotation.optional(), scale: positive.max(16).optional() }),
  background_removal: backgroundRemovalSchema.optional(),
  chroma_key: z.object({ color, similarity: finite.min(0.01).max(1).default(0.1),
    blend: finite.min(0).max(1).default(0.05) }).optional(),
});
const text = z.object({
  ...overlayBase, type: z.literal('text'), text_content: z.string().max(10000),
  position: z.object({ x: finite, y: finite, anchor: z.enum(['top_left', 'center']).default('top_left'), rotation: rotation.optional(), scale: positive.max(16).optional() }),
  animation: textAnimationSchema.optional(),
  style: z.object({
    font_family: z.string().optional(), font_file: pathString, font_size: positive.max(2048),
    font_color: color.default('#FFFFFF'), stroke_color: color.default('#000000'), stroke_width: finite.min(0).max(100).default(0),
    font_weight: z.enum(['100', '200', '300', '400', '500', '600', '700', '800', '900']).optional(),
    italic: z.boolean().optional(), uppercase: z.boolean().optional(), text_align: z.enum(['left', 'center', 'right']).optional(),
    letter_spacing: finite.min(-20).max(100).optional(), line_height: finite.min(0.5).max(4).optional(),
    fill_color: color.optional(), fill_opacity: finite.min(0).max(1).optional(),
    stroke: richStrokeSchema.optional(), shadow: richShadowSchema.optional(), background_box: textBoxSchema.optional(),
    shadow_color: z.string().regex(/^(#[\da-fA-F]{6}|rgba\(\d{1,3},\s*\d{1,3},\s*\d{1,3},\s*(?:0(?:\.\d+)?|1(?:\.0+)?)\))$/).default('#000000'),
    shadow_x: finite.default(0), shadow_y: finite.default(0),
  }),
});
export const templateSchema = z.object({
  timeline: timelineSchema.optional(),
  template_id: z.string().min(1), template_name: z.string().min(1), version: z.string(),
  canvas: z.object({ width: pixels.refine(v => v % 2 === 0, 'Width must be even'),
    height: pixels.refine(v => v % 2 === 0, 'Height must be even'), aspect_ratio: z.string(),
    fps: z.union([z.literal(30), z.literal(60), z.literal(120)]), background_color: color }),
  main_clip_layout: z.object({
    background_removal: bccChromaSchema.optional(),
    source_aspect_handling: z.enum(['blur_pad', 'center_crop', 'custom_crop']),
    Position: rectangle.extend({ scale_mode: z.enum(['fit_width', 'contain', 'cover']) }),
    source_crop: rectangle.optional(),
    background_blur: z.object({ enabled: z.boolean(), luma_radius: finite.min(0).max(100),
      luma_power: finite.int().min(0).max(10), brightness: finite.min(-1).max(1), scale_height: pixels }),
  }),
  overlays: z.array(z.discriminatedUnion('type', [text, media])).max(100),
  render_preset: z.object({
    target_platform: z.string(), container: z.literal('mp4'),
    video: z.object({
      codec: z.enum(['h264_nvenc', 'hevc_nvenc', 'libx264', 'libx265']),
      fallback_codec: z.enum(['libx264', 'libx265']),
      rate_control: z.enum(['cbr', 'vbr', 'vbr_2pass', 'cqp', 'crf']),
      target_bitrate_kbps: positive.max(500000), max_bitrate_kbps: positive.max(500000),
      bufsize_kbps: positive.max(1000000), quality: finite.min(0).max(51).default(23),
      profile: z.enum(['baseline', 'main', 'high']), level: z.enum(['auto', '4.1', '4.2', '5.1', '5.2', '6', '6.1', '6.2']),
      pixel_format: z.literal('yuv420p'), nvenc_preset: z.enum(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']),
      software_preset: z.enum(['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow']).default('medium'),
      gop_size: positive.int().max(12000),
    }),
    audio: z.object({ codec: z.literal('aac'), bitrate_kbps: finite.min(192).max(320),
      sample_rate: z.literal(48000), normalize_loudness: z.boolean() }),
  }),
  publish_defaults: z.object({
    tiktok: z.object({ mode: z.enum(['direct_post', 'inbox']), default_caption_suffix: z.string(),
      privacy_level: z.string(), disable_comment: z.boolean(), disable_duet: z.boolean(), disable_stitch: z.boolean() }),
    google_drive: z.object({ auto_upload: z.boolean(), target_folder_name: z.string() }),
  }),
}).superRefine((t, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (new Set(t.overlays.map(o => o.id)).size !== t.overlays.length) issue('Overlay IDs must be unique');
  for (const track of t.timeline?.tracks ?? []) for (const clip of track.clips) {
    if (clip.overlay_id && !t.overlays.some(o => o.id === clip.overlay_id && o.type === clip.media_type)) issue('Segment refers to missing or incompatible overlay');
    if (clip.media_type === 'text' && !clip.overlay_id) issue('Text segment requires overlay_id');
    if (clip.use_template_main_layout && clip.media_type !== 'video') issue('Main layout requires video');
  }
  for (const o of t.overlays) if (o.type === 'video' && o.background_removal?.mode === 'ai_matting') issue('AI matting supports static image overlays only');
  const v = t.render_preset.video;
  if (v.max_bitrate_kbps < v.target_bitrate_kbps) issue('Maximum bitrate is below target bitrate');
  const hevc = v.codec === 'hevc_nvenc' || v.codec === 'libx265';
  if (hevc && v.profile !== 'main') issue('8-bit HEVC requires main profile');
  if (v.fallback_codec !== (hevc ? 'libx265' : 'libx264')) issue('Fallback must use the same codec family');
  if (t.main_clip_layout.source_aspect_handling === 'custom_crop' && !t.main_clip_layout.source_crop) issue('custom_crop requires source_crop');
});

export type Template = z.infer<typeof templateSchema>;
export type Overlay = Template['overlays'][number];
export type VideoSettings = Template['render_preset']['video'];
export interface Trim { inSec: number; outSec: number }
export interface MediaInfo { durationSec: number; width: number; height: number; hasAudio: boolean }

export function validateTrim(trim: Trim, sourceDuration?: number): number {
  const { inSec, outSec } = trim;
  if (!Number.isFinite(inSec) || !Number.isFinite(outSec) || inSec < 0 || outSec <= inSec)
    throw new Error('Trim requires 0 <= inSec < outSec');
  if (sourceDuration !== undefined && (!Number.isFinite(sourceDuration) || outSec > sourceDuration + 0.001))
    throw new Error('Trim exceeds source duration');
  return outSec - inSec;
}

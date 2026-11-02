import { templateSchema, type Template } from './template';

export function newTemplate(): Template {
  return templateSchema.parse({
    template_id: 'tpl_clean_vertical', template_name: 'Clean Vertical', version: '1.0.0',
    canvas: { width: 1080, height: 1920, aspect_ratio: '9:16', fps: 60, background_color: '#09090b' },
    main_clip_layout: {
      source_aspect_handling: 'blur_pad', Position: { x: 0, y: 420, width: 1080, height: 1080, scale_mode: 'fit_width' },
      background_blur: { enabled: true, luma_radius: 25, luma_power: 2, brightness: -0.15, scale_height: 1920 },
    }, overlays: [],
    render_preset: { target_platform: 'tiktok_shorts', container: 'mp4', video: {
      codec: 'h264_nvenc', fallback_codec: 'libx264', rate_control: 'vbr', target_bitrate_kbps: 18000,
      max_bitrate_kbps: 24000, bufsize_kbps: 36000, profile: 'high', level: 'auto', pixel_format: 'yuv420p',
      nvenc_preset: 'p6', gop_size: 120,
    }, audio: { codec: 'aac', bitrate_kbps: 256, sample_rate: 48000, normalize_loudness: true } },
    publish_defaults: { tiktok: { mode: 'inbox', default_caption_suffix: '#gaming #clips', privacy_level: 'SELF_ONLY',
      disable_comment: false, disable_duet: false, disable_stitch: false },
      google_drive: { auto_upload: false, target_folder_name: 'AutoClipping_Renders' } },
  });
}

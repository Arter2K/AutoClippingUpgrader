import type { Template, Overlay } from './template';
import type { TimelineClip } from './timeline';
import type { BccChromaConfig } from './bcc-chroma';

export function videoBackgroundConfig(template: Template, clip?: TimelineClip, overlay?: Overlay): BccChromaConfig | undefined {
  if (clip?.background_removal) return clip.background_removal;
  if (!clip || clip.use_template_main_layout) return template.main_clip_layout.background_removal;
  return overlay?.type !== 'text' && overlay?.background_removal?.mode === 'bcc_chromakey_studio' ? overlay.background_removal : undefined;
}
export function mainPickerTarget(clip?: TimelineClip): string { return clip ? `main:${clip.id}` : 'main'; }

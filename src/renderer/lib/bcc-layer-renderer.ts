import type { BccChromaConfig } from '../../shared/bcc-chroma';
import type { Rect } from '../../shared/geometry';
import { BccChromaKeyShader } from './BccChromaKeyShader';
import { useEditorStore } from '../stores/editor-store';

export class BccLayerRenderer {
  private shader: BccChromaKeyShader | null = null;
  private background = document.createElement('canvas');
  private failed = false;
  draw(ctx: CanvasRenderingContext2D, source: HTMLVideoElement | HTMLImageElement, config: BccChromaConfig, rect: Rect, sourceOnly = false) {
    if (sourceOnly || config.view_mode === 'source_only' || this.failed) { ctx.drawImage(source, rect.x, rect.y, rect.width, rect.height); return; }
    try {
      this.shader ??= new BccChromaKeyShader();
      const t = ctx.getTransform(), scale = Math.max(.01, Math.min(1, Math.hypot(t.a, t.b), 2048 / Math.max(rect.width, rect.height)));
      const width = Math.max(1, Math.round(rect.width * scale)), height = Math.max(1, Math.round(rect.height * scale));
      const bg = this.background; if (bg.width !== width || bg.height !== height) { bg.width = width; bg.height = height; }
      const b = bg.getContext('2d')!; b.resetTransform(); b.clearRect(0, 0, width, height);
      // Inverse of the actual placement, including rotation and preview device scale.
      const inverse = t.translate(rect.x, rect.y).scale(rect.width / width, rect.height / height).inverse();
      b.setTransform(inverse); b.drawImage(ctx.canvas, 0, 0); b.resetTransform();
      const canvas = this.shader.render(source, bg, config, width, height, scale);
      const alpha = ctx.globalAlpha; if (config.view_mode === 'alpha_matte') ctx.globalAlpha = 1;
      ctx.drawImage(canvas, rect.x, rect.y, rect.width, rect.height); ctx.globalAlpha = alpha;
    } catch (error) {
      this.failed = true; this.shader?.dispose(); this.shader = null;
      useEditorStore.getState().notify(error instanceof Error ? error.message : String(error));
      ctx.drawImage(source, rect.x, rect.y, rect.width, rect.height);
    }
  }
  dispose() { this.shader?.dispose(); this.shader = null; this.background.width = this.background.height = 1; }
}

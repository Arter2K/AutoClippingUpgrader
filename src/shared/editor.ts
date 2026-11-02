import { z } from 'zod';
import { templateSchema, type Template, type MediaInfo, type Trim } from './template';
import type { SelectedUploadFile, UploadProgress } from './publishing';

export interface SourceMedia {
  id: string; name: string; url: string; path?: string; media: MediaInfo; posterUrl?: string; thumbnails: string[];
}
export interface MediaAsset { path: string; url: string; name: string; kind: 'image' | 'video' | 'audio' | 'font'; family?: string; media?: MediaInfo }
export interface SystemFont { path: string; name: string; family: string }
export interface HydratedTemplate { template: Template; assets: Record<string, string>; warnings: string[] }
export interface LibraryEntry { id: string; name: string; width: number; height: number; builtIn: boolean; layers: number }
export interface EditorSettings { autoUpload: boolean; driveFolderId: string; fallback: boolean }
export interface EditorDocument extends HydratedTemplate { source: SourceMedia | null; trim: Trim; name: string; settings?: EditorSettings }
export const projectSchema = z.object({
  format: z.literal('AutoClippingUpgrader'), version: z.literal(1), name: z.string().min(1).max(200),
  template: templateSchema, sourcePath: z.string().nullable(),
  trim: z.object({ inSec: z.number().nonnegative(), outSec: z.number().positive() }),
  settings: z.object({ autoUpload: z.boolean(), driveFolderId: z.string(), fallback: z.boolean() }).optional(),
});
export type ProjectFile = z.infer<typeof projectSchema>;
export interface RenderSubmission {
  sourceId: string; template: Template; trim: Trim; name: string;
  autoUpload: boolean; driveFolderId?: string; allowSoftwareFallback: boolean;
}
export interface RenderJob {
  id: string; name: string; outputPath: string;
  phase: 'queued' | 'rendering' | 'uploading' | 'complete' | 'error' | 'cancelled';
  fraction: number; speed: number | null; pass: number; passes: number;
  createdAt: number; message?: string; warnings?: string[]; codec?: string;
  outputUrl?: string; publishFile?: SelectedUploadFile; uploadProgress?: UploadProgress;
}
export interface EditorBridge {
  bootstrap(): Promise<{ library: LibraryEntry[]; draft: EditorDocument | null; defaultFont: MediaAsset | null; jobs: RenderJob[] }>;
  selectSource(): Promise<SourceMedia | null>;
  dropSource(file: File): Promise<SourceMedia>;
  demoSource(): Promise<SourceMedia>;
  selectAsset(kind: MediaAsset['kind']): Promise<MediaAsset | null>;
  systemFonts(): Promise<SystemFont[]>;
  adoptSystemFont(path: string): Promise<MediaAsset>;
  saveProcessedImage(sourcePath: string, bytes: ArrayBuffer): Promise<MediaAsset>;
  hydrate(template: Template): Promise<HydratedTemplate>;
  loadTemplate(id: string): Promise<HydratedTemplate>;
  saveTemplate(template: Template): Promise<LibraryEntry[]>;
  importTemplate(): Promise<HydratedTemplate | null>;
  exportTemplate(template: Template): Promise<boolean>;
  saveProject(document: { name: string; template: Template; sourceId: string | null; trim: Trim; settings?: EditorSettings }): Promise<boolean>;
  openProject(): Promise<EditorDocument | null>;
  saveDraft(document: { name: string; template: Template; sourceId: string | null; trim: Trim; settings?: EditorSettings }): Promise<void>;
  onPrepareClose(callback: () => void): () => void;
  confirmClose(): Promise<void>;
  preview(sourceId: string, template: Template, trim: Trim, timeSec: number): Promise<string>;
  cancelPreview(): Promise<void>;
  startRender(submission: RenderSubmission): Promise<string | null>;
  cancelRender(id: string): Promise<void>;
  revealOutput(id: string): Promise<void>;
  jobs(): Promise<RenderJob[]>;
  onJob(callback: (job: RenderJob) => void): () => void;
}

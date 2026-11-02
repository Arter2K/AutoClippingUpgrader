import type { MediaInfo } from './template';
import type { PublishingBridge } from './publishing';
import type { EditorBridge } from './editor';

export interface DesktopBridge {
  selectVideo(): Promise<{ path: string; media: MediaInfo } | null>;
  publishing: PublishingBridge;
  editor: EditorBridge;
}
declare global { interface Window { desktop: DesktopBridge } }

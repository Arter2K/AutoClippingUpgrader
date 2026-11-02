import { renderVideo, type RenderInput, type RenderOptions } from '../engine/renderer';
import type { UploadProgress, DriveFile } from '../../shared/publishing';
import type { DriveUpload } from './google-drive/resumable-upload';

/** Backend hook for step 3's render inspector. Drive starts only after a successful render. */
export async function renderAndArchive(input: RenderInput, options: RenderOptions & {
  autoUpload: boolean;
  driveFolderId?: string;
  onUploadProgress?: (progress: UploadProgress) => void;
}, drive?: Pick<DriveUpload, 'upload'>, render = renderVideo) {
  if (options.autoUpload && (!drive || !options.driveFolderId)) throw new Error('Connect Google Drive and select a folder before auto-upload');
  const plan = await render(input, options);
  let driveFile: DriveFile | undefined;
  if (options.autoUpload) driveFile = await drive!.upload(input.outputPath, options.driveFolderId!, {
    signal: options.signal, onProgress: options.onUploadProgress,
  });
  return { outputPath: input.outputPath, plan, driveFile };
}

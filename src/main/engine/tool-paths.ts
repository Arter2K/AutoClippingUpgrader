import path from 'node:path';
import { access } from 'node:fs/promises';

/** Native executables live outside app.asar; renderer code cannot choose executable paths. */
export async function configurePackagedTools(packaged: boolean, resourcesPath: string, environment = process.env) {
  if (!packaged) return;
  const ffmpeg = environment.FFMPEG_PATH || path.join(resourcesPath, 'ffmpeg', 'ffmpeg.exe');
  const ffprobe = environment.FFPROBE_PATH || path.join(resourcesPath, 'ffmpeg', 'ffprobe.exe');
  await Promise.all([access(ffmpeg), access(ffprobe)]);
  environment.FFMPEG_PATH = ffmpeg; environment.FFPROBE_PATH = ffprobe;
}

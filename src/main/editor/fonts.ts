import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { openSync } from 'fontkit';
import type { SystemFont } from '../../shared/editor';

export function fontMetadata(file: string) {
  const font = openSync(file);
  return { family: font.familyName, name: font.fullName || path.basename(file) };
}
let cache: SystemFont[] | undefined;
export async function systemFonts(): Promise<SystemFont[]> {
  if (cache) return cache;
  const directories = process.platform === 'win32' ? [path.join(process.env.SystemRoot ?? 'C:/Windows', 'Fonts'), path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft/Windows/Fonts')]
    : ['/usr/share/fonts/truetype/dejavu', '/usr/share/fonts/truetype/liberation2', '/System/Library/Fonts/Supplemental'];
  const fonts: SystemFont[] = [];
  for (const directory of directories) {
    const names = await readdir(directory).catch(() => []);
    for (const name of names) if (/\.(ttf|otf)$/i.test(name)) {
      const file = path.join(directory, name);
      try { fonts.push({ path: file, ...fontMetadata(file) }); } catch { /* Skip unsupported system font formats. */ }
    }
  }
  cache = fonts.sort((a, b) => a.name.localeCompare(b.name)); return cache;
}

import path from 'node:path';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';

const mime: Record<string, string> = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.ogg': 'audio/ogg',
  '.avi': 'video/x-msvideo', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ttf': 'font/ttf', '.otf': 'font/otf' };
export class MediaRegistry {
  hasPath(file: string) { return this.paths.has(path.resolve(file)); }
  private files = new Map<string, string>();
  private paths = new Map<string, string>();
  register(file: string): { id: string; url: string } {
    const absolute = path.resolve(file);
    if (!mime[path.extname(absolute).toLowerCase()]) throw new Error('Неподдерживаемый тип локального медиа');
    const id = this.paths.get(absolute) ?? randomUUID();
    this.files.set(id, absolute); this.paths.set(absolute, id);
    return { id, url: `acu-media://asset/${id}` };
  }
  resolve(id: string): string {
    const file = this.files.get(id); if (!file) throw new Error('Файл недоступен. Выберите его заново.'); return file;
  }
  async response(request: Request): Promise<Response> {
    const url = new URL(request.url), id = url.pathname.slice(1);
    const file = url.hostname === 'asset' && !url.search && !url.hash ? this.files.get(id) : undefined;
    if (!file || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 404 });
    try {
      const info = await stat(file);
      if (!info.isFile()) return new Response(null, { status: 404 });
      const headers = new Headers({ 'Content-Type': mime[path.extname(file).toLowerCase()]!, 'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' });
      let start = 0, end = info.size - 1, status = 200;
      const range = request.headers.get('range');
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${info.size}` } });
        if (!match[1]) start = Math.max(0, info.size - Number(match[2]));
        else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= info.size)
          return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${info.size}` } });
        headers.set('Content-Range', `bytes ${start}-${end}/${info.size}`); status = 206;
      }
      headers.set('Content-Length', String(Math.max(0, end - start + 1)));
      if (request.method === 'HEAD' || info.size === 0) return new Response(null, { status, headers });
      const stream = createReadStream(file, { start, end });
      request.signal.addEventListener('abort', () => stream.destroy(), { once: true });
      return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status, headers });
    } catch { return new Response(null, { status: 404 }); }
  }
}

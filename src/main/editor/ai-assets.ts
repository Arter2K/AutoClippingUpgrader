import path from 'node:path';
import { readFile } from 'node:fs/promises';
export async function aiAssetResponse(request: Request, root: string): Promise<Response> {
  const url = new URL(request.url), name = url.pathname.slice(1);
  if (url.hostname !== 'ai' || !/^(resources\.json|[a-f0-9]{64})$/.test(name) || request.method !== 'GET') return new Response(null, { status: 404 });
  try { return new Response(await readFile(path.join(root, name)), { headers: {
    'Content-Type': name.endsWith('.json') ? 'application/json' : 'application/octet-stream',
    'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin', 'Cache-Control': 'public, max-age=31536000, immutable',
  } }); } catch { return new Response('Local AI assets are missing. Run prepare:ai before building.', { status: 404 }); }
}

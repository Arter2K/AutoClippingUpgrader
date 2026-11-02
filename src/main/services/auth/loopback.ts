import { createServer, type Server } from 'node:http';
import type { AuthorizationSession } from './pkce';

export interface LoopbackReceiver {
  redirectUri: string;
  attach(session: AuthorizationSession): void;
  result: Promise<{ code: string; verifier: string }>;
  close(): void;
}
export async function startLoopback(signal?: AbortSignal, timeoutMs = 600000): Promise<LoopbackReceiver> {
  signal?.throwIfAborted();
  let session: AuthorizationSession | undefined;
  let resolve!: (value: { code: string; verifier: string }) => void;
  let reject!: (error: unknown) => void;
  const result = new Promise<{ code: string; verifier: string }>((yes, no) => { resolve = yes; reject = no; });
  // The caller attaches its await after opening the browser; avoid an unhandled rejection in between.
  void result.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  const cleanup = () => { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', abort); server.close(); };
  const abort = () => { if (!finished) { finished = true; reject(new DOMException('Cancelled', 'AbortError')); cleanup(); } };
  const server: Server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    if (req.method !== 'GET' || !session || req.headers.host !== new URL(session.redirectUri).host || !req.url?.startsWith('/callback?')) {
      res.writeHead(404); res.end('Not found'); return;
    }
    try {
      const code = session.accept(new URL(req.url, session.redirectUri).toString());
      res.end('Авторизация получена. Вернитесь в AutoClippingUpgrader.');
      finished = true; resolve(code); cleanup();
    } catch {
      res.writeHead(400); res.end('Недействительный ответ OAuth. Повторите авторизацию в приложении.');
      if (session.isConsumed) { finished = true; reject(new Error('Google authorization denied')); cleanup(); }
    }
  });
  await new Promise<void>((yes, no) => {
    const error = (cause: Error) => no(cause);
    server.once('error', error);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', error); yes(); });
  });
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  timer = setTimeout(() => { if (!finished) { finished = true; reject(new Error('Google OAuth timeout')); cleanup(); } }, timeoutMs);
  const address = server.address();
  if (!address || typeof address === 'string') { cleanup(); throw new Error('Cannot bind OAuth receiver'); }
  return { redirectUri: `http://127.0.0.1:${address.port}/callback`, attach: value => { session = value; }, result,
    close: abort };
}

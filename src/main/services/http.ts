import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

export type Fetcher = typeof fetch;
export class ApiError extends Error {
  constructor(readonly service: string, readonly status: number, readonly code: string, message: string) {
    super(`${service}: ${code} (${status}) — ${message}`);
    this.name = 'ApiError';
  }
}
export function safeMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.name === 'AbortError') return 'Операция отменена';
  // Network errors may contain signed upload URLs. Never expose arbitrary exception text to the renderer.
  return 'Операция не выполнена. Проверьте подключение, настройки приложения и повторите запрос.';
}
export async function request(fetcher: Fetcher, url: string, init: RequestInit & { duplex?: 'half' } = {}): Promise<Response> {
  const signal = AbortSignal.any([AbortSignal.timeout(120000), ...(init.signal ? [init.signal] : [])]);
  return fetcher(url, { ...init, signal, redirect: 'manual' });
}
export async function jsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  try { return JSON.parse(text); }
  catch { throw new ApiError('HTTP', response.status, 'invalid_response', 'Ожидался JSON-ответ сервера'); }
}
export async function googleJson<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const body = await jsonBody(response);
  if (!response.ok) {
    const error = z.object({ error: z.union([z.string(), z.object({ status: z.string().optional(), code: z.number().optional() })]) }).safeParse(body);
    const code = error.success ? (typeof error.data.error === 'string' ? error.data.error : error.data.error.status ?? 'api_error') : 'api_error';
    throw new ApiError('Google', response.status, code, 'Запрос отклонён; проверьте разрешения и OAuth-клиент');
  }
  return schema.parse(body);
}
export async function tiktokJson<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const body = await jsonBody(response);
  const envelope = z.object({ error: z.object({ code: z.string(), message: z.string().optional() }), data: z.unknown().optional() }).parse(body);
  if (!response.ok || envelope.error.code !== 'ok')
    throw new ApiError('TikTok', response.status, envelope.error.code, 'Запрос отклонён TikTok');
  return schema.parse(envelope.data);
}
export function retryable(status: number): boolean { return status === 429 || status >= 500; }
export async function backoff(attempt: number, signal?: AbortSignal, retryAfter?: string | null): Promise<void> {
  const seconds = retryAfter ? Number(retryAfter) : NaN;
  const ms = Number.isFinite(seconds) ? Math.min(30000, Math.max(0, seconds * 1000)) : Math.min(8000, 300 * 2 ** attempt);
  await delay(ms, undefined, { signal });
}
export function assertUploadUrl(value: string, provider: 'tiktok' | 'google'): string {
  const u = new URL(value);
  const validHost = provider === 'tiktok'
    ? u.hostname.endsWith('.tiktokapis.com')
    : (u.hostname === 'www.googleapis.com' || u.hostname.endsWith('.googleapis.com'));
  if (u.protocol !== 'https:' || !validHost || u.username || u.password || u.port && u.port !== '443')
    throw new Error('Untrusted upload endpoint');
  return u.toString();
}

import type { Provider } from '../src/shared/publishing';
import type { TokenStore, OAuthToken } from '../src/main/services/auth/token-vault';
import type { ResumeStore, DriveCheckpoint } from '../src/main/services/google-drive/resume-store';
import type { Fetcher } from '../src/main/services/http';

export class TestTokenStore implements TokenStore {
  data = new Map<Provider, OAuthToken>();
  async get(provider: Provider) { return structuredClone(this.data.get(provider) ?? null); }
  async set(provider: Provider, token: OAuthToken) { this.data.set(provider, structuredClone(token)); }
  async remove(provider: Provider) { this.data.delete(provider); }
}
export class TestResumeStore implements ResumeStore {
  data = new Map<string, DriveCheckpoint>();
  async get(key: string) { return structuredClone(this.data.get(key) ?? null); }
  async set(key: string, value: DriveCheckpoint) { this.data.set(key, structuredClone(value)); }
  async remove(key: string) { this.data.delete(key); }
}
export const token = (clientId: string, scopes: string[], expiresAt = Date.now() + 3600000): OAuthToken => ({
  clientId, scopes, expiresAt, accessToken: 'access-test-secret', refreshToken: 'refresh-test-secret',
});
export const json = (body: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(body), { status, headers });
export const tikJson = (data: unknown, status = 200, code = 'ok') => json({ data, error: { code } }, status);
export function fetchMock(fn: (url: string, init: RequestInit & { duplex?: 'half' }) => Promise<Response> | Response): Fetcher {
  return (async (input, init = {}) => fn(String(input), init)) as Fetcher;
}
export async function streamLength(body: BodyInit | null | undefined): Promise<number> {
  let bytes = 0;
  for await (const chunk of body as unknown as AsyncIterable<Buffer>) bytes += chunk.length;
  return bytes;
}

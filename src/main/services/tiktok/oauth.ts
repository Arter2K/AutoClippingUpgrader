import { z } from 'zod';
import { AuthorizationSession, createPkce } from '../auth/pkce';
import { OAuthClient } from '../auth/oauth-client';
import type { OAuthToken, TokenStore } from '../auth/token-vault';
import { ApiError, jsonBody, request, type Fetcher } from '../http';

export const TIKTOK_REDIRECT_URI = 'https://arter2k.github.io/AutoClippingUpgrader/callback';
export const TIKTOK_SCOPES = ['user.info.basic', 'video.publish', 'video.upload'];
const endpoint = 'https://open.tiktokapis.com/v2/oauth/token/';
const tokenResponse = z.object({
  access_token: z.string().min(1), refresh_token: z.string().min(1), expires_in: z.number().positive(),
  refresh_expires_in: z.number().positive(), scope: z.string(), open_id: z.string(),
});
export class TikTokOAuth extends OAuthClient {
  constructor(clientKey: string, private clientSecret: string, store: TokenStore, fetcher: Fetcher = fetch) {
    super('tiktok', clientKey, store, fetcher);
  }
  begin() {
    // TikTok Desktop explicitly specifies SHA256 hex, unlike Google's base64url.
    const session = new AuthorizationSession(TIKTOK_REDIRECT_URI, createPkce('hex'));
    const u = new URL('https://www.tiktok.com/v2/auth/authorize/');
    u.search = new URLSearchParams({ client_key: this.clientId, response_type: 'code', scope: TIKTOK_SCOPES.join(','),
      redirect_uri: session.redirectUri, state: session.pkce.state, code_challenge: session.pkce.challenge, code_challenge_method: 'S256' }).toString();
    return { session, authorizationUrl: u.toString() };
  }
  private async tokens(params: Record<string, string>, signal?: AbortSignal): Promise<OAuthToken> {
    const response = await request(this.fetcher, endpoint, { method: 'POST', signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_key: this.clientId, client_secret: this.clientSecret, ...params }).toString() });
    const body = await jsonBody(response);
    const parsed = tokenResponse.safeParse(body);
    if (!response.ok || !parsed.success) {
      const error = z.object({ error: z.string() }).safeParse(body);
      throw new ApiError('TikTok OAuth', response.status, error.success ? error.data.error : 'invalid_token_response', 'Не удалось получить токен');
    }
    const t = parsed.data;
    return { clientId: this.clientId, accessToken: t.access_token, refreshToken: t.refresh_token,
      expiresAt: Date.now() + t.expires_in * 1000, refreshExpiresAt: Date.now() + t.refresh_expires_in * 1000,
      scopes: t.scope.split(',').map(s => s.trim()).filter(Boolean), subject: t.open_id };
  }
  async complete(session: AuthorizationSession, callbackUrl: string, signal?: AbortSignal): Promise<void> {
    const { code, verifier } = session.accept(callbackUrl);
    const token = await this.tokens({ grant_type: 'authorization_code', code, redirect_uri: session.redirectUri, code_verifier: verifier }, signal);
    signal?.throwIfAborted();
    this.invalidate();
    await this.store.set('tiktok', token);
  }
  protected refresh(token: OAuthToken, signal?: AbortSignal): Promise<OAuthToken> {
    return this.tokens({ grant_type: 'refresh_token', refresh_token: token.refreshToken! }, signal);
  }
  override async disconnect(): Promise<void> {
    this.invalidate();
    const token = await this.current();
    if (token) {
      const response = await request(this.fetcher, 'https://open.tiktokapis.com/v2/oauth/revoke/', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_key: this.clientId, client_secret: this.clientSecret, token: token.accessToken }).toString(),
      });
      await response.body?.cancel();
      if (!response.ok) throw new ApiError('TikTok', response.status, 'revoke_failed', 'Не удалось отозвать разрешение');
    }
    await super.disconnect();
  }
}

import { z } from 'zod';
import { AuthorizationSession, createPkce } from '../auth/pkce';
import { OAuthClient } from '../auth/oauth-client';
import type { OAuthToken, TokenStore } from '../auth/token-vault';
import { googleJson, request, type Fetcher } from '../http';

export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const tokenResponse = z.object({ access_token: z.string().min(1), expires_in: z.number().positive(),
  refresh_token: z.string().min(1).optional(), scope: z.string().optional() });
export class GoogleOAuth extends OAuthClient {
  constructor(clientId: string, private clientSecret: string | undefined, readonly scopes: string[], store: TokenStore, fetcher: Fetcher = fetch) {
    super('google', clientId, store, fetcher);
  }
  begin(redirectUri: string) {
    const u = new URL(redirectUri);
    if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || !u.port) throw new Error('Google desktop redirect must use 127.0.0.1 with an ephemeral port');
    const session = new AuthorizationSession(redirectUri, createPkce('base64url'));
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: this.clientId, response_type: 'code', redirect_uri: redirectUri,
      scope: this.scopes.join(' '), state: session.pkce.state, code_challenge: session.pkce.challenge,
      code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent' }).toString();
    return { session, authorizationUrl: url.toString() };
  }
  private async tokens(params: Record<string, string>, previous?: OAuthToken, signal?: AbortSignal): Promise<OAuthToken> {
    const body = { client_id: this.clientId, ...(this.clientSecret ? { client_secret: this.clientSecret } : {}), ...params };
    const token = await googleJson(await request(this.fetcher, 'https://oauth2.googleapis.com/token', {
      method: 'POST', signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString(),
    }), tokenResponse);
    return { clientId: this.clientId, accessToken: token.access_token, refreshToken: token.refresh_token ?? previous?.refreshToken,
      expiresAt: Date.now() + token.expires_in * 1000,
      scopes: token.scope?.split(/\s+/).filter(Boolean) ?? previous?.scopes ?? this.scopes };
  }
  async exchange(redirectUri: string, code: string, verifier: string, signal?: AbortSignal): Promise<void> {
    const token = await this.tokens({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri }, undefined, signal);
    signal?.throwIfAborted();
    this.invalidate();
    await this.store.set('google', token);
  }
  protected refresh(token: OAuthToken, signal?: AbortSignal): Promise<OAuthToken> {
    return this.tokens({ grant_type: 'refresh_token', refresh_token: token.refreshToken! }, token, signal);
  }
  override async disconnect(): Promise<void> {
    this.invalidate();
    const token = await this.current();
    if (token) {
      const response = await request(this.fetcher, 'https://oauth2.googleapis.com/revoke', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: token.refreshToken ?? token.accessToken }).toString(),
      });
      await response.body?.cancel();
      // Google returns 400 for an already invalid/revoked token; local logout must still work.
      if (!response.ok && response.status !== 400) throw new Error('Google revoke failed');
    }
    await super.disconnect();
  }
}

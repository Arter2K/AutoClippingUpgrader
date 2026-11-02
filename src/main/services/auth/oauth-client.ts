import type { Provider, AccountState } from '../../../shared/publishing';
import type { TokenStore, OAuthToken } from './token-vault';
import { ApiError, request, type Fetcher } from '../http';

export abstract class OAuthClient {
  private refreshing?: Promise<OAuthToken>;
  private epoch = 0;
  constructor(readonly provider: Provider, readonly clientId: string, protected store: TokenStore, protected fetcher: Fetcher = fetch) {}
  protected abstract refresh(token: OAuthToken, signal?: AbortSignal): Promise<OAuthToken>;
  async current(): Promise<OAuthToken | null> {
    const token = await this.store.get(this.provider);
    return token?.clientId === this.clientId ? token : null;
  }
  async account(): Promise<AccountState> {
    const token = await this.current();
    return { connected: !!token && (token.expiresAt > Date.now() || !!token.refreshToken && (token.refreshExpiresAt ?? Infinity) > Date.now()),
      scopes: token?.scopes ?? [], ...(token ? { expiresAt: token.expiresAt } : {}) };
  }
  async accessToken(signal?: AbortSignal, force = false): Promise<string> {
    signal?.throwIfAborted();
    const token = await this.current();
    if (!token) throw new ApiError(this.provider, 401, 'not_connected', 'Подключите аккаунт');
    if (!force && token.expiresAt > Date.now() + 60000) return token.accessToken;
    if (!token.refreshToken || (token.refreshExpiresAt ?? Infinity) <= Date.now())
      throw new ApiError(this.provider, 401, 'reauthorize', 'Срок авторизации истёк; подключите аккаунт заново');
    // One refresh per account, even if several uploads request a token concurrently.
    if (!this.refreshing) {
      const epoch = this.epoch;
      // A shared refresh must survive cancellation of any one upload, especially when tokens rotate.
      this.refreshing = this.refresh(token).then(async next => {
        if (epoch !== this.epoch) throw new ApiError(this.provider, 401, 'disconnected', 'Аккаунт отключён');
        await this.store.set(this.provider, next); return next;
      }).finally(() => { this.refreshing = undefined; });
    }
    if (!signal) return (await this.refreshing).accessToken;
    return new Promise<string>((resolve, reject) => {
      const abort = () => reject(new DOMException('Cancelled', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      void this.refreshing!.then(next => { signal.removeEventListener('abort', abort); resolve(next.accessToken); },
        error => { signal.removeEventListener('abort', abort); reject(error); });
    });
  }
  async requireScopes(scopes: string[]) {
    const token = await this.current();
    if (!token || scopes.some(scope => !token.scopes.includes(scope)))
      throw new ApiError(this.provider, 403, 'missing_scope', 'Переподключите аккаунт и предоставьте необходимые разрешения');
  }
  async authorized(url: string, init: RequestInit & { duplex?: 'half' } = {}): Promise<Response> {
    const invoke = async (force: boolean) => {
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${await this.accessToken(init.signal ?? undefined, force)}`);
      return request(this.fetcher, url, { ...init, headers });
    };
    const response = await invoke(false);
    // Bodies of API requests are JSON/empty. Streaming PUT retries must reopen the file themselves.
    if (response.status === 401 && !(init.body && typeof init.body !== 'string')) {
      await response.body?.cancel();
      return invoke(true);
    }
    return response;
  }
  protected invalidate() { this.epoch++; }
  async disconnect(): Promise<void> { this.invalidate(); await this.store.remove(this.provider); }
}

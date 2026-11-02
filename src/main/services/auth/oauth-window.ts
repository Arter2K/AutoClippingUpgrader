import { BrowserWindow, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { isExactCallback, type AuthorizationSession } from './pkce';
import type { TikTokOAuth } from '../tiktok/oauth';

export class TikTokAuthorization {
  private pending?: { session: AuthorizationSession; controller: AbortController; timer: ReturnType<typeof setTimeout>;
    window?: BrowserWindow; exchanging: boolean };
  constructor(private oauth: TikTokOAuth, private owner: () => BrowserWindow | null,
    private onResult: (error?: unknown) => void) {}
  async begin(mode: 'window' | 'external') {
    this.cancel(false);
    const auth = this.oauth.begin();
    const pending: NonNullable<TikTokAuthorization['pending']> = { session: auth.session, controller: new AbortController(),
      exchanging: false, timer: setTimeout(() => { this.cancel(false); this.onResult(new Error('OAuth timeout')); }, 600000) };
    this.pending = pending;
    try {
      if (mode === 'external') await shell.openExternal(auth.authorizationUrl);
      else {
        const parent = this.owner();
        const win = new BrowserWindow({ width: 540, height: 790, title: 'TikTok — AutoClippingUpgrader',
          ...(parent ? { parent } : {}), autoHideMenuBar: true,
          webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true,
            partition: `oauth-${randomUUID()}` },
        });
        pending.window = win;
        const navigation = (event: Electron.Event, url: string) => {
          if (isExactCallback(url, auth.session.redirectUri)) {
            event.preventDefault();
            void this.complete(url).catch(() => {}); // complete reports failure through onResult.
          } else {
            try { if (new URL(url).protocol !== 'https:') event.preventDefault(); }
            catch { event.preventDefault(); }
          }
        };
        win.webContents.on('will-redirect', navigation);
        win.webContents.on('will-navigate', navigation);
        win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        win.on('closed', () => {
          if (this.pending === pending && !pending.exchanging) { this.cancel(false); this.onResult(new DOMException('Cancelled', 'AbortError')); }
        });
        await win.loadURL(auth.authorizationUrl).catch(error => { if (!pending.exchanging) throw error; });
      }
      return { authorizationUrl: auth.authorizationUrl };
    } catch (error) {
      if (this.pending === pending) { this.cancel(false); this.onResult(error); }
      throw error;
    }
  }
  async complete(callbackUrl: string): Promise<void> {
    const pending = this.pending;
    if (!pending || pending.exchanging) throw new Error('No active TikTok authorization');
    // Reject a pasted wrong URL without consuming or closing the active session.
    if (!isExactCallback(callbackUrl, pending.session.redirectUri)) throw new Error('Wrong callback URL');
    pending.exchanging = true;
    try {
      const exchange = this.oauth.complete(pending.session, callbackUrl, pending.controller.signal);
      pending.window?.close();
      await exchange;
      this.cleanup(pending); this.onResult();
    } catch (error) { this.cleanup(pending); this.onResult(error); throw error; }
  }
  private cleanup(pending: NonNullable<TikTokAuthorization['pending']>) {
    clearTimeout(pending.timer);
    if (this.pending === pending) this.pending = undefined;
    if (pending.window && !pending.window.isDestroyed()) pending.window.close();
  }
  cancel(notify = true) {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined; pending.controller.abort(); this.cleanup(pending);
    if (notify) this.onResult(new DOMException('Cancelled', 'AbortError'));
  }
}

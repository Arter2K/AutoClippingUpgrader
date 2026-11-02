import { shell } from 'electron';
import { startLoopback } from './loopback';
import type { GoogleOAuth } from '../google-drive/oauth';

export class GoogleAuthorization {
  private pending?: AbortController;
  constructor(private oauth: GoogleOAuth, private onResult: (error?: unknown) => void) {}
  async begin(): Promise<void> {
    this.cancel();
    const controller = new AbortController(); this.pending = controller;
    const receiver = await startLoopback(controller.signal);
    const auth = this.oauth.begin(receiver.redirectUri); receiver.attach(auth.session);
    const complete = async () => {
      try {
        const { code, verifier } = await receiver.result;
        await this.oauth.exchange(receiver.redirectUri, code, verifier, controller.signal);
        if (this.pending === controller) this.onResult();
      } catch (error) { if (this.pending === controller) this.onResult(error); }
      finally { receiver.close(); if (this.pending === controller) this.pending = undefined; }
    };
    void complete();
    try { await shell.openExternal(auth.authorizationUrl); }
    catch (error) { controller.abort(); throw error; }
  }
  cancel() { this.pending?.abort(); }
}

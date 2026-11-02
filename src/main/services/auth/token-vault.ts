import path from 'node:path';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Provider } from '../../../shared/publishing';

export const tokenSchema = z.object({
  accessToken: z.string().min(1), refreshToken: z.string().min(1).optional(),
  expiresAt: z.number().finite(), refreshExpiresAt: z.number().finite().optional(),
  scopes: z.array(z.string()), subject: z.string().optional(),
  clientId: z.string().min(1),
});
export type OAuthToken = z.infer<typeof tokenSchema>;
export interface TokenStore {
  get(provider: Provider): Promise<OAuthToken | null>;
  set(provider: Provider, token: OAuthToken): Promise<void>;
  remove(provider: Provider): Promise<void>;
}
export interface Encryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?(): string;
}
const vaultSchema = z.object({ tiktok: tokenSchema.optional(), google: tokenSchema.optional() });

/** OS encryption only. Refuses Linux basic_text fallback rather than silently storing plaintext. */
export class EncryptedTokenVault implements TokenStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private file: string, private encryption: Encryption) {}
  private assertEncryption() {
    if (!this.encryption.isEncryptionAvailable() || this.encryption.getSelectedStorageBackend?.() === 'basic_text')
      throw new Error('OS-backed token encryption is unavailable');
  }
  private async read() {
    this.assertEncryption();
    try { return vaultSchema.parse(JSON.parse(this.encryption.decryptString(await readFile(this.file)))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.queue.then(operation);
    this.queue = task.catch(() => {});
    return task;
  }
  async get(provider: Provider): Promise<OAuthToken | null> {
    return this.exclusive(async () => (await this.read())[provider] ?? null);
  }
  private update(operation: (data: z.infer<typeof vaultSchema>) => void): Promise<void> {
    return this.exclusive(async () => {
      const data = await this.read(); operation(data);
      await mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, this.encryption.encryptString(JSON.stringify(data)), { mode: 0o600, flag: 'wx' });
        await rename(temp, this.file);
      } finally { await rm(temp, { force: true }); }
    });
  }
  set(provider: Provider, token: OAuthToken): Promise<void> { return this.update(data => { data[provider] = tokenSchema.parse(token); }); }
  remove(provider: Provider): Promise<void> { return this.update(data => { delete data[provider]; }); }
}

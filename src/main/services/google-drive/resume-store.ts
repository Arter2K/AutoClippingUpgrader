import path from 'node:path';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Encryption } from '../auth/token-vault';

export const checkpointSchema = z.object({
  url: z.string().url(), filePath: z.string(), size: z.number().positive(), mtimeMs: z.number(),
  folderId: z.string(), ownerId: z.string(), createdAt: z.number(),
});
export type DriveCheckpoint = z.infer<typeof checkpointSchema>;
export interface ResumeStore {
  get(key: string): Promise<DriveCheckpoint | null>;
  set(key: string, checkpoint: DriveCheckpoint): Promise<void>;
  remove(key: string): Promise<void>;
}
export class EncryptedResumeStore implements ResumeStore {
  constructor(private directory: string, private encryption: Encryption) {}
  private file(key: string) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid checkpoint key');
    return path.join(this.directory, `${key}.bin`);
  }
  private assertEncryption() {
    if (!this.encryption.isEncryptionAvailable() || this.encryption.getSelectedStorageBackend?.() === 'basic_text')
      throw new Error('OS token encryption unavailable');
  }
  async get(key: string): Promise<DriveCheckpoint | null> {
    this.assertEncryption();
    try { return checkpointSchema.parse(JSON.parse(this.encryption.decryptString(await readFile(this.file(key))))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  async set(key: string, checkpoint: DriveCheckpoint) {
    this.assertEncryption();
    await mkdir(this.directory, { recursive: true });
    const file = this.file(key), temp = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, this.encryption.encryptString(JSON.stringify(checkpointSchema.parse(checkpoint))), { flag: 'wx', mode: 0o600 });
      await rename(temp, file);
    } finally { await rm(temp, { force: true }); }
  }
  async remove(key: string) { await rm(this.file(key), { force: true }); }
}

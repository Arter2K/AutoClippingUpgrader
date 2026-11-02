import { randomUUID } from 'node:crypto';
import type { RenderJob } from '../../shared/editor';

export class RenderQueue<T> {
  private items = new Map<string, { job: RenderJob; payload: T; controller: AbortController }>();
  private processing = false;
  constructor(private worker: (payload: T, update: (value: Partial<RenderJob>) => void, signal: AbortSignal) => Promise<void>,
    private emit: (job: RenderJob) => void) {}
  list(): RenderJob[] { return [...this.items.values()].map(item => structuredClone(item.job)); }
  enqueue(name: string, outputPath: string, payload: T): string {
    if (this.list().filter(j => ['queued', 'rendering', 'uploading'].includes(j.phase)).length >= 12) throw new Error('В очереди уже 12 заданий');
    if (this.list().some(j => j.outputPath === outputPath && !['error', 'cancelled'].includes(j.phase))) throw new Error('Это имя выходного файла уже занято заданием');
    const id = randomUUID();
    const job: RenderJob = { id, name, outputPath, phase: 'queued', fraction: 0, speed: null, pass: 1, passes: 1, createdAt: Date.now() };
    this.items.set(id, { job, payload: structuredClone(payload), controller: new AbortController() });
    this.emit(structuredClone(job)); void this.pump(); return id;
  }
  cancel(id: string) {
    const item = this.items.get(id); if (!item || !['queued', 'rendering', 'uploading'].includes(item.job.phase)) return;
    item.controller.abort();
    if (item.job.phase === 'queued') { item.job.phase = 'cancelled'; this.emit(structuredClone(item.job)); }
  }
  shutdown() { for (const id of this.items.keys()) this.cancel(id); }
  private async pump() {
    if (this.processing) return; this.processing = true;
    try {
      for (;;) {
        const item = [...this.items.values()].find(i => i.job.phase === 'queued'); if (!item) break;
        const update = (value: Partial<RenderJob>) => { Object.assign(item.job, value); this.emit(structuredClone(item.job)); };
        update({ phase: 'rendering' });
        try { await this.worker(item.payload, update, item.controller.signal); update({ phase: 'complete', fraction: 1 }); }
        catch (error) { update({ phase: item.controller.signal.aborted ? 'cancelled' : 'error', message: error instanceof Error ? error.message.slice(-5000) : String(error) }); }
      }
    } finally { this.processing = false; }
  }
}

export interface RenderProgress { fraction: number; timeSec: number; speed: number | null; pass: number; passes: number }

/** Keeps partial lines across pipe chunks. FFmpeg -progress is primary; stderr time=/speed= is also accepted. */
export class ProgressParser {
  private buffers = { stdout: '', stderr: '' };
  private timeSec = 0;
  private speed: number | null = null;
  private fraction = 0;
  constructor(private duration: number, private pass: number, private passes: number,
    private emit: (progress: RenderProgress) => void) {}

  push(chunk: string, stream: 'stdout' | 'stderr' = 'stdout'): void {
    this.buffers[stream] += chunk;
    const lines = this.buffers[stream].split(/[\r\n]/);
    this.buffers[stream] = lines.pop() ?? '';
    for (const line of lines) {
      const clock = line.match(/(?:out_time=|time=)(\d+):(\d+):(\d+(?:\.\d+)?)/);
      const micros = line.match(/^out_time_us=(\d+)/);
      const speed = line.match(/speed=\s*([\d.]+)x/);
      if (clock) this.timeSec = Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
      if (micros) this.timeSec = Number(micros[1]) / 1_000_000;
      if (speed) this.speed = Number(speed[1]);
      if (clock || micros || speed || line === 'progress=end') {
        this.fraction = Math.max(this.fraction, Math.min(0.999, ((this.pass - 1) + Math.min(1, this.timeSec / this.duration)) / this.passes));
        this.emit({ fraction: this.fraction, timeSec: this.timeSec, speed: this.speed, pass: this.pass, passes: this.passes });
      }
    }
  }
}

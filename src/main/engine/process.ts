import { spawn } from 'node:child_process';

export interface ProcessOptions {
  cwd?: string;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}
export async function runProcess(executable: string, args: string[], options: ProcessOptions = {}): Promise<string> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, shell: false, windowsHide: true,
      signal: options.signal, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout = (stdout + chunk).slice(-2_000_000);
      options.onStdout?.(chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-20000);
      options.onStderr?.(chunk);
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${executable} failed (${code ?? signal}):\n${stderr}`));
    });
  });
}

import type { BrowserWindow } from 'electron';

/** Give the renderer one bounded opportunity to flush the latest draft before closing. */
export function attachDraftClose(window: BrowserWindow) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  window.on('close', event => {
    if (window.webContents.isCrashed()) return;
    event.preventDefault();
    if (timer) return;
    window.webContents.send('editor:prepare-close');
    timer = setTimeout(() => { if (!window.isDestroyed()) window.destroy(); }, 3000);
  });
  window.on('closed', () => { if (timer) clearTimeout(timer); });
}

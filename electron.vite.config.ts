import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['zod', 'fontkit'] })],
    build: { outDir: 'dist-electron', rollupOptions: {
      input: 'src/main/index.ts', output: { entryFileNames: 'main.cjs', format: 'cjs' },
    } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { outDir: 'dist-electron', emptyOutDir: false, rollupOptions: {
      input: 'src/preload/index.ts', output: { entryFileNames: 'preload.cjs', format: 'cjs' },
    } },
  },
  renderer: {
    worker: { format: 'es' }, root: '.', plugins: [react(), tailwindcss()],
    build: { outDir: 'dist', rollupOptions: { input: 'index.html' } },
  },
});

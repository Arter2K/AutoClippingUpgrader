export async function removeImageBackground(url: string, signal: AbortSignal, progress: (message: string, fraction: number) => void): Promise<ArrayBuffer> {
  const response = await fetch(url, { signal }); if (!response.ok) throw new Error('Исходная картинка недоступна');
  const blob = await response.blob(), bytes = await blob.arrayBuffer(); signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./ai.worker.ts', import.meta.url), { type: 'module' });
    const dispose = () => { signal.removeEventListener('abort', abort); worker.terminate(); };
    const abort = () => { dispose(); reject(new DOMException('Операция отменена', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
    worker.onerror = event => { dispose(); reject(new Error(event.message || 'Не удалось запустить локальный AI worker')); };
    worker.onmessage = event => {
      const value = event.data;
      if (value.kind === 'progress') progress(value.key.startsWith('fetch:') ? 'Загрузка локальной модели' : 'Обработка изображения', value.total ? value.current / value.total : 0);
      if (value.kind === 'complete') { dispose(); resolve(value.bytes); }
      if (value.kind === 'error') { dispose(); reject(new Error(value.message)); }
    };
    progress('Запуск локальной модели', 0); worker.postMessage({ bytes, type: blob.type }, [bytes]);
  });
}

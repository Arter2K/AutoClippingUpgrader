import { removeBackground } from '@imgly/background-removal';
self.onmessage = async (event: MessageEvent<{ bytes: ArrayBuffer; type: string }>) => {
  try {
    const result = await removeBackground(new Blob([event.data.bytes], { type: event.data.type }), {
      publicPath: 'acu-media://ai/', model: 'isnet_quint8', device: 'cpu', proxyToWorker: false, output: { format: 'image/png', quality: 1 },
      progress: (key, current, total) => self.postMessage({ kind: 'progress', key, current, total }),
    });
    const bytes = await result.arrayBuffer(); self.postMessage({ kind: 'complete', bytes }, { transfer: [bytes] });
  } catch (error) { self.postMessage({ kind: 'error', message: error instanceof Error ? error.message : String(error) }); }
};

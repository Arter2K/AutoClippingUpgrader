import { useEffect, useState } from 'react';
import type { TimelineClip } from '../../../shared/timeline';

interface Peaks { values: Float32Array; duration: number }
const cache = new Map<string, Promise<Peaks>>();
function peaks(url: string): Promise<Peaks> {
  let pending = cache.get(url);
  if (!pending) {
    pending = (async () => {
      const context = new AudioContext();
      try {
        const response = await fetch(url); if (!response.ok) throw new Error('Audio unavailable');
        const buffer = await context.decodeAudioData(await response.arrayBuffer()), result = new Float32Array(2000);
        for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
          const data = buffer.getChannelData(channel);
          for (let i = 0; i < data.length; i++) { const bin = Math.min(result.length - 1, Math.floor(i / data.length * result.length)); result[bin] = Math.max(result[bin]!, Math.abs(data[i]!)); }
        }
        return { values: result, duration: buffer.duration };
      } finally { await context.close(); }
    })();
    if (cache.size >= 12) cache.delete(cache.keys().next().value!);
    cache.set(url, pending);
  }
  return pending;
}
export function Waveform({ url, clip }: { url?: string; clip: TimelineClip }) {
  const [data, setData] = useState<Peaks | null>(null), [unavailable, setUnavailable] = useState(false);
  useEffect(() => { let active = true; setData(null); setUnavailable(!url); if (url) void peaks(url).then(v => { if (active) setData(v); }).catch(() => { if (active) setUnavailable(true); }); return () => { active = false; }; }, [url]);
  if (!data) return <small className="waveform-status">{unavailable ? 'Waveform недоступна' : 'Waveform…'}</small>;
  const duration = data.duration, values = data.values;
  const count = 100, path: string[] = [];
  for (let i = 0; i < count; i++) {
    const from = Math.floor((clip.source_in_sec + clip.duration_sec * i / count) / duration * values.length);
    const to = Math.max(from + 1, Math.ceil((clip.source_in_sec + clip.duration_sec * (i + 1) / count) / duration * values.length));
    let peak = 0; for (let j = from; j < Math.min(values.length, to); j++) peak = Math.max(peak, values[j]!);
    const local = clip.duration_sec * i / count;
    const fade = (clip.fade_in_sec ? Math.min(1, local / clip.fade_in_sec) : 1) * (clip.fade_out_sec ? Math.min(1, (clip.duration_sec - local) / clip.fade_out_sec) : 1);
    const h = Math.min(19, peak * fade * 19); path.push(`M${i} ${22 - h}V${22 + h}`);
  }
  return <svg className="waveform" aria-label="Audio waveform" viewBox="0 0 100 44" preserveAspectRatio="none"><path d={path.join('')} /></svg>;
}

import { validateTrim, type Trim, type VideoSettings } from './template';

export interface SizeEstimate {
  megabytes: number | null;
  kind: 'bitrate_estimate' | 'content_dependent';
  durationSec: number;
  note: string;
}
/** Requested formula; unit is binary MiB, displayed in the product as MB. No mux overhead included. */
export function estimateFileSize(video: VideoSettings, audioKbps: number, trim: Trim): SizeEstimate {
  const durationSec = validateTrim(trim);
  if (!Number.isFinite(audioKbps) || audioKbps < 0 || !Number.isFinite(video.target_bitrate_kbps) || video.target_bitrate_kbps <= 0)
    throw new Error('Invalid bitrate');
  if (video.rate_control === 'crf' || video.rate_control === 'cqp')
    return { megabytes: null, kind: 'content_dependent', durationSec, note: 'CRF/CQP: размер зависит от содержимого; фиксированный битрейт не задан.' };
  return {
    megabytes: ((video.target_bitrate_kbps + audioKbps) * durationSec) / 8192,
    kind: 'bitrate_estimate', durationSec,
    note: 'MB (MiB), без накладных расходов MP4. VBR и AAC могут отличаться от целевого битрейта.',
  };
}

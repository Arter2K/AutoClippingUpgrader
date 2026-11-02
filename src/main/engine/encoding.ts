import type { VideoSettings } from '../../shared/template';

export function encodingArgs(v: VideoSettings): string[] {
  const nvenc = v.codec.endsWith('_nvenc');
  const args = ['-c:v', v.codec, '-preset', nvenc ? v.nvenc_preset : v.software_preset,
    '-profile:v', v.profile, '-pix_fmt', v.pixel_format, '-g', String(v.gop_size)];
  if (v.level !== 'auto') args.push('-level:v', v.level);
  if (v.codec.includes('hevc') || v.codec === 'libx265') args.push('-tag:v', 'hvc1');
  const kb = (n: number) => `${n}k`;
  switch (v.rate_control) {
    case 'crf':
      if (nvenc) args.push('-rc', 'vbr', '-cq', String(v.quality), '-b:v', '0');
      else args.push('-crf', String(v.quality));
      break;
    case 'cqp':
      if (nvenc) args.push('-rc', 'constqp');
      args.push('-qp', String(v.quality));
      break;
    case 'cbr':
      if (nvenc) args.push('-rc', 'cbr');
      args.push('-b:v', kb(v.target_bitrate_kbps), '-minrate', kb(v.target_bitrate_kbps),
        '-maxrate', kb(v.target_bitrate_kbps), '-bufsize', kb(v.bufsize_kbps));
      if (v.codec === 'libx264') args.push('-x264-params', 'nal-hrd=cbr:force-cfr=1');
      if (v.codec === 'libx265') args.push('-x265-params', 'strict-cbr=1:hrd=1');
      break;
    default:
      if (nvenc) args.push('-rc', 'vbr');
      args.push('-b:v', kb(v.target_bitrate_kbps), '-maxrate', kb(v.max_bitrate_kbps), '-bufsize', kb(v.bufsize_kbps));
      if (nvenc && v.rate_control === 'vbr_2pass') args.push('-multipass', 'fullres');
  }
  return args;
}

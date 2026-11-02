import { useEffect, useState } from 'react';
import { ArrowUpRight, Check, CloudUpload, Cpu, FolderOpen, HardDrive, LoaderCircle, Play, SlidersHorizontal, X } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { NumberField, Section, SelectField, Toggle } from '../../components/ui/fields';
import { useEditorStore, task, validationMessage } from '../../stores/editor-store';
import { estimateFileSize } from '../../../shared/estimate';
import type { DriveFolder } from '../../../shared/publishing';
import type { VideoSettings } from '../../../shared/template';
import { timelineDuration, timelineHasAudio } from '../../../shared/timeline';

export function RenderInspector() {
  const template = useEditorStore(s => s.template), source = useEditorStore(s => s.source), trim = useEditorStore(s => s.trim);
  const jobs = useEditorStore(s => s.jobs), autoUpload = useEditorStore(s => s.autoUpload), folderId = useEditorStore(s => s.driveFolderId), fallback = useEditorStore(s => s.fallback);
  const [driveConnected, setDriveConnected] = useState(false), [folders, setFolders] = useState<DriveFolder[]>([]);
  const v = template.render_preset.video, a = template.render_preset.audio, nvenc = v.codec.endsWith('_nvenc'), hevc = v.codec === 'hevc_nvenc' || v.codec === 'libx265';
  const quality = v.rate_control === 'cqp' || v.rate_control === 'crf', duration = template.timeline ? timelineDuration(template.timeline) : trim.outSec - trim.inSec;
  const estimate = estimateFileSize(v, (template.timeline ? timelineHasAudio(template.timeline) : source?.media.hasAudio) ? a.bitrate_kbps : 0, { inSec: 0, outSec: Math.max(0.001, duration) });
  const invalid = validationMessage(template);
  const timingError = !template.timeline && template.overlays.some(o => o.enabled !== false && ((!o.timing.full_duration && (o.timing.start_offset_sec >= Math.min(o.timing.end_offset_sec ?? duration, duration) || (o.timing.end_offset_sec ?? duration) > duration)) || o.timing.fade_in_sec + o.timing.fade_out_sec > (o.timing.full_duration ? duration : (o.timing.end_offset_sec ?? duration) - o.timing.start_offset_sec)));
  const change = (recipe: (video: VideoSettings) => void, record = true) => useEditorStore.getState().change(t => recipe(t.render_preset.video), record);
  const setBitrate = (value: number, record = true) => change(video => { video.target_bitrate_kbps = Math.round(value * 1000); video.max_bitrate_kbps = Math.max(video.max_bitrate_kbps, video.target_bitrate_kbps); video.bufsize_kbps = Math.max(video.bufsize_kbps, video.target_bitrate_kbps * 2); }, record);
  const refreshDrive = async () => { setDriveConnected((await window.desktop.publishing.state()).google.connected); };
  useEffect(() => {
    void refreshDrive().catch(() => {});
    return window.desktop.publishing.onEvent(event => { if (event.kind === 'auth' && event.provider === 'google') void refreshDrive().catch(() => {}); });
  }, []);
  const fixTiming = () => useEditorStore.getState().change(t => {
    for (const o of t.overlays) {
      o.timing.start_offset_sec = Math.min(o.timing.start_offset_sec, Math.max(0, duration - 0.1));
      if (!o.timing.full_duration) o.timing.end_offset_sec = Math.max(o.timing.start_offset_sec + Math.min(0.1, duration), Math.min(o.timing.end_offset_sec ?? duration, duration));
      const length = o.timing.full_duration ? duration : (o.timing.end_offset_sec ?? duration) - o.timing.start_offset_sec;
      o.timing.fade_in_sec = Math.min(o.timing.fade_in_sec, length / 2); o.timing.fade_out_sec = Math.min(o.timing.fade_out_sec, length / 2);
    }
  });
  return <div className="render-inspector">
    <div className="estimated-card"><div className="estimated-label"><HardDrive size={13} />ESTIMATED FILE SIZE<span className="live-pill">LIVE</span></div>
      <div className="estimated-value" aria-live="polite"><span data-testid="estimated-size">{source && estimate.megabytes !== null ? estimate.megabytes.toFixed(1) : '—'}</span><small>MB</small></div>
      <div className="estimated-meta"><span>{source ? `${duration.toFixed(1)} sec` : 'Выберите исходник'}</span><i />{quality ? <span>Content dependent</span> : <span>{(v.target_bitrate_kbps / 1000).toFixed(1)} Mbps</span>}</div>
      <p>{quality ? 'Размер CRF / CQP зависит от содержимого.' : 'Оценка в MiB · без накладных расходов MP4'}</p>
    </div>
    <Section title="ВИДЕО" badge={<span className="section-badge">MP4</span>}>
      <SelectField label="Кодек" value={v.codec} options={[{ value: 'h264_nvenc', label: 'H.264 · NVIDIA NVENC' }, { value: 'hevc_nvenc', label: 'H.265 / HEVC · NVIDIA NVENC' }, { value: 'libx264', label: 'H.264 · CPU (libx264)' }, { value: 'libx265', label: 'H.265 / HEVC · CPU (libx265)' }]}
        onValue={value => change(video => { video.codec = value as VideoSettings['codec']; const h265 = value === 'hevc_nvenc' || value === 'libx265'; video.fallback_codec = h265 ? 'libx265' : 'libx264'; video.profile = h265 ? 'main' : 'high'; video.level = 'auto'; })} />
      <div className="encoder-chip">{nvenc ? <Cpu size={12} /> : <SlidersHorizontal size={12} />}<span>{nvenc ? 'GPU encoding · фильтры на CPU' : 'Software encoding'}</span><span className="status-dot green" /></div>
      <div className="field-grid"><SelectField label="Частота кадров" value={template.canvas.fps} options={[30, 60, 120].map(value => ({ value, label: `${value} fps` }))}
        onValue={value => useEditorStore.getState().change(t => { t.canvas.fps = Number(value) as 30 | 60 | 120; t.render_preset.video.gop_size = Number(value) * 2; })} />
        <SelectField label="Rate control" value={v.rate_control} options={[{ value: 'cbr', label: 'CBR' }, { value: 'vbr', label: 'VBR · 1 pass' }, { value: 'vbr_2pass', label: 'VBR · 2 pass' }, { value: 'crf', label: nvenc ? 'CQ (CRF mode)' : 'CRF' }, { value: 'cqp', label: 'CQP' }]}
          onValue={value => change(video => { video.rate_control = value as VideoSettings['rate_control']; })} /></div>
      {quality ? <><div className="slider-title"><span>{v.rate_control === 'cqp' ? 'Quantizer (QP)' : nvenc ? 'Constant quality (CQ)' : 'Constant rate factor'}</span><strong>{v.quality}</strong></div>
        <input aria-label="Качество кодирования" className="accent-range" type="range" min={0} max={51} value={v.quality} onPointerDown={() => useEditorStore.getState().checkpoint()} onChange={e => change(video => { video.quality = Number(e.target.value); }, false)} /><div className="slider-scale"><span>Высокое качество</span><span>Меньше размер</span></div>
      </> : <><div className="slider-title"><span>Целевой битрейт</span><strong>{(v.target_bitrate_kbps / 1000).toFixed(1)} <small>Mbps</small></strong></div>
        <input aria-label="Целевой битрейт" className="accent-range" type="range" min={1} max={Math.max(60, v.target_bitrate_kbps / 1000)} step={0.5} value={v.target_bitrate_kbps / 1000}
          onPointerDown={() => useEditorStore.getState().checkpoint()} onChange={e => setBitrate(Number(e.target.value), false)} /><div className="slider-scale"><span>1 Mbps</span><span>60 Mbps</span></div>
        <div className="field-grid"><NumberField label="Target bitrate" value={v.target_bitrate_kbps / 1000} min={0.1} max={500} step={0.1} suffix="Mb/s" onValue={setBitrate} />
          <NumberField label="Max bitrate" value={v.max_bitrate_kbps / 1000} min={v.target_bitrate_kbps / 1000} max={500} step={0.1} suffix="Mb/s" onValue={value => change(video => { video.max_bitrate_kbps = Math.round(value * 1000); })} /></div>
      </>}
      <SelectField label="Encoder preset" value={nvenc ? v.nvenc_preset : v.software_preset} options={nvenc ? Array.from({ length: 7 }, (_, i) => ({ value: `p${i + 1}`, label: `P${i + 1}${i === 0 ? ' · Fastest' : i === 5 ? ' · Quality' : i === 6 ? ' · Slowest' : ''}` }))
        : ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'].map(value => ({ value, label: value }))}
        onValue={value => change(video => { if (nvenc) video.nvenc_preset = value as VideoSettings['nvenc_preset']; else video.software_preset = value as VideoSettings['software_preset']; })} />
      {nvenc && v.rate_control === 'vbr_2pass' && <p className="field-note">NVENC использует multipass fullres внутри кодировщика.</p>}
    </Section>
    <Section title="РАСШИРЕННЫЕ ПАРАМЕТРЫ" open={false}><div className="field-grid">
      <SelectField label="Profile" value={v.profile} options={(hevc ? ['main'] : ['baseline', 'main', 'high']).map(value => ({ value, label: value }))} onValue={value => change(video => { video.profile = value as VideoSettings['profile']; })} />
      <SelectField label="Level" value={v.level} options={['auto', '4.1', ...(hevc ? [] : ['4.2']), '5.1', '5.2', '6', '6.1', '6.2'].map(value => ({ value, label: value }))} onValue={value => change(video => { video.level = value as VideoSettings['level']; })} />
      <NumberField label="GOP / keyframes" value={v.gop_size} min={1} max={12000} onValue={value => change(video => { video.gop_size = value; })} />
      <NumberField label="Buffer size" value={v.bufsize_kbps / 1000} min={0.1} max={1000} step={0.1} suffix="Mb" onValue={value => change(video => { video.bufsize_kbps = Math.round(value * 1000); })} />
    </div><div className="format-note"><span>Pixel format</span><code>yuv420p</code></div>
      <Toggle label="Fallback на CPU при недоступном NVENC" checked={fallback} onChange={value => useEditorStore.setState({ fallback: value })} disabled={!nvenc} />
    </Section>
    <Section title="АУДИО" open={false}><div className="field-grid"><SelectField label="AAC bitrate" value={a.bitrate_kbps} options={[192, 256, 320].map(value => ({ value, label: `${value} kbps` }))}
      onValue={value => useEditorStore.getState().change(t => { t.render_preset.audio.bitrate_kbps = Number(value); })} />
      <label className="field-label">Sample rate<span className="readonly-field">48 000 Hz</span></label></div>
      <Toggle label="Нормализация громкости · −14 LUFS" checked={a.normalize_loudness} onChange={value => useEditorStore.getState().change(t => { t.render_preset.audio.normalize_loudness = value; })} />
      {source && !source.media.hasAudio && <p className="field-note">В исходнике нет аудиопотока. Экспорт будет без звука.</p>}
    </Section>
    <Section title="ПОСЛЕ РЕНДЕРА"><Toggle label="Загрузить в Google Drive" checked={autoUpload} disabled={!driveConnected && !autoUpload} onChange={value => {
      useEditorStore.setState({ autoUpload: value }); if (value) void task(async () => setFolders((await window.desktop.publishing.driveFolders()).files));
    }} />
      {!driveConnected && <button className="text-link" onClick={() => useEditorStore.setState({ tab: 'publish' })}>Подключить Google Drive <ArrowUpRight size={12} /></button>}
      {autoUpload && <><SelectField label="Папка Drive" value={folderId} options={[{ value: '', label: 'Выберите папку' }, ...folders.map(folder => ({ value: folder.id, label: folder.name })),
        ...(folderId && !folders.some(f => f.id === folderId) ? [{ value: folderId, label: 'Выбранная папка Drive' }] : [])]} onValue={value => useEditorStore.setState({ driveFolderId: value })} />
        <button className="text-link" onClick={() => useEditorStore.setState({ tab: 'publish' })}>Создать / выбрать другую папку <ArrowUpRight size={12} /></button></>}
    </Section>
    {timingError && <div className="inline-warning">Тайминги слоёв выходят за выбранную длину или fades пересекаются.<Button size="sm" variant="outline" onClick={fixTiming}>Подогнать тайминги</Button></div>}
    {invalid && <p className="inline-warning">{invalid}</p>}
    {jobs.length > 0 && <div className="render-jobs"><div className="panel-eyebrow"><span>ОЧЕРЕДЬ РЕНДЕРА</span><b>{jobs.length}</b></div>
      {jobs.map(job => <div key={job.id} className={`render-job ${job.phase}`}><div className="job-title"><span>{job.phase === 'complete' ? <Check size={13} /> : job.phase === 'uploading' ? <CloudUpload size={13} /> : job.phase === 'rendering' ? <LoaderCircle size={13} className="spin" /> : <span className="status-dot" />}{job.name}</span>
        {['queued', 'rendering', 'uploading'].includes(job.phase) && <button title="Отменить задание" aria-label="Отменить задание" onClick={() => void task(() => window.desktop.editor.cancelRender(job.id))}><X size={13} /></button>}</div>
        <progress aria-label="Прогресс рендера" max={1} value={job.phase === 'uploading' ? job.uploadProgress?.fraction ?? 0 : job.fraction} />
        <div className="job-meta"><span>{({ queued: 'В очереди', rendering: 'Рендер', uploading: 'Drive upload', complete: 'Готово', error: 'Ошибка', cancelled: 'Отменено' })[job.phase]}</span><span>{job.phase === 'rendering' ? `${(job.fraction * 100).toFixed(0)}% · ${job.speed ?? '—'}x · ${job.pass}/${job.passes}` : job.codec}</span></div>
        {job.message && <p className="job-message">{job.message}</p>}{job.warnings?.map((warning, i) => <p key={i} className="field-note">{warning}</p>)}
        {job.outputUrl && <div className="job-output-actions"><Button size="sm" variant="ghost" onClick={() => void task(() => window.desktop.editor.revealOutput(job.id))}><FolderOpen size={12} />Файл</Button>
          <Button size="sm" variant="ghost" onClick={() => useEditorStore.setState({ tab: 'publish' })}><ArrowUpRight size={12} />Публикация</Button></div>}
      </div>)}
    </div>}
  </div>;
}

export function RenderAction() {
  const template = useEditorStore(s => s.template), source = useEditorStore(s => s.source), trim = useEditorStore(s => s.trim);
  const autoUpload = useEditorStore(s => s.autoUpload), folderId = useEditorStore(s => s.driveFolderId), fallback = useEditorStore(s => s.fallback);
  const queued = useEditorStore(s => s.jobs.some(j => ['queued', 'rendering', 'uploading'].includes(j.phase)));
  const [choosing, setChoosing] = useState(false), duration = template.timeline ? timelineDuration(template.timeline) : trim.outSec - trim.inSec;
  const timingError = !template.timeline && template.overlays.some(o => o.enabled !== false && ((!o.timing.full_duration && (o.timing.start_offset_sec >= Math.min(o.timing.end_offset_sec ?? duration, duration) || (o.timing.end_offset_sec ?? duration) > duration)) || o.timing.fade_in_sec + o.timing.fade_out_sec > (o.timing.full_duration ? duration : (o.timing.end_offset_sec ?? duration) - o.timing.start_offset_sec)));
  const start = () => task(async () => {
    if (!source) return; setChoosing(true);
    try { await window.desktop.editor.startRender({ sourceId: source.id, template, trim, name: useEditorStore.getState().name,
      autoUpload, ...(folderId ? { driveFolderId: folderId } : {}), allowSoftwareFallback: fallback }); }
    finally { setChoosing(false); }
  });
  return <div className="render-action"><div className="render-summary"><span>{template.canvas.width} × {template.canvas.height}</span><i />{template.canvas.fps} fps<i />.mp4</div>
    <Button data-testid="render-button" variant="default" className="render-button" disabled={!source || duration <= 0 || !!validationMessage(template) || timingError || choosing || autoUpload && !folderId} onClick={start}>
      {choosing ? <LoaderCircle size={15} className="spin" /> : <Play size={14} fill="currentColor" />}{queued ? 'Добавить в очередь' : 'Экспортировать клип'}<span>↗</span>
    </Button><span className="render-footnote">Локальный рендер · исходник сохраняется</span>
  </div>;
}

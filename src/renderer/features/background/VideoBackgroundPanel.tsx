import { useEditorStore } from '../../stores/editor-store';
import { useTimelineStore } from '../../stores/timeline-store';
import { videoBackgroundConfig, mainPickerTarget } from '../../../shared/video-effects';
import { BackgroundPanel } from './BccBackgroundPanel';
import type { MediaOverlay } from '../../../shared/layer-effects';
import { Button } from '../../components/ui/button';

export function VideoBackgroundPanel() {
  const template = useEditorStore(s=>s.template), source = useEditorStore(s=>s.source);
  const selected = useTimelineStore(s=>s.selectedClipId);
  const clip = template.timeline?.tracks.flatMap(t=>t.clips).find(c=>c.id===selected);
  if (!source || (clip && clip.media_type !== 'video')) return null;
  const config = videoBackgroundConfig(template,clip);
  const layer: MediaOverlay = { id:mainPickerTarget(clip),name:clip?.name??'Основной клип',type:'video',
    source_path:clip?.source_path??source.path??'main',position:{...template.main_clip_layout.Position},z_index:0,scale:1,opacity:1,
    timing:{full_duration:true,start_offset_sec:0,end_offset_sec:null,fade_in_sec:0,fade_out_sec:0},background_removal:config };
  return <div className="video-background-panel"><p className="field-note">{clip ? `Эффект выбранного сегмента: ${clip.name}` : 'Эффект основного клипа · наследуется его сегментами'}
    <br />При активном кеинге размытая копия этого же видео скрывается, чтобы открыть нижние дорожки.</p>
    {clip?.background_removal && clip.use_template_main_layout && <Button size="sm" variant="outline" onClick={()=>useEditorStore.getState().setVideoBackground(undefined,clip.id)}>Наследовать общий BCC</Button>}
    <BackgroundPanel layer={layer} onConfig={(value,record)=>useEditorStore.getState().setVideoBackground(value,clip?.id,record)} />
  </div>;
}

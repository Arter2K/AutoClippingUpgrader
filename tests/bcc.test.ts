import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bccChromaSchema, newBccChroma, bccRawAlpha, bccMatteLevel, bccDespill, averagePixelColor, morphologyPasses } from '../src/shared/bcc-chroma';
import { bccSettings } from '../src/shared/layer-effects';
import { buildBccKey, buildLightWrap, layerAlphaFilters, weightedAlphaExpression } from '../src/main/engine/bcc-chroma';
import { buildGraph } from '../src/main/engine/graph';
import { templateSchema } from '../src/shared/template';
import { newTemplate } from '../src/shared/defaults';
import { migrateTimeline } from '../src/shared/timeline-migration';
import { useEditorStore } from '../src/renderer/stores/editor-store';

test('BCC defaults, bounds, clip ordering and legacy compatibility', () => {
  const c = newBccChroma(); assert.equal(c.matte_cleanup.matte_choke_px, -1.5); assert.equal(c.primary_key.similarity, .14);
  c.matte_cleanup.black_clip = .9; c.matte_cleanup.white_clip = .8; assert.equal(bccChromaSchema.safeParse(c).success, false);
  const invalid = newBccChroma(); invalid.primary_key.hue_weight = 3; assert.equal(bccChromaSchema.safeParse(invalid).success, false);
  invalid.primary_key.hue_weight = 1; invalid.light_wrap.width_px = 31; assert.equal(bccChromaSchema.safeParse(invalid).success, false);
  assert.equal(templateSchema.safeParse(newTemplate()).success, true);
});
test('weighted key, matte contrast/gamma and strength/balance/luma have real effects', () => {
  const c = newBccChroma(); assert.equal(bccRawAlpha([0,1,0],c),0); assert.equal(bccRawAlpha([1,0,0],c),1);
  assert.equal(bccMatteLevel(.05,c),0); assert.equal(bccMatteLevel(.95,c),1); assert.ok(Math.abs(bccMatteLevel(.5,c)-.5)<.00001);
  c.matte_cleanup.matte_gamma = 2; assert.ok(bccMatteLevel(.5,c)>.7);
  const raw = bccRawAlpha([.2,.6,.1],c); c.primary_key.hue_weight = 0; c.primary_key.saturation_weight = 0; c.primary_key.luma_weight = 0; assert.equal(bccRawAlpha([.2,.6,.1],c),0); assert.ok(raw>0);
  const key = newBccChroma(); key.spill_suppression.restore_luminance = false;
  const original = [.3,.7,.2], cleaned = bccDespill(original,key); assert.ok(cleaned[1]!<original[1]!);
  key.spill_suppression.strength=0; assert.deepEqual(bccDespill(original,key),original);
  key.spill_suppression.strength=1; key.spill_suppression.restore_luminance=true;
  const restored = bccDespill(original,key); assert.ok(restored[0]!>original[0]!);
  const native=newBccChroma();Object.assign(native.primary_key,{hue_weight:1,saturation_weight:1,luma_weight:0});
  assert.equal(bccRawAlpha([0,1,0],native),0);assert.equal(bccRawAlpha([1,0,0],native),1);
  native.primary_key.key_color='#000000';assert.equal(bccRawAlpha([0,0,0],native),0);assert.equal(bccRawAlpha([1,1,1],native),1);
});
test('fractional morphology and transparent-aware 3x3 average are deterministic', () => {
  assert.deepEqual(morphologyPasses(-1.5), { count:1,fraction:.5,expand:false }); assert.deepEqual(morphologyPasses(2),{count:2,fraction:0,expand:true});
  const pixels = new Uint8ClampedArray(9*4); for(let i=0;i<9;i++) pixels.set(i===4?[255,0,0,255]:[0,255,0,255],i*4);
  assert.equal(averagePixelColor(pixels),'#1ce300'); assert.equal(averagePixelColor(new Uint8ClampedArray([255,0,0,0,0,255,0,255])),'#00ff00');
});
test('FFmpeg matte graph contains fractional choke, blur, levels, gamma, despill and original alpha multiplication', () => {
  const c = newBccChroma(), graph = buildBccKey('[0:v]format=rgba','key_',c).filters.join(';');
  assert.match(graph,/split=3\[key_rgb_raw\]\[key_key_src\]/); assert.match(graph,/erosion=coordinates=255/); assert.match(graph,/A\*0.5\+B\*0.5/);
  assert.match(graph,/gblur=sigma=1.5/); assert.match(graph,/colorlevels=rimin=0.1:rimax=0.9/); assert.match(graph,/eq=gamma=1/);
  assert.match(graph,/despill=type=green:mix=0.5:expand=0:red=0:green=-0.85:blue=0:brightness=0.49895/);
  assert.match(graph,/blend=all_expr='A\*B\/255'/); assert.match(graph,/alphamerge/); assert.ok(weightedAlphaExpression(c).includes('pow('));
  c.primary_key.hue_weight=1;c.primary_key.saturation_weight=1;c.primary_key.luma_weight=0;c.matte_cleanup.matte_choke_px=2;
  const native = buildBccKey('[0:v]format=rgba','n_',c).filters.join(';'); assert.match(native,/chromakey=color=0x00FF00:similarity=0.14:blend=0.25/); assert.equal((native.match(/dilation=/g)??[]).length,2);
  const wrap=buildLightWrap('[fg]','[bg]','wrap_',c).filters.join(';'); assert.match(wrap,/gblur=sigma=6/); assert.match(wrap,/maskedmerge=planes=7/);
  assert.equal(layerAlphaFilters(.5,2,5,.2,.4),'colorchannelmixer=aa=0.5,fade=t=in:st=2:d=0.2:alpha=1,fade=t=out:st=4.6:d=0.4:alpha=1');
});
test('BCC is compiled per layer, wraps actual lower timeline stage, preview mode never leaks to export and eyedropper keeps settings', () => {
  const t=newTemplate(), config=newBccChroma();
  t.overlays=templateSchema.parse({...t,overlays:[{id:'key',name:'key',type:'image',source_path:'key.png',position:{x:10,y:20,width:64,height:64},z_index:1,timing:{full_duration:true},background_removal:config}]}).overlays;
  const o=t.overlays[0]!; if(o.type==='text')throw Error(); assert.equal(bccSettings(o)?.mode,'bcc_chromakey_studio');
  const final=buildGraph(t,2,'.').graph; config.view_mode='alpha_matte'; o.background_removal=config; assert.equal(buildGraph(t,2,'.').graph,final);
  t.timeline=migrateTimeline(t,{id:'s',path:'source.mp4',name:'s',url:'',thumbnails:[],media:{durationSec:2,width:64,height:64,hasAudio:false}},{inSec:0,outSec:2});
  const timeline=buildGraph(t,2,'.').graph; assert.match(timeline,/\[stage1\]split=2\[seg1_wrap_base\]/);
  useEditorStore.setState({template:t,past:[],future:[]}); useEditorStore.getState().pickColor('key','#123456');
  const picked=useEditorStore.getState().template.overlays[0]!; if(picked.type==='text'||picked.background_removal?.mode!=='bcc_chromakey_studio')throw Error();
  assert.equal(picked.background_removal.primary_key.key_color,'#123456'); assert.equal(picked.background_removal.matte_cleanup.matte_choke_px,-1.5);
  useEditorStore.getState().undo(); const restored=useEditorStore.getState().template.overlays[0]!; if(restored.type==='text')throw Error(); assert.equal(bccSettings(restored)?.primary_key.key_color,'#00FF00');
});

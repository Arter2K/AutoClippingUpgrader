import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { templateSchema } from '../src/shared/template';
import { chromaSettings, resolvedTextStyle, textMotion, textLayout, type TextOverlay } from '../src/shared/layer-effects';
import { generateAss, escapeAssText } from '../src/main/engine/ass';
import { buildGraph } from '../src/main/engine/graph';
import { useEditorStore } from '../src/renderer/stores/editor-store';
import { applyChromaKey } from '../src/renderer/lib/chroma-key';
import { fixture } from './helpers';

export function richText(): TextOverlay {
  const t = templateSchema.parse(JSON.parse(readFileSync('templates/gaming-reference.json', 'utf8')));
  const o = t.overlays.find(o => o.type === 'text') as TextOverlay;
  o.style.font_file = process.env.TEST_FONT_PATH ?? (process.platform === 'win32' ? 'C:/Windows/Fonts/arial.ttf' : '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf');
  o.style.fill_color = '#FFFFFF'; o.style.font_weight = '700'; o.style.font_size = 24;
  o.style.background_box = { enabled: true, color: '#6633CC', opacity: 0.8, padding_x: 10, padding_y: 8, border_radius: 12 };
  o.position = { x: 90, y: 160, anchor: 'center', rotation: 15, scale: 1.1 };
  o.text_content = 'Привет\nмир {\\pos(0,0)}';
  o.timing = { full_duration: false, start_offset_sec: 0.5, end_offset_sec: 2.5, fade_in_sec: 0, fade_out_sec: 0 };
  o.animation = { in_preset: 'pop_bounce', out_preset: 'slide_up', duration_sec: 0.25 };
  return o;
}
test('new template accepts nested styles without legacy font_color and validates effects bounds', () => {
  const t = fixture(), o = richText(); t.overlays = [o];
  const raw = JSON.parse(JSON.stringify(t)); delete raw.overlays[0].style.font_color;
  assert.ok(templateSchema.safeParse(raw).success);
  raw.overlays[0].style.stroke = { enabled: true, color: '#FFFFFF', width: 21 }; assert.equal(templateSchema.safeParse(raw).success, false);
  delete raw.overlays[0].style.stroke; raw.overlays[0].position.rotation = 181; assert.equal(templateSchema.safeParse(raw).success, false);
});
test('motion shares entry, bounce overshoot, exit and centered multiline alignment', () => {
  const o = richText(); o.scale = 1;
  assert.equal(textMotion(o, 0.4, 3).alpha, 0); assert.equal(textMotion(o, 0.5, 3).scale, 0);
  assert.ok(textMotion(o, 0.65, 3).scale > 1.1); assert.equal(textMotion(o, 1.5, 3).scale, 1.1);
  assert.ok(textMotion(o, 2.4, 3).offsetY < 0); assert.equal(textMotion(o, 2.5, 3).alpha, 0);
  o.style.text_align = 'right'; o.style.line_height = 1.5; o.text_content = 'abc\na';
  const layout = textLayout(o, line => line.length * 10); assert.equal(layout.rows[1]!.x - layout.rows[0]!.x, 20); assert.equal(layout.height, 60);
});
test('ASS safely handles literal tags, Cyrillic, rounded vector boxes and relative font paths', () => {
  const o = richText(), t = fixture(); t.overlays = [o];
  o.style.font_file = path.relative(process.cwd(), o.style.font_file);
  const graph = buildGraph(t, 3, process.cwd()), ass = graph.files[0]!.content;
  assert.match(graph.graph, /ass=filename=caption-0.ass:fontsdir=\./); assert.match(ass, /\\p1}m /);
  assert.match(ass, /\\frz-15/); assert.match(ass, /Привет/); assert.match(ass, /\\b700/);
  assert.ok(ass.includes(escapeAssText('{\\pos(0,0)}')));
  assert.ok(!escapeAssText('{\\pos(0,0)}').startsWith('{'));
  assert.match(generateAss(o, 180, 320, 60, 3, path.resolve(o.style.font_file)), /PlayResY: 320/);
});
test('chroma precedence, RGB black key and despill preserve foreground alpha', () => {
  const pixels = new Uint8ClampedArray([0,255,0,255,255,0,0,128,0,255,0,0]);
  applyChromaKey(pixels, { key_color:'#00FF00', similarity:0.15, blend:0.05, despill:true });
  assert.deepEqual([pixels[3],pixels[7],pixels[11]], [0,128,0]);
  const neutrals = new Uint8ClampedArray([0,0,0,255,255,255,255,255]);
  applyChromaKey(neutrals, { key_color:'#000000', similarity:0.15, blend:0.05, despill:false });
  assert.equal(neutrals[3],0); assert.equal(neutrals[7],255);
  const o = templateSchema.parse({ ...fixture(), overlays:[{ id:'image', name:'image',type:'image',source_path:'image.png',position:{x:0,y:0,width:10,height:10},z_index:1,timing:{full_duration:true},chroma_key:{color:'#00FF00'},background_removal:{mode:'chromakey',enabled:false,key_color:'#0000FF'} }] }).overlays[0]!;
  if (o.type === 'text') throw Error(); assert.equal(chromaSettings(o),null);
  useEditorStore.setState({template:{...fixture(),overlays:[o]},past:[],future:[]}); useEditorStore.getState().pickColor(o.id,'#112233');
  const picked = useEditorStore.getState().template.overlays[0]!; if(picked.type==='text') throw Error();
  assert.equal(chromaSettings(picked)?.key_color,'#112233'); assert.equal(picked.chroma_key,undefined);
  useEditorStore.getState().undo(); assert.equal(useEditorStore.getState().template.overlays[0]!.id,o.id);
  assert.equal(resolvedTextStyle(richText()).fill_color,'#FFFFFF');
});

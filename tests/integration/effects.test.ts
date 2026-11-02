import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { runProcess } from '../../src/main/engine/process';
import { renderPreview } from '../../src/main/engine/preview';
import { fixture } from '../helpers';
import { templateSchema } from '../../src/shared/template';

const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';
test('real chromakey/despill: green, blue and black retain source alpha and white detail', { timeout: 60000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'acu-effects-'));
  try {
    const source = path.join(dir,'base.mp4');
    await runProcess(ffmpeg,['-v','error','-f','lavfi','-i','color=c=blue:s=64x64:r=30:d=1','-c:v','libx264',source]);
    for (const [name,rgb] of [['green',[0,255,0]],['blue',[0,0,255]],['black',[0,0,0]]] as const) {
      const raw = Buffer.alloc(64*64*4);
      for (let y=0;y<64;y++) for(let x=0;x<64;x++) raw.set(x<16 ? [...rgb,255] : x<32 ? [255,0,0,128] : x<48 ? [255,0,0,0] : [255,255,255,255], (y*64+x)*4);
      const bytes = path.join(dir,`${name}.rgba`), image = path.join(dir,`${name}.png`), output = path.join(dir,`${name}-frame.png`);
      await writeFile(bytes,raw);
      await runProcess(ffmpeg,['-v','error','-f','rawvideo','-pixel_format','rgba','-video_size','64x64','-i',bytes,'-frames:v','1',image]);
      const t = fixture(); Object.assign(t.canvas,{width:64,height:64,fps:30});
      Object.assign(t.main_clip_layout,{source_aspect_handling:'center_crop',Position:{x:0,y:0,width:64,height:64,scale_mode:'cover'}});
      t.overlays=[{id:'key',name:'key',type:'image',source_path:image,z_index:1,scale:1,opacity:1,position:{x:0,y:0,width:64,height:64},
        timing:{full_duration:true,start_offset_sec:0,end_offset_sec:null,fade_in_sec:0,fade_out_sec:0},
        background_removal:{mode:'chromakey',enabled:true,key_color:name==='green'?'#00FF00':name==='blue'?'#0000FF':'#000000',similarity:0.15,blend:0.05,despill:name!=='black'}}];
      await renderPreview(source,t,{inSec:0,outSec:1},0.5,output);
      const decoded=spawnSync(ffmpeg,['-v','error','-i',output,'-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{windowsHide:true});
      assert.equal(decoded.status,0,String(decoded.stderr));
      const pixel=(x:number)=>Array.from(decoded.stdout.subarray((32*64+x)*3,(32*64+x)*3+3));
      assert.ok(pixel(8)[2]!>230 && pixel(8)[0]!<15,`${name}: keyed background ${pixel(8)}`);
      assert.ok(Math.abs(pixel(24)[0]!-128)<15 && Math.abs(pixel(24)[2]!-127)<15,`${name}: original alpha ${pixel(24)}`);
      assert.ok(pixel(40)[2]!>230 && pixel(40)[0]!<15,`${name}: fully transparent ${pixel(40)}`);
      assert.ok(pixel(56).every(c=>c>235),`${name}: white preserved ${pixel(56)}`);
    }
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('real ASS: Cyrillic multiline text, escaped tags, rotation, shadow and rounded box across motion presets', { timeout:60000 }, async () => {
  const dir=await mkdtemp(path.join(tmpdir(),'acu-ass-'));
  try {
    const source=path.join(dir,'base.mp4'); await runProcess(ffmpeg,['-v','error','-f','lavfi','-i','color=c=black:s=180x320:r=60:d=2','-c:v','libx264',source]);
    const t=fixture(); Object.assign(t.canvas,{width:180,height:320,fps:60}); t.main_clip_layout.source_aspect_handling='center_crop'; t.main_clip_layout.Position={x:0,y:0,width:180,height:320,scale_mode:'cover'};
    const reference=templateSchema.parse(JSON.parse(await readFile('templates/gaming-reference.json','utf8')));
    const text=reference.overlays.find(o=>o.type==='text')!; if(text.type!=='text') throw Error();
    text.style.font_file=process.env.TEST_FONT_PATH ?? (process.platform==='win32'?'C:/Windows/Fonts/arial.ttf':'/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf');
    Object.assign(text.style,{font_size:18,font_weight:'700',italic:true,uppercase:true,text_align:'center',letter_spacing:1,line_height:1.3,fill_color:'#FFFFFF',fill_opacity:0.8,
      stroke:{enabled:true,color:'#FF0000',width:1},shadow:{enabled:true,color:'#FFFF00',opacity:0.6,offset_x:3,offset_y:4,blur:2},
      background_box:{enabled:true,color:'#6633CC',opacity:0.7,padding_x:5,padding_y:4,border_radius:8}});
    text.position={x:90,y:160,anchor:'center',rotation:-15,scale:1.1}; text.scale=1; text.text_content='Привет\n{\\pos(0,0)}';
    text.timing={full_duration:true,start_offset_sec:0,end_offset_sec:null,fade_in_sec:0,fade_out_sec:0}; t.overlays=[text];
    const hashes=new Set<string>();
    for(const preset of ['none','fade_in','pop_bounce','slide_up','slide_down'] as const) {
      text.animation={in_preset:preset,out_preset:preset==='fade_in'?'fade_out':preset,duration_sec:0.25};
      const output=path.join(dir,`${preset}.png`); await renderPreview(source,t,{inSec:0,outSec:2},0.1,output);
      const png=await readFile(output); assert.ok(png.length>500); hashes.add(png.toString('base64'));
    }
    assert.equal(hashes.size,5,'Every motion preset must change the rendered entry frame');
  } finally { await rm(dir,{recursive:true,force:true}); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, writeFile, readFile, rm, mkdir, copyFile } from 'node:fs/promises';
import { runProcess } from '../../src/main/engine/process';
import { buildBccKey } from '../../src/main/engine/bcc-chroma';
import { newBccChroma, bccDespill } from '../../src/shared/bcc-chroma';
import { newTemplate } from '../../src/shared/defaults';
import { migrateTimeline } from '../../src/shared/timeline-migration';
import { renderPreview } from '../../src/main/engine/preview';

const ffmpeg=process.env.FFMPEG_PATH??'ffmpeg';
test('real BCC matte: source alpha, fractional erosion/dilation, gamma, weighted primary and green/blue despill', {timeout:60000}, async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'acu-bcc-'));
  try {
    const image=path.join(dir,'input.rgba'), bytes=Buffer.alloc(64*64*4);
    for(let y=0;y<64;y++)for(let x=0;x<64;x++) bytes.set(x<16?[0,255,0,255]:x<32?[255,0,0,128]:x<48?[255,0,0,0]:[255,255,255,255],(y*64+x)*4);
    await writeFile(image,bytes); let serial=0;
    const render=async(c:ReturnType<typeof newBccChroma>, input=image)=>{
      const graph=buildBccKey('[0:v]format=rgba','k_',c), file=path.join(dir,`g${serial}.ffgraph`), output=path.join(dir,`o${serial++}.rgba`);
      await writeFile(file,graph.filters.join(';\n'));
      await runProcess(ffmpeg,['-v','error','-f','rawvideo','-pixel_format','rgba','-video_size','64x64','-i',input,'-/filter_complex',file,'-map',graph.output,'-frames:v','1','-threads','1','-pix_fmt','rgba','-f','rawvideo',output]);
      return readFile(output);
    };
    const pixel=(b:Buffer,x:number)=>[...b.subarray((32*64+x)*4,(32*64+x)*4+4)];
    const c=newBccChroma(); Object.assign(c.matte_cleanup,{matte_choke_px:0,matte_softness_px:0,black_clip:0,white_clip:1});
    let out=await render(c); assert.equal(pixel(out,8)[3],0); assert.ok(Math.abs(pixel(out,24)[3]!-128)<3); assert.equal(pixel(out,40)[3],0); assert.ok(pixel(out,56)[3]!>250);
    // An opaque red rectangle gives independent topology checks without source-alpha constraints.
    const shape=path.join(dir,'shape.rgba'), raw=Buffer.alloc(64*64*4);
    for(let y=0;y<64;y++)for(let x=0;x<64;x++)raw.set(x>=16&&x<48&&y>=16&&y<48?[255,0,0,255]:[0,255,0,255],(y*64+x)*4); await writeFile(shape,raw);
    c.matte_cleanup.matte_choke_px=-1.5; out=await render(c,shape); assert.ok(pixel(out,16)[3]!<5); assert.ok(pixel(out,17)[3]!>100&&pixel(out,17)[3]!<155); assert.ok(pixel(out,20)[3]!>250);
    c.matte_cleanup.matte_choke_px=1.5; out=await render(c,shape); assert.ok(pixel(out,15)[3]!>250); assert.ok(pixel(out,14)[3]!>100&&pixel(out,14)[3]!<155);
    c.matte_cleanup.matte_choke_px=0;c.matte_cleanup.matte_softness_px=1.5;out=await render(c,shape); assert.ok(pixel(out,15)[3]!>0&&pixel(out,15)[3]!<255);
    const soft=pixel(out,15)[3]!;c.matte_cleanup.matte_gamma=2; assert.ok(pixel(await render(c,shape),15)[3]!>soft);
    for(const key of ['#00FF00','#0000FF']){
      c.primary_key.key_color=key;c.matte_cleanup.matte_softness_px=0;c.spill_suppression.strength=.85;
      const rgba=path.join(dir,'spill.rgba'), rgb=key==='#00FF00'?[100,180,60]:[100,60,180], data=Buffer.alloc(64*64*4);
      for(let i=0;i<data.length;i+=4)data.set([...rgb,255],i); await writeFile(rgba,data);
      const actual=pixel(await render(c,rgba),24), expected=bccDespill(rgb.map(v=>v/255),c).map(v=>v*255);
      expected.forEach((v,i)=>assert.ok(Math.abs(actual[i]!-v)<3,`${key} ${actual} / ${expected}`));
    }
    c.primary_key.hue_weight=0;c.primary_key.saturation_weight=0;c.primary_key.luma_weight=0; assert.equal(pixel(await render(c,shape),24)[3],0);
    c.primary_key.hue_weight=1;c.primary_key.saturation_weight=1;c.primary_key.luma_weight=0;c.primary_key.key_color='#00FF00';assert.equal(pixel(await render(c,shape),8)[3],0);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('real BCC light wrap uses the lower video in legacy and multitrack exports', {timeout:60000},async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'acu-bcc-wrap-'));
  try {
    const source=path.join(dir,'blue.mp4'), image=path.join(dir,'key.png');
    await runProcess(ffmpeg,['-v','error','-f','lavfi','-i','color=blue:s=64x64:r=30:d=1','-c:v','libx264',source]);
    await runProcess(ffmpeg,['-v','error','-f','lavfi','-i','color=c=0x00FF00:s=64x64,drawbox=x=16:y=16:w=32:h=32:color=red:t=fill','-frames:v','1',image]);
    const t=newTemplate();Object.assign(t.canvas,{width:64,height:64,fps:30});Object.assign(t.main_clip_layout,{source_aspect_handling:'center_crop',Position:{x:0,y:0,width:64,height:64,scale_mode:'cover'}});
    const c=newBccChroma();c.matte_cleanup.matte_choke_px=0;c.matte_cleanup.matte_softness_px=0;c.light_wrap.intensity=1;c.light_wrap.width_px=3;
    t.overlays=[{id:'k',name:'key',type:'image',source_path:image,z_index:1,position:{x:0,y:0,width:64,height:64},opacity:1,scale:1,timing:{full_duration:true,start_offset_sec:0,end_offset_sec:null,fade_in_sec:0,fade_out_sec:0},background_removal:c}];
    let serial=0;const frame=async(time=.5)=>{const png=path.join(dir,`frame${serial}.png`), raw=path.join(dir,`frame${serial++}.rgb`);await renderPreview(source,t,{inSec:0,outSec:1},time,png);await runProcess(ffmpeg,['-v','error','-i',png,'-pix_fmt','rgb24','-f','rawvideo',raw]);return {data:await readFile(raw),png};};
    const p=(b:Buffer,x:number)=>[...b.subarray((32*64+x)*3,(32*64+x)*3+3)];
    c.light_wrap.enabled=false;const plain=await frame(); c.light_wrap.enabled=true; const wrapped=await frame();
    assert.ok(p(wrapped.data,19)[2]!>p(plain.data,19)[2]!+20,`edge ${p(wrapped.data,19)} vs ${p(plain.data,19)}`);
    assert.ok(p(wrapped.data,32)[0]!>220);assert.ok(p(wrapped.data,5)[2]!>230);
    t.timeline=migrateTimeline(t,{id:'s',name:'s',path:source,url:'',thumbnails:[],media:{width:64,height:64,durationSec:1,hasAudio:false}},{inSec:0,outSec:1});
    const multi=await frame();assert.ok(p(multi.data,19)[2]!>20); assert.ok(p(multi.data,32)[0]!>220);
    t.overlays[0]!.opacity=.5;
    const translucent=await frame();assert.ok(Math.abs(p(translucent.data,32)[0]!-127)<18);assert.ok(Math.abs(p(translucent.data,32)[2]!-127)<18);
    t.overlays[0]!.timing.fade_in_sec=.4;
    const faded=await frame(.1);assert.ok(p(faded.data,32)[0]!<80);assert.ok(p(faded.data,32)[2]!>175);
    const artifacts=path.resolve('out/bcc-qa');await mkdir(artifacts,{recursive:true});await copyFile(wrapped.png,path.join(artifacts,'ffmpeg-light-wrap.png'));
  }finally{await rm(dir,{recursive:true,force:true});}
});

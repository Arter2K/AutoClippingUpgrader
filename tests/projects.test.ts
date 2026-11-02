import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rename, rm } from 'node:fs/promises';
import { projectSchema, type ProjectFile, type EditorBridge, type EditorDocument } from '../src/shared/editor';
import { newTemplate } from '../src/shared/defaults';
import { newTrack, migrateTimeline } from '../src/shared/timeline-migration';
import { bccChromaSchema } from '../src/shared/bcc-chroma';
import { isProjectFile, projectFilename } from '../src/shared/project';
import { mapProjectPaths, relativeProjectPaths, resolveProjectPaths, readProjectFile, writeProjectFile, exportProjectWithMedia } from '../src/main/editor/project-files';
import { EditorRepository } from '../src/main/editor/repository';
import { MediaRegistry } from '../src/main/editor/media-registry';
import { useEditorStore } from '../src/renderer/stores/editor-store';
import { saveCurrentProject, openCurrentProject, newCurrentProject, dropCurrentProject, exportCurrentProject, projectIsDirty } from '../src/renderer/features/projects/project-actions';

const source = { id: 'source', path: 'source.mp4', url: 'acu-media://asset/source', name: 'source', media: { durationSec: 12, width: 320, height: 180, hasAudio: true }, thumbnails: [] };
function fixture(directory: string): ProjectFile {
  const template = newTemplate();
  template.main_clip_layout.background_removal = bccChromaSchema.parse({ mode: 'bcc_chromakey_studio', enabled: true });
  const base = { z_index: 1, timing: { full_duration: true }, position: { x: 0, y: 0, width: 100, height: 100 } };
  const raw = { ...template, overlays: [
    { ...base, id: 'photo', name: 'AI result', type: 'image', source_path: path.join(directory,'processed','same.png'), background_removal: { mode: 'ai_matting', enabled: true, original_source_path: path.join(directory,'original','same.png') } },
    { ...base, id: 'text', name: 'Title', type: 'text', text_content: 'Saved title', style: { font_file: path.join(directory,'font.ttf'), font_size: 32 } },
  ] };
  const project = projectSchema.parse({ format: 'AutoClippingUpgrader', version: 1, name: 'Мой монтаж', template: raw, sourcePath: path.join(directory,'source.mp4'), trim: { inSec: 1, outSec: 5 }, settings: { autoUpload: false, driveFolderId: 'folder', fallback: true } });
  project.template.timeline = migrateTimeline(project.template, { ...source, path: project.sourcePath! }, project.trim);
  const audio = newTrack('audio', project.template.timeline.tracks, 'audio');
  audio.clips.push({ id: 'audio-clip', name: 'Audio', media_type: 'audio', source_path: path.join(directory,'audio.wav'), source_in_sec: 2, source_out_sec: 4, duration_sec: 2, timeline_start_sec: 6, volume: .4, muted: false, has_audio: true, fade_in_sec: .2, fade_out_sec: .5, use_template_main_layout: false });
  project.template.timeline.tracks.push(audio);
  return projectSchema.parse(project);
}
async function createMedia(project: ProjectFile): Promise<void> {
  const refs = new Set<string>(); mapProjectPaths(project, file => { refs.add(file); return file; });
  for (const file of refs) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, `fixture:${path.relative(path.dirname(project.sourcePath!),file)}`); }
}

test('native project extension and safe Windows filenames', () => {
  for (const name of ['demo.acup','demo.ACUP','old.acu.json']) assert.equal(isProjectFile(name),true);
  for (const name of ['x.json','x.prproj','x.acup.exe']) assert.equal(isProjectFile(name),false);
  assert.equal(projectFilename(''), 'Untitled project.acup');
  assert.equal(projectFilename('CON'),'Project CON.acup');
  assert.equal(projectFilename('CON.txt'),'Project CON.txt.acup');
  assert.equal(projectFilename('edit.ACUP'),'edit.acup');
  assert.equal(projectFilename('a/b:*? '),'a_b___.acup');
  assert.equal(projectSchema.safeParse({ ...fixture('.'), trim: { inSec: 5, outSec: 2 } }).success,false);
});

test('project path mapping covers main, timeline, fonts, AI originals without mutating document', () => {
  const p=fixture(path.resolve('fixtures')),original=structuredClone(p),refs:string[]=[];
  mapProjectPaths(p,file=>{refs.push(file);return `mapped/${path.basename(file)}`;});
  assert.deepEqual(p,original);
  assert.ok(refs.some(f=>f.endsWith('font.ttf')) && refs.some(f=>f.endsWith('audio.wav')) && refs.some(f=>f.includes('original')) && refs.some(f=>f.includes('processed')));
  assert.equal(refs.filter(f=>f===p.sourcePath).length,2);
  assert.deepEqual(resolveProjectPaths(relativeProjectPaths(p,path.resolve('fixtures')),path.resolve('fixtures')),p);
});

test('native and legacy manifests roundtrip relative media; invalid files do not overwrite sources', async () => {
  const dir=await mkdtemp(path.join(tmpdir(),'acu-project-'));
  try {
    const p=fixture(dir),file=path.join(dir,'edit.acup');await createMedia(p);await writeProjectFile(file,p);
    const manifest=JSON.parse(await readFile(file,'utf8'));assert.equal(manifest.sourcePath,'source.mp4');assert.equal(manifest.projectPath,undefined);
    assert.deepEqual(await readProjectFile(file),p);
    const legacy=path.join(dir,'old.acu.json');await writeFile(legacy,'\uFEFF'+JSON.stringify(p));assert.deepEqual(await readProjectFile(legacy),p);
    await writeFile(legacy,JSON.stringify({...p,version:99}));await assert.rejects(readProjectFile(legacy),/версия/);
    await writeFile(legacy,'{');await assert.rejects(readProjectFile(legacy),/JSON/);
    await assert.rejects(writeProjectFile(p.sourcePath!,p),/исходный/);assert.match(await readFile(p.sourcePath!,'utf8'),/^fixture/);
    const repo=new EditorRepository(path.join(dir,'repo'),new MediaRegistry());await repo.initialize();await repo.saveDraft(p,file);
    assert.equal((await repo.draft())?.projectPath,file);assert.deepEqual(await repo.readProject(file),p);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('portable export deduplicates media, keeps colliding basenames and relocates every reference', async () => {
  const dir=await mkdtemp(path.join(tmpdir(),'acu-project-'));
  try {
    const p=fixture(path.join(dir,'originals'));await createMedia(p);
    const target=path.join(dir,'export','portable.ACUP'),result=await exportProjectWithMedia(target,p);
    assert.equal(result.mediaCount,5);assert.ok(result.bytes>0);
    const manifest=JSON.parse(await readFile(target,'utf8'));assert.ok(!JSON.stringify(manifest).includes('originals'));
    const files=await readdir(path.join(path.dirname(target),manifest.sourcePath.split('/')[0]));assert.equal(new Set(files).size,5);assert.equal(files.filter(f=>f.endsWith('same.png')).length,2);
    await rename(path.dirname(target),path.join(dir,'relocated'));await rm(path.join(dir,'originals'),{recursive:true,force:true});
    const restored=await readProjectFile(path.join(dir,'relocated','portable.ACUP'));
    const refs=new Set<string>();mapProjectPaths(restored,f=>{refs.add(f);return f;});
    for(const file of refs)assert.match(await readFile(file,'utf8'),/^fixture:/);
    assert.equal(restored.template.timeline?.total_duration_sec,8);assert.equal(restored.template.main_clip_layout.background_removal?.enabled,true);
    assert.deepEqual(restored.settings,p.settings);assert.deepEqual(p,fixture(path.join(dir,'originals')));
    const before=await readFile(path.join(dir,'relocated','portable.ACUP'),'utf8');
    await assert.rejects(exportProjectWithMedia(path.join(dir,'relocated','portable.ACUP'),p),/недоступный/);
    assert.equal(await readFile(path.join(dir,'relocated','portable.ACUP'),'utf8'),before);
    assert.ok(!(await readdir(path.join(dir,'relocated'))).some(n=>n.startsWith('.acup-export-')));
    const blocked=path.join(dir,'relocated','blocked.acup');await mkdir(blocked);
    const beforeFailure=await readdir(path.dirname(blocked));
    await assert.rejects(exportProjectWithMedia(blocked,restored));
    assert.deepEqual(await readdir(path.dirname(blocked)),beforeFailure);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('project actions preserve dirty edits, cancellation, Save As, import isolation and switch decisions', async () => {
  const oldWindow=globalThis.window,initial=useEditorStore.getState();
  let saves=0,opens=0,imports=0,resets=0,exports=0,drafts=0,decision:'save'|'discard'|'cancel'='cancel',cancelSave=false,saveAsFlag=false;
  let finishSave:((file:string)=>void)|undefined;
  const doc:EditorDocument={name:'Opened',template:newTemplate(),source:null,assets:{},warnings:[],trim:{inSec:0,outSec:10},projectPath:'opened.acup'};
  const bridge:Partial<EditorBridge>={
    saveProject:async(_input,saveAs)=>{saves++;saveAsFlag=!!saveAs;return cancelSave?null:finishSave?new Promise(resolve=>{finishSave=resolve;}):saveAs?'copy.acup':'edit.acup';},
    saveDraft:async()=>{drafts++;},confirmProjectSwitch:async()=>decision,
    openProject:async()=>{opens++;return structuredClone(doc);},importProject:async()=>{imports++;return {...structuredClone(doc),projectPath:null};},
    resetProject:async()=>{resets++;},dropProject:async()=>structuredClone(doc),exportProject:async()=>{exports++;return {path:'portable.acup',mediaCount:1,bytes:10};},
  };
  globalThis.window={desktop:{editor:bridge}} as Window & typeof globalThis;
  try {
    useEditorStore.setState({revision:2,savedRevision:1,projectPath:null,projectBusy:false,template:newTemplate(),source:null,name:'Edit',autoUpload:false,driveFolderId:'',fallback:true,savedSettings:JSON.stringify([false,'',true])});
    assert.equal(projectIsDirty(),true);assert.equal(await saveCurrentProject(),true);assert.equal(projectIsDirty(),false);assert.equal(drafts,1);
    cancelSave=true;assert.equal(await saveCurrentProject(true),false);assert.equal(useEditorStore.getState().projectPath,'edit.acup');assert.equal(saveAsFlag,true);
    cancelSave=false;assert.equal(await saveCurrentProject(true),true);assert.equal(useEditorStore.getState().projectPath,'copy.acup');
    finishSave=()=>{};const pending=saveCurrentProject();useEditorStore.setState(s=>({revision:s.revision+1}));finishSave!('edit.acup');await pending;finishSave=undefined;
    assert.equal(projectIsDirty(),true);assert.equal(useEditorStore.getState().projectBusy,false);
    await openCurrentProject();assert.equal(opens,0);assert.equal(useEditorStore.getState().name,'Edit');
    decision='save';finishSave=()=>{};const switching=openCurrentProject();await new Promise(resolve=>setImmediate(resolve));
    useEditorStore.setState(s=>({revision:s.revision+1}));finishSave!('edit.acup');await switching;finishSave=undefined;assert.equal(opens,0);assert.equal(projectIsDirty(),true);
    decision='save';cancelSave=true;await newCurrentProject();assert.equal(resets,0);
    cancelSave=false;decision='discard';await openCurrentProject();assert.equal(opens,1);assert.equal(projectIsDirty(),false);
    await openCurrentProject(true);assert.equal(imports,1);assert.equal(useEditorStore.getState().projectPath,null);
    await exportCurrentProject();assert.equal(exports,1);assert.equal(useEditorStore.getState().projectPath,null);
    await dropCurrentProject({name:'drop.acup'} as File);assert.equal(useEditorStore.getState().projectPath,'opened.acup');
    await newCurrentProject();assert.equal(resets,1);assert.equal(projectIsDirty(),false);assert.equal(useEditorStore.getState().projectPath,null);
    useEditorStore.setState({fallback:false});assert.equal(projectIsDirty(),true);
    assert.ok(saves>=5);
  } finally {useEditorStore.setState(initial,true);globalThis.window=oldWindow;}
});

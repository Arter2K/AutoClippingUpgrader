import { useEditorStore, projectSnapshot } from '../../stores/editor-store';
import { newTemplate } from '../../../shared/defaults';

export function projectIsDirty(state=useEditorStore.getState()): boolean {
  return state.revision!==state.savedRevision || JSON.stringify([state.autoUpload,state.driveFolderId,state.fallback])!==state.savedSettings;
}
export async function saveCurrentProject(saveAs=false): Promise<boolean> {
  const state=useEditorStore.getState();if(state.projectBusy)return false;
  const input=projectSnapshot(),revision=state.revision,settings=JSON.stringify([state.autoUpload,state.driveFolderId,state.fallback]);
  useEditorStore.setState({projectBusy:true});
  try {
    const file=await window.desktop.editor.saveProject(input,saveAs);if(!file)return false;
    useEditorStore.setState({projectPath:file,savedRevision:revision,savedSettings:settings});
    await window.desktop.editor.saveDraft(projectSnapshot());
    useEditorStore.getState().notify('Проект .acup сохранён','info');return true;
  } finally {useEditorStore.setState({projectBusy:false});}
}
async function canSwitchProject():Promise<boolean>{
  const state=useEditorStore.getState();if(state.projectBusy)return false;if(!projectIsDirty(state))return true;
  const choice=await window.desktop.editor.confirmProjectSwitch(state.name);
  return choice==='discard'||choice==='save'&&await saveCurrentProject()&&!projectIsDirty();
}
export async function openCurrentProject(imported=false):Promise<void>{
  if(!await canSwitchProject())return;
  useEditorStore.setState({projectBusy:true});
  try {const document=await (imported?window.desktop.editor.importProject():window.desktop.editor.openProject());if(document)useEditorStore.getState().applyDocument(document);}
  finally{useEditorStore.setState({projectBusy:false});}
}
export async function dropCurrentProject(file:File):Promise<void>{
  if(!await canSwitchProject())return;
  useEditorStore.setState({projectBusy:true});
  try{useEditorStore.getState().applyDocument(await window.desktop.editor.dropProject(file));}finally{useEditorStore.setState({projectBusy:false});}
}
export async function newCurrentProject():Promise<void>{
  if(!await canSwitchProject())return;
  useEditorStore.setState({projectBusy:true});
  try {
    await window.desktop.editor.resetProject();
    useEditorStore.getState().applyDocument({name:'Untitled project',template:newTemplate(),source:null,assets:{},warnings:[],trim:{inSec:0,outSec:10},projectPath:null});
  } finally {useEditorStore.setState({projectBusy:false});}
}
export async function exportCurrentProject():Promise<void>{
  if(useEditorStore.getState().projectBusy)return;
  useEditorStore.setState({projectBusy:true});
  try {const result=await window.desktop.editor.exportProject(projectSnapshot());if(result)useEditorStore.getState().notify(`Экспортирован .acup и папка медиа: ${result.mediaCount} файлов · ${(result.bytes/1024/1024).toFixed(1)} MB`,'info');}
  finally {useEditorStore.setState({projectBusy:false});}
}

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { DesktopBridge } from '../shared/bridge';
import type { ServiceEvent } from '../shared/publishing';
import type { RenderJob } from '../shared/editor';

const bridge: DesktopBridge = {
  selectVideo: () => ipcRenderer.invoke('media:select'),
  editor: {
    bootstrap: () => ipcRenderer.invoke('editor:bootstrap'),
    selectSource: () => ipcRenderer.invoke('editor:source-select'),
    dropSource: file => ipcRenderer.invoke('editor:source-drop', webUtils.getPathForFile(file)),
    demoSource: () => ipcRenderer.invoke('editor:demo'),
    selectAsset: kind => ipcRenderer.invoke('editor:asset-select', kind),
    systemFonts: () => ipcRenderer.invoke('editor:system-fonts'),
    adoptSystemFont: path => ipcRenderer.invoke('editor:system-font-adopt', path),
    saveProcessedImage: (path, bytes) => ipcRenderer.invoke('editor:processed-image', path, bytes),
    hydrate: template => ipcRenderer.invoke('editor:hydrate', template),
    loadTemplate: id => ipcRenderer.invoke('editor:template-load', id),
    saveTemplate: template => ipcRenderer.invoke('editor:template-save', template),
    importTemplate: () => ipcRenderer.invoke('editor:template-import'),
    exportTemplate: template => ipcRenderer.invoke('editor:template-export', template),
    saveProject: (document, saveAs) => ipcRenderer.invoke('editor:project-save', document, saveAs),
    openProject: () => ipcRenderer.invoke('editor:project-open'),
    importProject: () => ipcRenderer.invoke('editor:project-import'),
    exportProject: document => ipcRenderer.invoke('editor:project-export', document),
    dropProject: file => ipcRenderer.invoke('editor:project-drop', webUtils.getPathForFile(file)),
    resetProject: () => ipcRenderer.invoke('editor:project-reset'),
    confirmProjectSwitch: name => ipcRenderer.invoke('editor:project-confirm-switch',name),
    saveDraft: document => ipcRenderer.invoke('editor:draft-save', document),
    confirmClose: () => ipcRenderer.invoke('editor:close-ready'),
    onPrepareClose: callback => {
      const listener = () => callback(); ipcRenderer.on('editor:prepare-close', listener);
      return () => ipcRenderer.removeListener('editor:prepare-close', listener);
    },
    preview: (id, template, trim, time) => ipcRenderer.invoke('editor:preview', id, template, trim, time),
    cancelPreview: () => ipcRenderer.invoke('editor:preview-cancel'),
    startRender: input => ipcRenderer.invoke('editor:render-start', input),
    cancelRender: id => ipcRenderer.invoke('editor:render-cancel', id),
    revealOutput: id => ipcRenderer.invoke('editor:reveal', id),
    jobs: () => ipcRenderer.invoke('editor:jobs'),
    onJob: callback => {
      const listener = (_event: Electron.IpcRendererEvent, value: RenderJob) => callback(value);
      ipcRenderer.on('editor:job', listener); return () => ipcRenderer.removeListener('editor:job', listener);
    },
  },
  publishing: {
    openConfigFolder: () => ipcRenderer.invoke('publishing:config-folder'),
    state: () => ipcRenderer.invoke('publishing:state'),
    connectTikTok: mode => ipcRenderer.invoke('publishing:tiktok-connect', mode),
    completeTikTok: url => ipcRenderer.invoke('publishing:tiktok-complete', url),
    connectGoogle: () => ipcRenderer.invoke('publishing:google-connect'),
    cancelAuth: provider => ipcRenderer.invoke('publishing:auth-cancel', provider),
    disconnect: provider => ipcRenderer.invoke('publishing:disconnect', provider),
    creatorInfo: () => ipcRenderer.invoke('publishing:creator'),
    selectUploadFile: () => ipcRenderer.invoke('publishing:select-file'),
    startTikTok: job => ipcRenderer.invoke('publishing:tiktok-start', job),
    statusTikTok: id => ipcRenderer.invoke('publishing:tiktok-status', id),
    driveFolders: token => ipcRenderer.invoke('publishing:drive-folders', token),
    createDriveFolder: name => ipcRenderer.invoke('publishing:drive-folder-create', name),
    startDrive: (id, folder) => ipcRenderer.invoke('publishing:drive-start', id, folder),
    cancelJob: id => ipcRenderer.invoke('publishing:job-cancel', id),
    onEvent: callback => {
      const listener = (_event: Electron.IpcRendererEvent, value: ServiceEvent) => callback(value);
      ipcRenderer.on('publishing:event', listener);
      return () => ipcRenderer.removeListener('publishing:event', listener);
    },
  },
};
contextBridge.exposeInMainWorld('desktop', bridge);

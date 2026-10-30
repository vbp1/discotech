import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { DiscotechApi, FsEvent, WatchStatus } from '../shared/api'

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: DiscotechApi = {
  listProjects: () => ipcRenderer.invoke('projects:list'),
  addProject: () => ipcRenderer.invoke('projects:add'),
  removeProject: (id) => ipcRenderer.invoke('projects:remove', id),
  listDir: (project, projectPath) => ipcRenderer.invoke('fs:list', project, projectPath),
  readFile: (project, projectPath) => ipcRenderer.invoke('fs:read', project, projectPath),
  writeFile: (project, projectPath, text, expectedMtimeMs) =>
    ipcRenderer.invoke('fs:write', project, projectPath, text, expectedMtimeMs),
  createFile: (project, projectPath, text) => ipcRenderer.invoke('fs:create', project, projectPath, text),
  closeWindowDiscarding: () => ipcRenderer.invoke('window:close-discarding'),
  transferPath: (project, from, toDir, mode, overwrite) =>
    ipcRenderer.invoke('fs:transfer', project, from, toDir, mode, overwrite),
  getSession: () => ipcRenderer.invoke('session:get'),
  setSession: (state) => ipcRenderer.invoke('session:set', state),
  deletePath: (project, projectPath) => ipcRenderer.invoke('fs:delete', project, projectPath),
  watchProject: (project) => ipcRenderer.invoke('fs:watch', project),
  searchNames: (project, query) => ipcRenderer.invoke('search:names', project, query),
  searchContent: (project, query) => ipcRenderer.invoke('search:content', project, query),
  setPreviewDraft: (distro, projectPath, text) => ipcRenderer.invoke('preview:draft', distro, projectPath, text),
  getUsage: (distro) => ipcRenderer.invoke('usage:get', distro),
  onFsEvent: (listener) => subscribe<FsEvent>('fs:event', listener),
  onWatchStatus: (listener) => subscribe<WatchStatus>('fs:watch-status', listener)
}

contextBridge.exposeInMainWorld('discotech', api)

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron'
import path from 'node:path'
import type { Project, SessionState, TransferMode } from '../shared/api'
import { loadSession, saveSession } from './session'
import { deletePath, listDir, readFileContent, transferPath, writeFileContent } from './files'
import { handlePreviewScheme, PREVIEW_SCHEME, registerPreviewScheme, setPreviewDraft } from './preview'
import { addProject, listProjects, removeProject } from './projects'
import { searchContent, searchNames } from './search'
import { getUsage } from './usage'
import { stopWatching, watchProject } from './watcher'
import { parseUnc } from './wsl'

const DEFAULT_PICK_PATH = '\\\\wsl.localhost\\'

let mainWindow: BrowserWindow | null = null

registerPreviewScheme()

// Whole-interface scale, the same as Orca's default UI zoom (zoom level 1.5 = 1.2^1.5).
const UI_ZOOM = 1.2 ** 1.5

// The renderer draws the title bar (36 CSS px); Windows keeps its own min/max/close buttons on top of it.
const TITLE_BAR_HEIGHT = Math.round(36 * UI_ZOOM)

function titleBarOverlay(): { color: string; symbolColor: string; height: number } {
  return nativeTheme.shouldUseDarkColors
    ? { color: '#171717', symbolColor: '#fafafa', height: TITLE_BAR_HEIGHT }
    : { color: '#fafafa', symbolColor: '#0a0a0a', height: TITLE_BAR_HEIGHT }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'discotech',
    icon: path.join(__dirname, '../../resources/icon.ico'),
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlay(),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0a0a0a' : '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      zoomFactor: UI_ZOOM
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
  // F12 opens DevTools; the application menu is removed (see app.whenReady).
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      event.preventDefault()
      mainWindow?.webContents.toggleDevTools()
    }
  })
  // Previewed pages stay in their frame; web links open in the browser.
  const openOutside = (url: string): void => {
    if (/^https?:|^mailto:/i.test(url)) void shell.openExternal(url)
  }
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame || event.url.startsWith(`${PREVIEW_SCHEME}:`) || event.url.startsWith('about:')) return
    event.preventDefault()
    openOutside(event.url)
  })
  // The renderer cancels unload while edits are unsaved; ask the user here.
  mainWindow.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(mainWindow!, {
      type: 'warning',
      buttons: ['Закрыть без сохранения', 'Остаться'],
      title: 'discotech',
      message: 'Есть несохранённые правки.',
      detail: 'Если закрыть окно, они пропадут.',
      defaultId: 1,
      cancelId: 1
    })
    if (choice === 0) event.preventDefault()
  })
  mainWindow.on('closed', () => {
    mainWindow = null
    stopWatching()
  })
}

function registerIpc(): void {
  ipcMain.handle('projects:list', () => listProjects())
  ipcMain.handle('projects:add', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Add project folder',
      defaultPath: DEFAULT_PICK_PATH,
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const { distro, linuxPath } = parseUnc(result.filePaths[0])
    return addProject(distro, linuxPath)
  })
  ipcMain.handle('projects:remove', (_e, id: string) => removeProject(id))
  ipcMain.handle('fs:list', (_e, project: Project, linuxPath: string) => listDir(project, linuxPath))
  ipcMain.handle('fs:read', (_e, project: Project, linuxPath: string) => readFileContent(project, linuxPath))
  ipcMain.handle('fs:write', (_e, project: Project, linuxPath: string, text: string, expectedMtimeMs: number | null) =>
    writeFileContent(project, linuxPath, text, expectedMtimeMs)
  )
  ipcMain.handle('fs:transfer', (_e, project: Project, from: string, toDir: string, mode: TransferMode, overwrite: boolean) =>
    transferPath(project, from, toDir, mode, overwrite)
  )
  ipcMain.handle('session:get', () => loadSession())
  ipcMain.handle('session:set', (_e, state: SessionState) => saveSession(state))
  ipcMain.handle('fs:delete', (_e, project: Project, linuxPath: string) => deletePath(project, linuxPath))
  ipcMain.handle('fs:watch', (_e, project: Project) => {
    watchProject(project, {
      onEvent: (event) => mainWindow?.webContents.send('fs:event', event),
      onStatus: (status) => mainWindow?.webContents.send('fs:watch-status', status)
    })
  })
  ipcMain.handle('preview:draft', (_e, distro: string, linuxPath: string, text: string | null) =>
    setPreviewDraft(distro, linuxPath, text)
  )
  ipcMain.handle('usage:get', (_e, distro: string) => getUsage(distro))
  ipcMain.handle('search:names', (_e, project: Project, query: string) => searchNames(project, query))
  ipcMain.handle('search:content', (_e, project: Project, query: string) => searchContent(project, query))
}

// A second copy could not open the first one's stored layout and tabs; it hands over to the first.
if (!app.requestSingleInstanceLock()) app.quit()

app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
})

app.whenReady().then(() => {
  if (!app.hasSingleInstanceLock()) return
  // The default menu binds Ctrl+=/-/0 to whole-page zoom.
  Menu.setApplicationMenu(null)
  nativeTheme.on('updated', () => mainWindow?.setTitleBarOverlay(titleBarOverlay()))
  handlePreviewScheme()
  registerIpc()
  createWindow()
})

app.on('window-all-closed', () => {
  app.quit()
})

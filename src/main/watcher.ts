import { watch, type FSWatcher } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { FsEvent, FsEventType, Project, WatchStatus } from '../shared/api'
import { osPath, spawnInWsl } from './wsl'

// \\wsl.localhost paths cannot be watched from Windows (fs.watch fails with EISDIR), so distro
// folders are watched inside the distro and report inotify events. Windows-folder projects are
// watched natively on their drive path.
const EXCLUDE = '(^|/)(\\.git|node_modules)(/|$)'
const EXCLUDED_SEGMENTS = new Set(['.git', 'node_modules'])

const EVENT_TYPES: Record<string, FsEventType> = {
  CREATE: 'create',
  DELETE: 'delete',
  CLOSE_WRITE: 'modify',
  MOVED_FROM: 'move',
  MOVED_TO: 'move'
}

type Listeners = {
  onEvent(event: FsEvent): void
  onStatus(status: WatchStatus): void
}

let current: { projectId: string; stop(): void } | null = null

export function watchProject(project: Project, listeners: Listeners): void {
  stopWatching()
  if (project.distro === null) watchWindowsFolder(project, listeners)
  else watchInotify(project, project.distro, listeners)
}

function watchInotify(project: Project, distro: string, listeners: Listeners): void {
  const child = spawnInWsl(distro, [
    'inotifywait',
    '-m',
    '-r',
    '-q',
    '-e',
    'create,delete,close_write,moved_from,moved_to',
    '--exclude',
    EXCLUDE,
    '--format',
    '%e|%w%f',
    project.rootPath
  ])
  const stop = (): void => {
    child.kill()
  }
  current = { projectId: project.id, stop }
  let stdoutTail = ''
  let stderr = ''

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    const lines = (stdoutTail + chunk).split('\n')
    stdoutTail = lines.pop() ?? ''
    for (const line of lines) {
      const separator = line.indexOf('|')
      if (separator < 0) continue
      const flags = line.slice(0, separator).split(',')
      const type = flags.map((f) => EVENT_TYPES[f]).find(Boolean)
      if (!type) continue
      listeners.onEvent({
        projectId: project.id,
        type,
        path: line.slice(separator + 1),
        isDir: flags.includes('ISDIR')
      })
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })
  child.on('error', (error) => {
    listeners.onStatus({ projectId: project.id, state: 'failed', message: `wsl.exe failed to start: ${error.message}` })
  })
  child.on('exit', (code, signal) => {
    if (current?.stop !== stop) return
    current = null
    listeners.onStatus({
      projectId: project.id,
      state: 'failed',
      message:
        `File watcher stopped (exit code ${code ?? 'none'}, signal ${signal ?? 'none'}). ` +
        (stderr.trim() || 'No error output. Is inotify-tools installed in the distro?')
    })
  })
  listeners.onStatus({ projectId: project.id, state: 'running' })
}

function watchWindowsFolder(project: Project, listeners: Listeners): void {
  const windowsPath = osPath(project, project.rootPath)
  let watcher: FSWatcher
  try {
    watcher = watch(windowsPath, { recursive: true }, (event, filename) => report(event, filename))
  } catch (error) {
    listeners.onStatus({ projectId: project.id, state: 'failed', message: `Watching "${windowsPath}" failed: ${(error as Error).message}` })
    return
  }
  const stop = (): void => {
    watcher.close()
  }
  current = { projectId: project.id, stop }
  watcher.on('error', (error: Error) => {
    if (current?.stop !== stop) return
    current = null
    stop()
    listeners.onStatus({ projectId: project.id, state: 'failed', message: `Watching "${windowsPath}" stopped: ${error.message}` })
  })
  listeners.onStatus({ projectId: project.id, state: 'running' })

  // Windows reports "rename" for names that appear and vanish alike; the disk tells which.
  function report(event: string, filename: string | null): void {
    if (filename === null) return
    const relative = filename.split(/[\\/]/).filter(Boolean)
    if (relative.some((part) => EXCLUDED_SEGMENTS.has(part))) return
    const prefix = project.rootPath.endsWith('/') ? project.rootPath : project.rootPath + '/'
    const projectPath = prefix + relative.join('/')
    if (event !== 'rename') {
      listeners.onEvent({ projectId: project.id, type: 'modify', path: projectPath, isDir: false })
      return
    }
    stat(`${windowsPath}\\${filename}`).then(
      (info) => listeners.onEvent({ projectId: project.id, type: 'create', path: projectPath, isDir: info.isDirectory() }),
      () => listeners.onEvent({ projectId: project.id, type: 'delete', path: projectPath, isDir: false })
    )
  }
}

export function stopWatching(): void {
  if (!current) return
  const { stop } = current
  current = null
  stop()
}

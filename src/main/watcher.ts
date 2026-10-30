import { watch, type FSWatcher } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { FsEvent, FsEventType, Project, WatchStatus } from '../shared/api'
import { osPath, runInWsl, spawnInWsl } from './wsl'

// \\wsl.localhost paths cannot be watched from Windows (fs.watch fails with EISDIR), so distro
// folders are watched inside the distro and report inotify events. Windows-folder projects are
// watched natively on their drive path.
const EXCLUDE = '(^|/)(\\.git|node_modules)(/|$)'
const EXCLUDED_SEGMENTS = new Set(['.git', 'node_modules'])
const INOTIFY_ARGS = ['-e', 'create,delete,close_write,moved_from,moved_to', '--format', '%e|%w%f']

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

// --exclude filters inotify events but still puts a watch on every excluded directory, so one
// recursive watcher over the whole project would watch every node_modules copy in it. The project
// root is therefore watched non-recursively (that covers all top-level entries, hidden included)
// and each visible top-level directory recursively; hidden directories and node_modules below the
// top level stay unwatched. Top-level directories created later get a watcher of their own.
function watchInotify(project: Project, distro: string, listeners: Listeners): void {
  const root = project.rootPath
  const children = new Set<ChildProcessWithoutNullStreams>()
  const retired = new Set<ChildProcessWithoutNullStreams>()
  const topLevel = new Map<string, ChildProcessWithoutNullStreams>()
  let stopped = false
  let stderr = ''

  const stop = (): void => {
    stopped = true
    for (const child of children) child.kill()
    children.clear()
    retired.clear()
    topLevel.clear()
  }
  current = { projectId: project.id, stop }

  const fail = (message: string): void => {
    if (stopped) return
    stop()
    if (current?.stop === stop) current = null
    listeners.onStatus({ projectId: project.id, state: 'failed', message })
  }

  const report = (child: ChildProcessWithoutNullStreams): void => {
    children.add(child)
    let stdoutTail = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      const lines = (stdoutTail + chunk).split('\n')
      stdoutTail = lines.pop() ?? ''
      for (const line of lines) reportLine(line)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => (stderr += chunk))
    child.on('error', (error: Error) => fail(`wsl.exe failed to start: ${error.message}`))
    child.on('exit', (code, signal) => {
      const planned = retired.has(child)
      children.delete(child)
      retired.delete(child)
      if (stopped || planned) return
      fail(
        `File watcher stopped (exit code ${code ?? 'none'}, signal ${signal ?? 'none'}). ` +
          (stderr.trim() || 'No error output. Is inotify-tools installed in the distro?')
      )
    })
  }

  const spawnRecursive = (dir: string): void => {
    const child = spawnInWsl(distro, ['inotifywait', '-m', '-r', '-q', ...INOTIFY_ARGS, '--exclude', EXCLUDE, dir])
    topLevel.set(dir, child)
    report(child)
  }

  function reportLine(line: string): void {
    const separator = line.indexOf('|')
    if (separator < 0) return
    const flags = line.slice(0, separator).split(',')
    const type = flags.map((f) => EVENT_TYPES[f]).find(Boolean)
    const path = line.slice(separator + 1)
    if (flags.includes('ISDIR') && parentDir(path) === root) {
      const child = topLevel.get(path)
      if (child && (flags.includes('DELETE') || flags.includes('MOVED_FROM'))) {
        topLevel.delete(path)
        retired.add(child)
        children.delete(child)
        child.kill()
      } else if (!child && (flags.includes('CREATE') || flags.includes('MOVED_TO')) && isWatchedTopLevel(path.slice(path.lastIndexOf('/') + 1))) {
        spawnRecursive(path)
      }
    }
    if (!type) return
    listeners.onEvent({ projectId: project.id, type, path, isDir: flags.includes('ISDIR') })
  }

  report(spawnInWsl(distro, ['inotifywait', '-m', '-q', ...INOTIFY_ARGS, root]))
  listeners.onStatus({ projectId: project.id, state: 'running' })

  void listTopLevelDirs(distro, root).then(
    (dirs) => {
      if (stopped) return
      // A directory created while the listing ran got a watcher of its own and is also in the list.
      for (const [dir, child] of topLevel) {
        if (!dirs.includes(dir)) continue
        topLevel.delete(dir)
        retired.add(child)
        children.delete(child)
        child.kill()
      }
      if (dirs.length === 0) return
      report(spawnInWsl(distro, ['inotifywait', '-m', '-r', '-q', ...INOTIFY_ARGS, '--exclude', EXCLUDE, ...dirs]))
    },
    (error: Error) => fail(`Listing top-level folders of "${root}" failed: ${error.message}`)
  )
}

/** The top-level directories that get recursive watchers: visible ones except node_modules. */
async function listTopLevelDirs(distro: string, root: string): Promise<string[]> {
  const { code, stdout, stderr } = await runInWsl(distro, [
    'find',
    root,
    '-mindepth',
    '1',
    '-maxdepth',
    '1',
    '-type',
    'd',
    '!',
    '-name',
    '.*',
    '!',
    '-name',
    'node_modules'
  ])
  if (code !== 0) throw new Error(`find exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`)
  return stdout.split('\n').filter(Boolean)
}

function parentDir(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash <= 0 ? '/' : path.slice(0, slash)
}

function isWatchedTopLevel(name: string): boolean {
  return !name.startsWith('.') && !EXCLUDED_SEGMENTS.has(name)
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

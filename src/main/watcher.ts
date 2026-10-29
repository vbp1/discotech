import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { FsEvent, FsEventType, Project, WatchStatus } from '../shared/api'
import { spawnInWsl } from './wsl'

// Windows cannot watch \\wsl.localhost paths (fs.watch fails with EISDIR),
// so the watcher runs inside the distro and reports inotify events.
const EXCLUDE = '(^|/)(\\.git|node_modules)(/|$)'

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

let current: { projectId: string; child: ChildProcessWithoutNullStreams } | null = null

export function watchProject(project: Project, listeners: Listeners): void {
  stopWatching()
  const child = spawnInWsl(project.distro, [
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
    project.linuxPath
  ])
  current = { projectId: project.id, child }
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
    if (current?.child !== child) return
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

export function stopWatching(): void {
  if (!current) return
  const { child } = current
  current = null
  child.kill()
}

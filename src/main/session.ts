import { app } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { SessionState } from '../shared/api'

// What was open when the app last ran: the shown project and each project's tabs. Written on
// every change, so a reboot or a killed process loses nothing.

function sessionPath(): string {
  return path.join(app.getPath('userData'), 'session.json')
}

function isTabList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((t) => typeof t === 'object' && t !== null && typeof t.path === 'string' && typeof t.pinned === 'boolean' && (t.orphanText === undefined || typeof t.orphanText === 'string'))
  )
}

export async function loadSession(): Promise<SessionState> {
  let raw: string
  try {
    raw = await readFile(sessionPath(), 'utf8')
  } catch (error) {
    // A first launch has no session yet.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { activeProjectId: null, projects: {} }
    throw error
  }
  const parsed = JSON.parse(raw) as Partial<SessionState>
  const projects = parsed.projects
  const valid =
    (parsed.activeProjectId === null || typeof parsed.activeProjectId === 'string') &&
    typeof projects === 'object' &&
    projects !== null &&
    Object.values(projects).every(
      (p) => typeof p === 'object' && p !== null && isTabList(p.tabs) && (p.active === null || typeof p.active === 'string')
    )
  if (!valid) throw new Error(`Session file ${sessionPath()} has an unexpected shape. Delete it to start with no open tabs.`)
  return parsed as SessionState
}

// Writes go one after another; each replaces the file whole, so a crash leaves the old or the new one.
let writing: Promise<void> = Promise.resolve()

export function saveSession(state: SessionState): Promise<void> {
  const file = sessionPath()
  const next = writing.then(async () => {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file + '.tmp', JSON.stringify(state, null, 2), 'utf8')
    await rename(file + '.tmp', file)
  })
  writing = next.catch(() => {})
  return next
}

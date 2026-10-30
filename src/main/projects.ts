import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { Project } from '../shared/api'
import { fromWslMount } from './wsl'

type Settings = { projects: Project[]; searchSkipDirs?: string[] }

type StoredProject = { id: string; name: string; distro: string | null; rootPath: string }

/** Reads one stored project; accepts the previous field name linuxPath and /mnt mapping. */
function parseProject(value: unknown, index: number): Project {
  const where = `Settings file ${settingsPath()}: projects[${index}]`
  if (typeof value !== 'object' || value === null) throw new Error(`${where} is not an object. Fix or delete the file.`)
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || typeof record.name !== 'string') {
    throw new Error(`${where} needs string "id" and "name". Fix or delete the file.`)
  }
  const distro = record.distro ?? null
  if (distro !== null && typeof distro !== 'string') {
    throw new Error(`${where}: "distro" must be a distro name or null.`)
  }
  const root = record.rootPath ?? record.linuxPath
  if (typeof root !== 'string' || root === '') {
    throw new Error(`${where} needs a string "rootPath". Fix or delete the file.`)
  }
  // Folders once mapped into a distro's /mnt are Windows folders the app opens natively.
  if (distro !== null && /^\/mnt\/[a-zA-Z]\//.test(root)) {
    return { id: record.id, name: record.name, distro: null, rootPath: fromWslMount(root) }
  }
  return { id: record.id, name: record.name, distro, rootPath: root }
}

/**
 * Folders search never enters: git data, dependencies, working copies, build caches, and the
 * download caches of language toolchains. Entries are ripgrep globs; a bare name matches at any depth.
 */
export const DEFAULT_SEARCH_SKIP_DIRS = [
  '.git',
  'node_modules',
  '.worktrees',
  '.precommit-review',
  '.codex-review',
  '.claude-review',
  '.turbo',
  '.next',
  '.ruff_cache',
  '.jscpd-report',
  '.cache',
  '.rustup',
  '.cargo',
  '**/go/pkg/mod',
  '**/.local/share/pnpm',
  '**/.local/share/uv',
  '**/.local/lib',
  '**/.bun/install'
]

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

async function loadSettings(): Promise<Settings> {
  let raw: string
  try {
    raw = await readFile(settingsPath(), 'utf8')
  } catch (error) {
    // A first launch has no settings file yet.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { projects: [] }
    throw error
  }
  const parsed = JSON.parse(raw) as { projects?: unknown[]; searchSkipDirs?: unknown }
  if (!Array.isArray(parsed.projects)) {
    throw new Error(`Settings file ${settingsPath()} has no "projects" array. Fix or delete the file.`)
  }
  const projects = parsed.projects.map(parseProject)
  const skip = parsed.searchSkipDirs
  if (skip !== undefined && (!Array.isArray(skip) || skip.some((d) => typeof d !== 'string' || d.trim() === ''))) {
    throw new Error(
      `Settings file ${settingsPath()}: "searchSkipDirs" must be a list of folder names, got ${JSON.stringify(skip)}. Fix or remove the field.`
    )
  }
  return { projects, ...(skip ? { searchSkipDirs: skip } : {}) }
}

export async function searchSkipDirs(): Promise<string[]> {
  return (await loadSettings()).searchSkipDirs ?? DEFAULT_SEARCH_SKIP_DIRS
}

async function saveSettings(settings: Settings): Promise<void> {
  await mkdir(path.dirname(settingsPath()), { recursive: true })
  const stored: Settings & { projects: StoredProject[] } = { ...settings, projects: settings.projects }
  await writeFile(settingsPath(), JSON.stringify(stored, null, 2), 'utf8')
}

export async function listProjects(): Promise<Project[]> {
  return (await loadSettings()).projects
}

export async function addProject(distro: string | null, rootPath: string): Promise<Project> {
  const settings = await loadSettings()
  const existing = settings.projects.find((p) => p.distro === distro && p.rootPath === rootPath)
  if (existing) return existing
  const project: Project = {
    id: randomUUID(),
    name: path.posix.basename(rootPath) || rootPath,
    distro,
    rootPath
  }
  settings.projects.push(project)
  await saveSettings(settings)
  return project
}

export async function removeProject(id: string): Promise<void> {
  const settings = await loadSettings()
  settings.projects = settings.projects.filter((p) => p.id !== id)
  await saveSettings(settings)
}

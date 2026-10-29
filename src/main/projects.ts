import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { Project } from '../shared/api'

type Settings = { projects: Project[]; searchSkipDirs?: string[] }

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
  const parsed = JSON.parse(raw) as Partial<Settings>
  if (!Array.isArray(parsed.projects)) {
    throw new Error(`Settings file ${settingsPath()} has no "projects" array. Fix or delete the file.`)
  }
  const skip = parsed.searchSkipDirs
  if (skip !== undefined && (!Array.isArray(skip) || skip.some((d) => typeof d !== 'string' || d.trim() === ''))) {
    throw new Error(
      `Settings file ${settingsPath()}: "searchSkipDirs" must be a list of folder names, got ${JSON.stringify(skip)}. Fix or remove the field.`
    )
  }
  return { projects: parsed.projects, ...(skip ? { searchSkipDirs: skip } : {}) }
}

export async function searchSkipDirs(): Promise<string[]> {
  return (await loadSettings()).searchSkipDirs ?? DEFAULT_SEARCH_SKIP_DIRS
}

async function saveSettings(settings: Settings): Promise<void> {
  await mkdir(path.dirname(settingsPath()), { recursive: true })
  await writeFile(settingsPath(), JSON.stringify(settings, null, 2), 'utf8')
}

export async function listProjects(): Promise<Project[]> {
  return (await loadSettings()).projects
}

export async function addProject(distro: string, linuxPath: string): Promise<Project> {
  const settings = await loadSettings()
  const existing = settings.projects.find((p) => p.distro === distro && p.linuxPath === linuxPath)
  if (existing) return existing
  const project: Project = {
    id: randomUUID(),
    name: path.posix.basename(linuxPath) || linuxPath,
    distro,
    linuxPath
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

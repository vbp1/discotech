import { copyFile, cp, lstat, mkdir, open, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import type { DirEntry, FileContent, Project, TransferMode, TransferResult, WriteResult } from '../shared/api'
import { assertInsideProject, osPath, runInWsl } from './wsl'

const MAX_TEXT_BYTES = 5 * 1024 * 1024
const BINARY_SNIFF_BYTES = 8192
const HIDDEN_NAMES = new Set(['.git'])

// Windows cannot follow Linux symlinks over \\wsl.localhost: lstat/readlink fail with
// EISDIR and open/stat with ENOENT. Links of WSL projects are resolved inside the distro;
// on native drive paths (Windows-folder projects) links work as they are.
const LINK_FAILURE_CODES = new Set(['ENOENT', 'EISDIR'])

function isLinkFailure(error: unknown): error is NodeJS.ErrnoException {
  return LINK_FAILURE_CODES.has((error as NodeJS.ErrnoException).code ?? '')
}

const isWindowsProject = (project: Project): boolean => project.distro === null

/**
 * Resolves symlinks in projectPath. Rethrows the original error when the path has no links to
 * resolve, so a genuinely missing file still reports ENOENT.
 */
async function resolveRealPath(project: Project, projectPath: string, original: Error): Promise<string> {
  if (isWindowsProject(project)) {
    let real: string
    try {
      real = await realpath(osPath(project, projectPath))
    } catch (error) {
      throw new Error(`${original.message}; resolving it failed: ${(error as Error).message}`)
    }
    const realPath = real.replaceAll('\\', '/')
    if (realPath.toLowerCase() === projectPath.toLowerCase()) throw original
    return realPath
  }
  const result = await runInWsl(project.distro!, ['realpath', '-e', '--', projectPath])
  if (result.code !== 0) {
    throw new Error(`${original.message}; resolving it inside WSL failed: ${result.stderr.trim() || `exit code ${result.code}`}`)
  }
  const realPath = result.stdout.replace(/\n$/, '')
  if (realPath === projectPath) throw original
  return realPath
}

/** Asks what each symlink points to; a link missing from the answer cannot be followed. */
async function followLinks(project: Project, linkPaths: string[]): Promise<Map<string, { isDir: boolean } | { error: string }>> {
  const out = new Map<string, { isDir: boolean } | { error: string }>()
  if (linkPaths.length === 0) return out
  if (isWindowsProject(project)) {
    for (const linkPath of linkPaths) {
      try {
        out.set(linkPath, { isDir: (await stat(osPath(project, linkPath))).isDirectory() })
      } catch (error) {
        out.set(linkPath, { error: (error as Error).message })
      }
    }
    return out
  }
  const result = await runInWsl(project.distro!, ['stat', '-L', '--printf', '%F\t%n\n', '--', ...linkPaths])
  for (const line of result.stdout.split('\n')) {
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    out.set(line.slice(tab + 1), { isDir: line.slice(0, tab) === 'directory' })
  }
  const stderrLines = result.stderr.split('\n').filter(Boolean)
  for (const linkPath of linkPaths) {
    if (out.has(linkPath)) continue
    const reason = stderrLines.find((l) => l.includes(linkPath)) ?? result.stderr.trim()
    out.set(linkPath, { error: reason || `stat exited with code ${result.code}` })
  }
  return out
}

async function readDirents(project: Project, projectPath: string): Promise<Dirent[]> {
  try {
    return await readdir(osPath(project, projectPath), { withFileTypes: true })
  } catch (error) {
    if (isWindowsProject(project) || !isLinkFailure(error)) throw error
    const realPath = await resolveRealPath(project, projectPath, error)
    return readdir(osPath(project, realPath), { withFileTypes: true })
  }
}

export async function listDir(project: Project, projectPath: string): Promise<DirEntry[]> {
  assertInsideProject(project, projectPath)
  const dirents = (await readDirents(project, projectPath)).filter((d) => !HIDDEN_NAMES.has(d.name))
  const links = await followLinks(
    project,
    dirents.filter((d) => d.isSymbolicLink()).map((d) => path.posix.join(projectPath, d.name))
  )
  const entries = dirents.map((d): DirEntry => {
    const entryPath = path.posix.join(projectPath, d.name)
    const link = links.get(entryPath)
    if (!link) return { name: d.name, path: entryPath, isDir: d.isDirectory(), isSymlink: false, linkError: null }
    if ('error' in link) return { name: d.name, path: entryPath, isDir: false, isSymlink: true, linkError: link.error }
    return { name: d.name, path: entryPath, isDir: link.isDir, isSymlink: true, linkError: null }
  })
  return entries.sort(
    (a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  )
}

async function readFileAt(osFilePath: string, realPath: string | null): Promise<FileContent> {
  const handle = await open(osFilePath, 'r')
  try {
    const info = await handle.stat()
    if (info.size > MAX_TEXT_BYTES) return { kind: 'too-large', size: info.size, limit: MAX_TEXT_BYTES, realPath }
    const buffer = await handle.readFile()
    if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { kind: 'binary', size: info.size, realPath }
    return { kind: 'text', text: buffer.toString('utf8'), size: info.size, mtimeMs: info.mtimeMs, realPath }
  } finally {
    await handle.close()
  }
}

export async function readFileContent(project: Project, projectPath: string): Promise<FileContent> {
  assertInsideProject(project, projectPath)
  try {
    return await readFileAt(osPath(project, projectPath), null)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !(await pathExists(project, projectPath))) {
      return { kind: 'missing', realPath: null }
    }
    if (isWindowsProject(project) || !isLinkFailure(error)) throw error
    // Link targets may lie outside the project: the link itself is inside it.
    const realPath = await resolveRealPath(project, projectPath, error)
    return readFileAt(osPath(project, realPath), realPath)
  }
}

/**
 * The project path the app's Windows process can open: the path itself, or its target when it
 * goes through a symlink.
 */
export async function openablePath(project: Project, projectPath: string): Promise<string> {
  try {
    await stat(osPath(project, projectPath))
    return projectPath
  } catch (error) {
    if (isWindowsProject(project) || !isLinkFailure(error)) throw error
    return resolveRealPath(project, projectPath, error)
  }
}

export async function writeFileContent(
  project: Project,
  projectPath: string,
  text: string,
  expectedMtimeMs: number | null
): Promise<WriteResult> {
  assertInsideProject(project, projectPath)
  const target = osPath(project, await openablePath(project, projectPath))
  if (expectedMtimeMs !== null) {
    const diskMtimeMs = (await stat(target)).mtimeMs
    if (diskMtimeMs !== expectedMtimeMs) return { status: 'conflict', diskMtimeMs }
  }
  // In-place write keeps the file's inode, owner and permissions.
  await writeFile(target, text, 'utf8')
  return { status: 'saved', mtimeMs: (await stat(target)).mtimeMs }
}

export async function createFileContent(project: Project, projectPath: string, text: string): Promise<WriteResult> {
  assertInsideProject(project, projectPath)
  const target = osPath(project, projectPath)
  await mkdir(path.win32.dirname(target), { recursive: true })
  try {
    await writeFile(target, text, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    return { status: 'conflict', diskMtimeMs: (await stat(target)).mtimeMs }
  }
  return { status: 'saved', mtimeMs: (await stat(target)).mtimeMs }
}

async function pathExists(project: Project, projectPath: string): Promise<boolean> {
  if (isWindowsProject(project)) {
    // lstat also sees a broken symlink, like `find` inside the distro.
    try {
      await lstat(osPath(project, projectPath))
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }
  const result = await runInWsl(project.distro!, ['find', projectPath, '-maxdepth', '0'])
  if (result.code === 0) return true
  if (/No such file or directory/.test(result.stderr)) return false
  throw new Error(`Cannot check "${projectPath}": ${result.stderr.trim() || `find exited with code ${result.code}`}`)
}

async function isDirectory(project: Project, projectPath: string): Promise<boolean> {
  if (isWindowsProject(project)) {
    try {
      return (await stat(osPath(project, projectPath))).isDirectory()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }
  const result = await runInWsl(project.distro!, ['test', '-d', projectPath])
  return result.code === 0
}

async function runChecked(project: Project, command: string[]): Promise<void> {
  const result = await runInWsl(project.distro!, command)
  if (result.code !== 0) {
    throw new Error(`${command[0]} failed: ${result.stderr.trim() || `exit code ${result.code}`}`)
  }
}

/** "name copy.ext", "name copy 2.ext", ... : the first name not taken in dir. */
async function freeCopyName(project: Project, dir: string, name: string, isDir: boolean): Promise<string> {
  const dot = isDir ? -1 : name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let n = 1; ; n++) {
    const candidate = path.posix.join(dir, `${stem} copy${n === 1 ? '' : ` ${n}`}${ext}`)
    if (!(await pathExists(project, candidate))) return candidate
  }
}

/**
 * Moves or copies a file or folder into toDir of the same project. A taken name is reported
 * without touching anything unless overwrite is set: then a file replaces the file and a folder
 * merges into the folder, its files replacing same-named ones. WSL projects move and copy inside
 * the distro: Windows cannot handle Linux symlinks over the network path; Windows-folder
 * projects use the native file system.
 */
export async function transferPath(
  project: Project,
  from: string,
  toDir: string,
  mode: TransferMode,
  overwrite: boolean
): Promise<TransferResult> {
  assertInsideProject(project, from)
  assertInsideProject(project, toDir)
  const name = path.posix.basename(from)
  if (from === project.rootPath) throw new Error('The project folder itself cannot be moved or copied.')
  if (toDir === from || toDir.startsWith(from + '/')) throw new Error(`Cannot put "${name}" inside itself.`)
  if (!(await pathExists(project, from))) throw new Error(`"${from}" does not exist.`)
  const sourceIsDir = await isDirectory(project, from)
  let to = path.posix.join(toDir, name)
  if (to === from) {
    if (mode === 'move') throw new Error(`"${name}" is already in ${toDir}.`)
    to = await freeCopyName(project, toDir, name, sourceIsDir)
  }
  const taken = await pathExists(project, to)
  if (taken) {
    const targetIsDir = await isDirectory(project, to)
    if (targetIsDir !== sourceIsDir) {
      throw new Error(
        `${to} is a ${targetIsDir ? 'folder' : 'file'} and "${name}" is a ${sourceIsDir ? 'folder' : 'file'}: one cannot replace the other. Nothing was changed.`
      )
    }
    if (!overwrite) return { status: 'exists', to, isDir: targetIsDir }
  }
  const target = osPath(project, to)
  const source = osPath(project, from)
  if (!taken) {
    if (isWindowsProject(project)) {
      if (mode === 'move') {
        await rename(source, target)
      } else if (sourceIsDir) {
        await cp(source, target, { recursive: true })
      } else {
        try {
          await copyFile(source, target, 1) // "wx": a target that appears meanwhile is left alone.
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new Error(`"${name}" was not copied: ${to} appeared meanwhile.`)
          }
          throw error
        }
      }
    } else {
      // -n: a target that appears meanwhile is left alone, and the check below reports it.
      await runChecked(project, mode === 'move' ? ['mv', '-n', '-T', '--', from, to] : ['cp', '-a', '-n', '-T', '--', from, to])
      if (mode === 'move' && (await pathExists(project, from))) {
        throw new Error(`"${name}" was not moved: ${to} appeared meanwhile.`)
      }
    }
    return { status: 'done', to }
  }
  if (!sourceIsDir && mode === 'move') {
    if (isWindowsProject(project)) await rename(source, target)
    else await runChecked(project, ['mv', '-f', '-T', '--', from, to])
  } else {
    // Copying into an existing folder merges it, replacing same-named files.
    if (isWindowsProject(project)) await cp(source, target, { recursive: true, force: true })
    else await runChecked(project, ['cp', '-a', '-f', '-T', '--', from, to])
    if (mode === 'move') {
      if (isWindowsProject(project)) await rm(source, { recursive: true, force: true })
      else await runChecked(project, ['rm', '-rf', '--', from])
    }
  }
  return { status: 'done', to }
}

/** Deletes a file or folder for good; a symlink is removed, not its target. */
export async function deletePath(project: Project, projectPath: string): Promise<void> {
  assertInsideProject(project, projectPath)
  if (path.posix.normalize(projectPath) === project.rootPath) throw new Error('The project folder itself cannot be deleted.')
  if (isWindowsProject(project)) {
    await rm(osPath(project, projectPath), { recursive: true, force: true })
    return
  }
  await runChecked(project, ['rm', '-rf', '--', projectPath])
}

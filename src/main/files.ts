import { open, readdir, stat, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import type { DirEntry, FileContent, Project, TransferMode, TransferResult, WriteResult } from '../shared/api'
import { assertInsideProject, runInWsl, toUnc } from './wsl'

const MAX_TEXT_BYTES = 5 * 1024 * 1024
const BINARY_SNIFF_BYTES = 8192
const HIDDEN_NAMES = new Set(['.git'])

// Windows cannot follow Linux symlinks over \\wsl.localhost: lstat/readlink fail with
// EISDIR and open/stat with ENOENT. Links are resolved inside the distro instead.
const LINK_FAILURE_CODES = new Set(['ENOENT', 'EISDIR'])

function isLinkFailure(error: unknown): error is NodeJS.ErrnoException {
  return LINK_FAILURE_CODES.has((error as NodeJS.ErrnoException).code ?? '')
}

/**
 * Resolves symlinks in linuxPath inside the distro. Rethrows the original error when the
 * path has no links to resolve, so a genuinely missing file still reports ENOENT.
 */
async function resolveRealPath(project: Project, linuxPath: string, original: Error): Promise<string> {
  const result = await runInWsl(project.distro, ['realpath', '-e', '--', linuxPath])
  if (result.code !== 0) {
    throw new Error(`${original.message}; resolving it inside WSL failed: ${result.stderr.trim() || `exit code ${result.code}`}`)
  }
  const realPath = result.stdout.replace(/\n$/, '')
  if (realPath === linuxPath) throw original
  return realPath
}

/** Asks the distro what each symlink points to; a link missing from the answer cannot be followed. */
async function followLinks(project: Project, linkPaths: string[]): Promise<Map<string, { isDir: boolean } | { error: string }>> {
  const out = new Map<string, { isDir: boolean } | { error: string }>()
  if (linkPaths.length === 0) return out
  const result = await runInWsl(project.distro, ['stat', '-L', '--printf', '%F\t%n\n', '--', ...linkPaths])
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

async function readDirents(project: Project, linuxPath: string): Promise<Dirent[]> {
  try {
    return await readdir(toUnc(project.distro, linuxPath), { withFileTypes: true })
  } catch (error) {
    if (!isLinkFailure(error)) throw error
    const realPath = await resolveRealPath(project, linuxPath, error)
    return readdir(toUnc(project.distro, realPath), { withFileTypes: true })
  }
}

export async function listDir(project: Project, linuxPath: string): Promise<DirEntry[]> {
  assertInsideProject(project, linuxPath)
  const dirents = (await readDirents(project, linuxPath)).filter((d) => !HIDDEN_NAMES.has(d.name))
  const links = await followLinks(
    project,
    dirents.filter((d) => d.isSymbolicLink()).map((d) => path.posix.join(linuxPath, d.name))
  )
  const entries = dirents.map((d): DirEntry => {
    const entryPath = path.posix.join(linuxPath, d.name)
    const link = links.get(entryPath)
    if (!link) return { name: d.name, path: entryPath, isDir: d.isDirectory(), isSymlink: false, linkError: null }
    if ('error' in link) return { name: d.name, path: entryPath, isDir: false, isSymlink: true, linkError: link.error }
    return { name: d.name, path: entryPath, isDir: link.isDir, isSymlink: true, linkError: null }
  })
  return entries.sort(
    (a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  )
}

async function readUnc(uncPath: string, realPath: string | null): Promise<FileContent> {
  const handle = await open(uncPath, 'r')
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

export async function readFileContent(project: Project, linuxPath: string): Promise<FileContent> {
  assertInsideProject(project, linuxPath)
  try {
    return await readUnc(toUnc(project.distro, linuxPath), null)
  } catch (error) {
    if (!isLinkFailure(error)) throw error
    // Link targets may lie outside the project: the link itself is inside it.
    const realPath = await resolveRealPath(project, linuxPath, error)
    return readUnc(toUnc(project.distro, realPath), realPath)
  }
}

/** The Linux path Windows can open: the path itself, or its target when it goes through a symlink. */
export async function openablePath(project: Project, linuxPath: string): Promise<string> {
  try {
    await stat(toUnc(project.distro, linuxPath))
    return linuxPath
  } catch (error) {
    if (!isLinkFailure(error)) throw error
    return resolveRealPath(project, linuxPath, error)
  }
}

export async function writeFileContent(
  project: Project,
  linuxPath: string,
  text: string,
  expectedMtimeMs: number | null
): Promise<WriteResult> {
  assertInsideProject(project, linuxPath)
  const target = toUnc(project.distro, await openablePath(project, linuxPath))
  if (expectedMtimeMs !== null) {
    const diskMtimeMs = (await stat(target)).mtimeMs
    if (diskMtimeMs !== expectedMtimeMs) return { status: 'conflict', diskMtimeMs }
  }
  // In-place write keeps the file's inode, owner and permissions.
  await writeFile(target, text, 'utf8')
  return { status: 'saved', mtimeMs: (await stat(target)).mtimeMs }
}

async function pathExists(project: Project, linuxPath: string): Promise<boolean> {
  // find -maxdepth 0 also sees a broken symlink, which `test -e` reports as missing.
  const result = await runInWsl(project.distro, ['find', linuxPath, '-maxdepth', '0'])
  if (result.code === 0) return true
  if (/No such file or directory/.test(result.stderr)) return false
  throw new Error(`Cannot check "${linuxPath}": ${result.stderr.trim() || `find exited with code ${result.code}`}`)
}


async function isDirectory(project: Project, linuxPath: string): Promise<boolean> {
  const result = await runInWsl(project.distro, ['test', '-d', linuxPath])
  return result.code === 0
}

async function runChecked(project: Project, command: string[]): Promise<void> {
  const result = await runInWsl(project.distro, command)
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
 * merges into the folder, its files replacing same-named ones. Work happens inside the distro:
 * Windows cannot handle Linux symlinks over the network path.
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
  if (from === project.linuxPath) throw new Error('The project folder itself cannot be moved or copied.')
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
  if (!taken) {
    // -n: a target that appears meanwhile is left alone, and the check below reports it.
    await runChecked(project, mode === 'move' ? ['mv', '-n', '-T', '--', from, to] : ['cp', '-a', '-n', '-T', '--', from, to])
    if (mode === 'move' && (await pathExists(project, from))) {
      throw new Error(`"${name}" was not moved: ${to} appeared meanwhile.`)
    }
    return { status: 'done', to }
  }
  if (!sourceIsDir && mode === 'move') {
    await runChecked(project, ['mv', '-f', '-T', '--', from, to])
  } else {
    // cp -T into an existing folder merges it, replacing same-named files.
    await runChecked(project, ['cp', '-a', '-f', '-T', '--', from, to])
    if (mode === 'move') await runChecked(project, ['rm', '-rf', '--', from])
  }
  return { status: 'done', to }
}

/** Deletes a file or folder for good; a symlink is removed, not its target. */
export async function deletePath(project: Project, linuxPath: string): Promise<void> {
  assertInsideProject(project, linuxPath)
  if (path.posix.normalize(linuxPath) === project.linuxPath) throw new Error('The project folder itself cannot be deleted.')
  await runChecked(project, ['rm', '-rf', '--', linuxPath])
}

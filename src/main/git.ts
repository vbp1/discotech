import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readlink } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { GitChangedFile, GitFileDiff, GitProjectStatus, GitWorktree, Project } from '../shared/api'
import { BINARY_SNIFF_BYTES, MAX_TEXT_BYTES, readFileContent } from './files'
import { listProjects } from './projects'
import { assertInsideProject, osPath, runInWsl } from './wsl'

const exec = promisify(execFile)

async function git(project: Project, directory: string, args: string[]): Promise<string> {
  const command = ['--no-optional-locks', '-c', 'core.quotePath=false', '-c', 'core.fsmonitor=false', '-C', directory, ...args]
  if (project.distro === null) {
    return (await exec('git.exe', command, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 })).stdout
  }
  const { code, stdout, stderr } = await runInWsl(project.distro, ['git', ...command])
  if (code !== 0) throw new Error(stderr.trim() || `git ${args[0]} exited with code ${code}.`)
  return stdout
}

function pathKey(project: Project, value: string): string {
  return project.distro === null ? path.win32.normalize(value).replaceAll('\\', '/').toLowerCase() : path.posix.normalize(value)
}

async function configuredProject(id: string): Promise<Project> {
  const project = (await listProjects()).find((p) => p.id === id)
  if (!project) throw new Error(`Project "${id}" is no longer in the project list.`)
  return project
}

async function repositoryRoot(project: Project): Promise<string | null> {
  // A missing .git is normal for an ordinary folder. Ask Git once a marker has been found so
  // a broken repository or unavailable Git surfaces the original error.
  const paths = project.distro === null ? path.win32 : path.posix
  let directory = project.rootPath
  while (true) {
    try {
      await lstat(osPath(project, paths.join(directory, '.git')))
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const parent = paths.dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
  return (await git(project, project.rootPath, ['rev-parse', '--show-toplevel'])).replace(/\r?\n$/, '')
}

function porcelainPath(value: string): string {
  // Recent Git versions C-quote special characters. core.quotePath=false keeps UTF-8 intact.
  // Git 2.34 emits the absolute path as-is.
  if (!value.startsWith('"')) return value
  if (!/^"(?:[^"\\]|\\[abfnrtv"\\])*"$/.test(value)) throw new Error(`Invalid Git worktree path: ${value}`)
  const escapes: Record<string, string> = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\x0b', '"': '"', '\\': '\\' }
  return value.slice(1, -1).replace(/\\(.)/g, (_, char: string) => escapes[char])
}

function parseWorktrees(raw: string): GitWorktree[] {
  return raw.trimEnd().split(/\r?\n\r?\n/).map((record) => {
    const [first, ...attributes] = record.split(/\r?\n/)
    const head = attributes.find((line) => line.startsWith('HEAD '))?.slice(5)
    if (!first.startsWith('worktree ') || (!attributes.includes('bare') && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head ?? ''))) {
      throw new Error(`Invalid git worktree list record: ${record}`)
    }
    const branch = attributes.find((line) => line.startsWith('branch refs/heads/'))?.slice('branch refs/heads/'.length) ?? null
    return {
      path: porcelainPath(first.slice('worktree '.length)),
      branch,
      head: head ?? '',
      locked: attributes.some((line) => line === 'locked' || line.startsWith('locked ')),
      prunable: attributes.some((line) => line === 'prunable' || line.startsWith('prunable '))
    }
  })
}

async function repository(project: Project): Promise<{ current: GitWorktree; linked: GitWorktree[] } | null> {
  const root = await repositoryRoot(project)
  if (root === null) return null
  const [primary, ...linked] = parseWorktrees(await git(project, root, ['worktree', 'list', '--porcelain']))
  const current = [primary, ...linked].find((tree) => pathKey(project, tree.path) === pathKey(project, root))
  if (!current) throw new Error(`Git did not list the current working tree "${root}".`)
  return { current, linked: linked.filter((tree) => tree !== current) }
}

async function listChangedFiles(project: Project, directory: string): Promise<GitChangedFile[]> {
  const output = await git(project, directory, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  const records = output.split('\0')
  if (records.pop() !== '') throw new Error('Git status output is missing its final NUL.')
  const files: GitChangedFile[] = []
  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    const code = record.slice(0, 2)
    const path = record.slice(3)
    if (record[2] !== ' ' || !path) throw new Error(`Invalid Git status record: ${JSON.stringify(record)}`)
    // Porcelain v1 separates both names with NUL and puts the destination first.
    const previousPath = /[RC]/.test(code) ? records[++index] : null
    if (previousPath === undefined || previousPath === '') throw new Error(`Git status is missing the previous path for "${path}".`)
    files.push({ path, previousPath, code })
  }
  return files
}

export async function getGitProjectStatus(
  projectId: string,
  worktreePath: string | null,
  includeChangedFiles: boolean
): Promise<GitProjectStatus | null> {
  const project = await configuredProject(projectId)
  const repo = await repository(project)
  if (!repo) return null
  const selected = worktreePath === null ? repo.current : repo.linked.find((tree) => tree.path === worktreePath && !tree.prunable)
  if (!selected) return { worktrees: repo.linked, status: null, changedFiles: null }
  const unborn = /^0+$/.test(selected.head)
  const base = unborn ? createHash(selected.head.length === 40 ? 'sha1' : 'sha256').update('tree 0\0').digest('hex') : selected.head
  const [raw, branch, changedFiles] = await Promise.all([
    git(project, selected.path, ['diff', '--numstat', '--no-color', '--no-ext-diff', '--no-textconv', base, '--']),
    unborn && !selected.branch ? git(project, selected.path, ['symbolic-ref', '--short', 'HEAD']).then((ref) => ref.trimEnd()) : selected.branch,
    includeChangedFiles && worktreePath !== null ? listChangedFiles(project, selected.path) : null
  ])
  let added = 0
  let deleted = 0
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue
    const counts = /^(\d+|-)\t(\d+|-)\t/.exec(line)
    if (!counts) throw new Error(`Invalid git diff --numstat record: ${line}`)
    if (counts[1] !== '-') added += Number(counts[1])
    if (counts[2] !== '-') deleted += Number(counts[2])
  }
  return { worktrees: repo.linked, status: { path: selected.path, branch, head: selected.head, added, deleted }, changedFiles }
}

type DiffSide = { kind: 'text'; text: string } | Exclude<GitFileDiff, { kind: 'text' }>
const emptySide: DiffSide = { kind: 'text', text: '' }

async function committedFile(project: Project, tree: GitWorktree, file: GitChangedFile): Promise<DiffSide> {
  if (file.code === '??' || /^0+$/.test(tree.head)) return emptySide
  const name = file.previousPath ?? file.path
  const entry = await git(project, tree.path, ['ls-tree', '-l', '-z', '--full-tree', tree.head, '--', `:(literal)${name}`])
  if (!entry) return emptySide
  const object = /^\d+ (blob|tree|commit) ([0-9a-f]+) +(-|\d+)\t/.exec(entry)
  if (!object) throw new Error(`Invalid Git tree entry for "${name}".`)
  if (object[1] === 'tree') return emptySide
  if (object[1] !== 'blob') return { kind: 'unsupported' }
  if (Number(object[3]) > MAX_TEXT_BYTES) return { kind: 'too-large', limit: MAX_TEXT_BYTES }
  const text = await git(project, tree.path, ['cat-file', 'blob', object[2]])
  return text.slice(0, BINARY_SNIFF_BYTES).includes('\0') ? { kind: 'binary' } : { kind: 'text', text }
}

async function workingFile(project: Project, file: GitChangedFile): Promise<DiffSide> {
  if (file.code[1] === 'D' || file.code === 'D ') return emptySide
  const filename = path.posix.join(project.rootPath, file.path)
  assertInsideProject(project, filename)
  const nativePath = osPath(project, filename)
  if (project.distro === null) {
    const info = await lstat(nativePath)
    if (info.isSymbolicLink()) return { kind: 'text', text: await readlink(nativePath) }
    if (!info.isFile()) return { kind: 'unsupported' }
  } else {
    // Windows cannot lstat Linux symlinks over the WSL share.
    const mode = await runInWsl(project.distro, ['stat', '--printf', '%f', '--', filename])
    if (mode.code !== 0) throw new Error(mode.stderr.trim() || `stat exited with code ${mode.code}.`)
    if (!/^[0-9a-f]+$/.test(mode.stdout)) throw new Error(`Invalid file mode for "${filename}".`)
    const type = Number.parseInt(mode.stdout, 16) & 0xf000
    if (type === 0xa000) {
      const link = await runInWsl(project.distro, ['readlink', '-n', '--', filename])
      if (link.code !== 0) throw new Error(link.stderr.trim() || `readlink exited with code ${link.code}.`)
      return { kind: 'text', text: link.stdout }
    }
    if (type !== 0x8000) return { kind: 'unsupported' }
  }
  const content = await readFileContent(project, filename)
  if (content.kind === 'missing') throw new Error('Файл изменился на диске. Откройте сравнение ещё раз.')
  return content
}

export async function readGitFileDiff(projectId: string, worktreePath: string, requested: GitChangedFile): Promise<GitFileDiff> {
  const project = await configuredProject(projectId)
  const repo = await repository(project)
  const tree = repo?.linked.find((entry) => entry.path === worktreePath && !entry.prunable)
  if (!tree) throw new Error('Рабочая копия недоступна.')
  const files = await listChangedFiles(project, tree.path)
  const file = files.find((entry) => entry.path === requested.path && entry.code === requested.code && entry.previousPath === requested.previousPath)
  if (!file) throw new Error('Файл изменился. Выберите его в обновлённом списке.')
  const [original, modified] = await Promise.all([
    committedFile(project, tree, file),
    workingFile({ ...project, rootPath: tree.path }, file)
  ])
  if (original.kind !== 'text') return original
  if (modified.kind !== 'text') return modified
  return { kind: 'text', original: original.text, modified: modified.text }
}

export async function removeGitWorktree(projectId: string, expected: GitWorktree): Promise<void> {
  const project = await configuredProject(projectId)
  const repo = await repository(project)
  const selected = repo?.linked.find((tree) => tree.path === expected.path)
  if (!repo || !selected || selected.branch !== expected.branch || selected.head !== expected.head) {
    throw new Error('Рабочая копия изменилась. Обновите выбор и подтвердите удаление снова.')
  }
  if (selected.locked || selected.prunable) throw new Error('Эта рабочая копия заблокирована или недоступна.')
  const key = pathKey(project, selected.path)
  const prefix = key.endsWith('/') ? key : key + '/'
  const isProject = (await listProjects()).some((p) => {
    if (p.distro !== project.distro) return false
    const root = pathKey(project, p.rootPath)
    return root === key || root.startsWith(prefix)
  })
  if (isProject) throw new Error('Сначала уберите из списка проекты, открытые из этой рабочей копии.')
  const selectedRoot = (await git(project, selected.path, ['rev-parse', '--show-toplevel'])).replace(/\r?\n$/, '')
  if (pathKey(project, selectedRoot) !== key) throw new Error(`"${selected.path}" is no longer a working tree root.`)
  await git(project, repo.current.path, ['worktree', 'remove', '--', selected.path])
}

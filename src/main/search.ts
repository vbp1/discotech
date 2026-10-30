import path from 'node:path'
import type { ContentMatch, ContentSearchResult, NameSearchResult, Project } from '../shared/api'
import { searchSkipDirs } from './projects'
import type { ChildProcess } from 'node:child_process'
import { defaultDistro, fromWslMount, spawnInWsl, toWslMount } from './wsl'

const NAME_LIMIT = 500
const CONTENT_LIMIT = 1000

type RgRun = { onLine(line: string): void }
type SearchKind = 'names' | 'content'

/** The search of each kind still running; a newer query of the same kind stops it. */
const running = new Map<SearchKind, ChildProcess>()

// Unreadable folders (e.g. a database's data directory) are left out of the results without a notice.
const UNREADABLE_RE = /: Permission denied \(os error 13\)$/

/**
 * Files excluded by git rules (.gitignore, .git/info/exclude) are searched too, as the tree shows
 * them; folders named in the settings' skip list are not.
 */
async function searchScope(): Promise<string[]> {
  return ['--hidden', '--no-ignore', ...(await searchSkipDirs()).flatMap((dir) => ['-g', `!${dir}`])]
}

/**
 * Runs ripgrep inside a distro; exit code 1 means "no matches" and is not an error, nor is exit
 * code 2 when its only complaints are unreadable folders. Windows-folder projects are searched
 * in the default distro through /mnt: that is where ripgrep runs.
 */
async function runRg(kind: SearchKind, project: Project, args: string[], run: RgRun): Promise<void> {
  const distro = project.distro ?? (await defaultDistro())
  return new Promise((resolve, reject) => {
    running.get(kind)?.kill()
    const child = spawnInWsl(distro, ['rg', ...args])
    running.set(kind, child)
    let tail = ''
    let stderr = ''
    let parseError: Error | null = null
    const consume = (lines: string[]): void => {
      if (parseError) return
      try {
        lines.forEach(run.onLine)
      } catch (error) {
        parseError = error as Error
        child.kill()
      }
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      const lines = (tail + chunk).split('\n')
      tail = lines.pop() ?? ''
      consume(lines)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (error) => reject(new Error(`wsl.exe failed to start: ${error.message}`)))
    child.on('exit', (code) => {
      const superseded = running.get(kind) !== child
      if (!superseded) running.delete(kind)
      if (tail) consume([tail])
      const onlyUnreadable =
        code === 2 && stderr.trim() !== '' && stderr.trim().split('\n').every((line) => UNREADABLE_RE.test(line))
      if (superseded) reject(new Error('Search replaced by a newer query.'))
      else if (parseError) reject(parseError)
      else if (code === 0 || code === 1 || onlyUnreadable) resolve()
      else reject(new Error(`ripgrep exited with code ${code}: ${stderr.trim() || 'no error output'}`))
    })
  })
}

export async function searchNames(project: Project, query: string): Promise<NameSearchResult> {
  const needle = query.toLowerCase()
  const root = project.distro === null ? toWslMount(project.rootPath) : project.rootPath
  const hits: { path: string; inName: boolean }[] = []
  await runRg('names', project, ['--files', ...(await searchScope()), root], {
    onLine(line) {
      const hit = project.distro === null ? fromWslMount(line) : line
      const relative = path.posix.relative(project.rootPath, hit)
      if (!relative.toLowerCase().includes(needle)) return
      hits.push({ path: hit, inName: path.posix.basename(hit).toLowerCase().includes(needle) })
    }
  })
  hits.sort((a, b) => Number(b.inName) - Number(a.inName) || a.path.length - b.path.length)
  return { paths: hits.slice(0, NAME_LIMIT).map((h) => h.path), total: hits.length, limit: NAME_LIMIT }
}

export async function searchContent(project: Project, query: string): Promise<ContentSearchResult> {
  const matches: ContentMatch[] = []
  let total = 0
  const root = project.distro === null ? toWslMount(project.rootPath) : project.rootPath
  await runRg(
    'content',
    project,
    ['--json', '-F', '-i', ...(await searchScope()), '--max-columns', '300', '--', query, root],
    {
      onLine(line) {
        if (!line) return
        const message = JSON.parse(line) as {
          type: string
          data: { path?: { text?: string }; line_number?: number; lines?: { text?: string } }
        }
        if (message.type !== 'match') return
        total += 1
        if (matches.length >= CONTENT_LIMIT) return
        const { data } = message
        if (!data.path?.text || data.line_number === undefined) {
          throw new Error(`ripgrep match without path or line number: ${line}`)
        }
        const hit = project.distro === null ? fromWslMount(data.path.text) : data.path.text
        matches.push({ path: hit, line: data.line_number, text: (data.lines?.text ?? '').trimEnd() })
      }
    }
  )
  return { matches, total, limit: CONTENT_LIMIT }
}

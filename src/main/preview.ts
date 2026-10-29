import { protocol } from 'electron'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Project } from '../shared/api'
import { openablePath } from './files'
import { listProjects } from './projects'
import { toUnc } from './wsl'

/**
 * HTML previews load as wslview://wsl/<distro>/<linux path>, so the page's relative links resolve to
 * files next to it. The distro sits in the path: a host such as "Ubuntu-22.04" ends in a number and
 * URL parsing rejects it. Only files inside registered projects are served.
 */
export const PREVIEW_SCHEME = 'wslview'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8'
}

/** Text of open HTML tabs, served in place of the file so unsaved edits show in the preview. */
const drafts = new Map<string, string>()

const draftKey = (distro: string, linuxPath: string): string => `${distro}:${linuxPath}`

export function setPreviewDraft(distro: string, linuxPath: string, text: string | null): void {
  if (text === null) drafts.delete(draftKey(distro, linuxPath))
  else drafts.set(draftKey(distro, linuxPath), text)
}

/** Must run before app ready. */
export function registerPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
  ])
}

function failure(status: number, message: string): Response {
  return new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } })
}

function owningProject(projects: Project[], distro: string, linuxPath: string): Project | undefined {
  return projects.find((p) => {
    if (p.distro !== distro) return false
    const root = p.linuxPath === '/' ? '/' : p.linuxPath + '/'
    return linuxPath === p.linuxPath || linuxPath.startsWith(root)
  })
}

async function serve(request: Request): Promise<Response> {
  const [, distroPart, ...rest] = new URL(request.url).pathname.split('/')
  const distro = decodeURIComponent(distroPart ?? '')
  const linuxPath = path.posix.normalize('/' + rest.map(decodeURIComponent).join('/'))
  const project = owningProject(await listProjects(), distro, linuxPath)
  if (!project) return failure(403, `${request.url} is outside the projects added to discotech.`)
  // The preview frame has an opaque origin, so its fetches and module scripts need CORS.
  const headers = {
    'content-type': MIME[path.posix.extname(linuxPath).toLowerCase()] ?? 'application/octet-stream',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store'
  }
  const draft = drafts.get(draftKey(project.distro, linuxPath))
  if (draft !== undefined) return new Response(draft, { headers })
  try {
    const body = await readFile(toUnc(project.distro, await openablePath(project, linuxPath)))
    return new Response(body, { headers })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return failure(code === 'ENOENT' ? 404 : 500, `${linuxPath}: ${(error as Error).message}`)
  }
}

/** Must run after app ready. */
export function handlePreviewScheme(): void {
  protocol.handle(PREVIEW_SCHEME, serve)
}

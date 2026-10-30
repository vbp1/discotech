import { protocol } from 'electron'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Project } from '../shared/api'
import { openablePath } from './files'
import { listProjects } from './projects'
import { osPath } from './wsl'

/**
 * HTML previews load as wslview://wsl/<distro>/<linux path> (WSL projects) or wslview://<drive>/<
 * path> (Windows projects, the drive letter is the URL host), so the page's relative links resolve
 * to files next to it. The distro sits in the path: a host such as "Ubuntu-22.04" ends in a number
 * and URL parsing rejects it. Only files inside registered projects are served.
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

const draftKey = (distro: string | null, projectPath: string): string => `${distro ?? 'windows'}:${projectPath}`

export function setPreviewDraft(distro: string | null, projectPath: string, text: string | null): void {
  if (text === null) drafts.delete(draftKey(distro, projectPath))
  else drafts.set(draftKey(distro, projectPath), text)
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

/** The project a preview URL belongs to; only files inside registered projects are served. */
function owningProject(projects: Project[], distro: string | null, projectPath: string): Project | undefined {
  return projects.find((p) => {
    if (p.distro !== distro) return false
    const root = p.rootPath.endsWith('/') ? p.rootPath : p.rootPath + '/'
    return projectPath === p.rootPath || projectPath.startsWith(root)
  })
}

async function serve(request: Request): Promise<Response> {
  const url = new URL(request.url)
  // wslview://wsl/<distro>/<path> or wslview://<drive>/<path>; the URL host cannot be empty.
  const distro = url.host === 'wsl' ? decodeURIComponent(url.pathname.split('/')[1] ?? '') : null
  const projectPath =
    url.host === 'wsl'
      ? path.posix.normalize('/' + url.pathname.split('/').slice(2).map(decodeURIComponent).join('/'))
      : `${url.host.toUpperCase()}:${decodeURIComponent(url.pathname)}`
  const project = owningProject(await listProjects(), distro, projectPath)
  if (!project) return failure(403, `${request.url} is outside the projects added to discotech.`)
  // The preview frame has an opaque origin, so its fetches and module scripts need CORS.
  const headers = {
    'content-type': MIME[path.posix.extname(projectPath).toLowerCase()] ?? 'application/octet-stream',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store'
  }
  const draft = drafts.get(draftKey(project.distro, projectPath))
  if (draft !== undefined) return new Response(draft, { headers })
  try {
    const body = await readFile(osPath(project, await openablePath(project, projectPath)))
    return new Response(body, { headers })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return failure(code === 'ENOENT' ? 404 : 500, `${projectPath}: ${(error as Error).message}`)
  }
}

/** Must run after app ready. */
export function handlePreviewScheme(): void {
  protocol.handle(PREVIEW_SCHEME, serve)
}

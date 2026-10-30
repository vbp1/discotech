import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import type { Project } from '../shared/api'

const UNC_PREFIXES = ['\\\\wsl.localhost\\', '\\\\wsl$\\']

export function toUnc(distro: string, linuxPath: string): string {
  return `\\\\wsl.localhost\\${distro}${linuxPath.replaceAll('/', '\\')}`
}

/** The path the app's Windows process opens: the distro share for WSL projects, the drive path for Windows ones. */
export function osPath(project: Project, projectPath: string): string {
  return project.distro === null ? projectPath.replaceAll('/', '\\') : toUnc(project.distro, projectPath)
}

/** Splits a Windows path picked in a dialog into its WSL distro and Linux path. */
export function parseUnc(windowsPath: string): { distro: string; linuxPath: string } {
  const prefix = UNC_PREFIXES.find((p) => windowsPath.toLowerCase().startsWith(p))
  if (!prefix) {
    throw new Error(
      `Folder "${windowsPath}" is not inside WSL. Expected a path starting with \\\\wsl.localhost\\<distro>\\ — pick a folder from the Linux section of the dialog.`
    )
  }
  const rest = windowsPath.slice(prefix.length).split('\\').filter(Boolean)
  const [distro, ...parts] = rest
  if (!distro) {
    throw new Error(`Folder "${windowsPath}" names no WSL distro.`)
  }
  return { distro, linuxPath: '/' + parts.join('/') }
}

let defaultDistroCache: string | null = null

/** Reads the WSL default distro; searches in Windows projects run ripgrep in it. */
export async function defaultDistro(): Promise<string> {
  if (defaultDistroCache) return defaultDistroCache
  const name = await new Promise<string>((resolve, reject) => {
    const child = spawn('wsl.exe', ['-l', '-v'], { windowsHide: true })
    const chunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.on('error', (error) => reject(new Error(`wsl.exe failed to start: ${error.message}`)))
    child.on('exit', (code) => {
      const raw = Buffer.concat(chunks)
      // wsl.exe prints UTF-16LE when its output is piped.
      const text = (raw.includes(0) ? raw.toString('utf16le') : raw.toString('utf8')).trim()
      if (code !== 0) return reject(new Error(`wsl.exe -l -v exited with code ${code}: ${text}`))
      // The default distro is marked with "*".
      const marked = text.split(/\r?\n/).find((line) => line.trim().startsWith('*'))
      const defaultName = marked?.trim().slice(1).trim().split(/\s+/)[0]
      if (!defaultName) return reject(new Error(`wsl.exe -l -v names no default distro (no "*" line): ${text}`))
      resolve(defaultName)
    })
  })
  defaultDistroCache = name
  return name
}

/** A Windows drive path in the app's path syntax: C:\Users\x → C:/Users/x. */
export function windowsDriveToProjectPath(windowsPath: string): string {
  const normalized = path.win32.normalize(windowsPath.trim())
  const match = /^([a-zA-Z]:)(?:\\(.*))?$/.exec(normalized)
  if (!match) throw new Error(`Folder "${windowsPath}" is not a drive path like C:\\…`)
  const rest = (match[2] ?? '').replaceAll('\\', '/').replace(/\/+$/, '')
  return `${match[1][0].toUpperCase()}:/${rest}`
}

/** The same path as the default distro sees it, for ripgrep: C:/Users → /mnt/c/Users. */
export function toWslMount(projectPath: string): string {
  const match = /^([a-zA-Z]):\/(.*)$/.exec(projectPath)
  if (!match) throw new Error(`"${projectPath}" is not a drive path.`)
  return `/mnt/${match[1].toLowerCase()}${match[2] ? '/' + match[2] : ''}`
}

/** Back from the distro mount to the app's path syntax: /mnt/c/Users → C:/Users. */
export function fromWslMount(mountPath: string): string {
  const match = /^\/mnt\/([a-zA-Z])(\/.*)?$/.exec(mountPath)
  if (!match) throw new Error(`"${mountPath}" is not under /mnt.`)
  return `${match[1].toUpperCase()}:/${(match[2] ?? '').replace(/^\//, '')}`
}

/** Rejects paths outside the project root before any file system access. */
export function assertInsideProject(project: Project, projectPath: string): void {
  const normalized =
    project.distro === null ? path.win32.normalize(projectPath).replaceAll('\\', '/') : path.posix.normalize(projectPath)
  const root = project.rootPath.endsWith('/') ? project.rootPath : project.rootPath + '/'
  if (normalized !== project.rootPath && !normalized.startsWith(root)) {
    throw new Error(`Path "${projectPath}" is outside project "${project.name}" (${project.rootPath}).`)
  }
}

export function spawnInWsl(distro: string, command: string[]): ChildProcessWithoutNullStreams {
  return spawn('wsl.exe', ['-d', distro, '--exec', ...command], { windowsHide: true })
}

export type WslResult = { code: number | null; stdout: string; stderr: string }

/** Runs a command inside the distro and collects its output; a non-zero exit code is returned, not thrown. */
export function runInWsl(distro: string, command: string[]): Promise<WslResult> {
  return new Promise((resolve, reject) => {
    const child = spawnInWsl(distro, command)
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => (stderr += chunk))
    child.on('error', (error) => reject(new Error(`wsl.exe failed to start: ${error.message}`)))
    child.on('exit', (code) => resolve({ code, stdout, stderr }))
  })
}

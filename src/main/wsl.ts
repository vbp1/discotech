import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import type { Project } from '../shared/api'

const UNC_PREFIXES = ['\\\\wsl.localhost\\', '\\\\wsl$\\']

export function toUnc(distro: string, linuxPath: string): string {
  return `\\\\wsl.localhost\\${distro}${linuxPath.replaceAll('/', '\\')}`
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

/** Rejects paths outside the project root before any file system access. */
export function assertInsideProject(project: Project, linuxPath: string): void {
  const normalized = path.posix.normalize(linuxPath)
  const root = project.linuxPath === '/' ? '/' : project.linuxPath + '/'
  if (normalized !== project.linuxPath && !normalized.startsWith(root)) {
    throw new Error(`Path "${linuxPath}" is outside project "${project.name}" (${project.linuxPath}).`)
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

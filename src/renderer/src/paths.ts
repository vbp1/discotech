import type { Project } from '../../shared/api'

export function parentDir(path: string): string {
  const index = path.lastIndexOf('/')
  if (index <= 0) return '/'
  // A drive root keeps its slash: parentDir("C:/x") is "C:/", not "C:".
  if (/^[a-zA-Z]:$/.test(path.slice(0, index))) return path.slice(0, index) + '/'
  return path.slice(0, index)
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

export function relativeTo(root: string, path: string): string {
  return path.startsWith(root + '/') ? path.slice(root.length + 1) : path
}

/** "C:/x" for Windows-folder projects and "/home/x" in distros, with the trailing slash kept. */
export function rootPrefix(root: string): string {
  return root.endsWith('/') ? root : root + '/'
}

/** Where a project lives: the distro and its path, or the drive path of a Windows folder. */
export function projectLocation(project: Project): string {
  return project.distro === null ? project.rootPath : `${project.distro}: ${project.rootPath}`
}

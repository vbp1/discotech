export function parentDir(path: string): string {
  const index = path.lastIndexOf('/')
  return index <= 0 ? '/' : path.slice(0, index)
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

export function relativeTo(root: string, path: string): string {
  return path.startsWith(root + '/') ? path.slice(root.length + 1) : path
}

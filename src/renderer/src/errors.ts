// Electron prefixes errors thrown in ipcMain handlers; the prefix carries no information.
const IPC_PREFIX = /^Error invoking remote method '[^']+': (Error: )?/

export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(IPC_PREFIX, '')
}

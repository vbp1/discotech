// Contract between the main process and the renderer. All paths are Linux
// paths inside a WSL distro; the main process maps them to UNC paths.

export type Project = {
  id: string
  name: string
  distro: string
  linuxPath: string
}

export type DirEntry = {
  name: string
  path: string
  isDir: boolean
  isSymlink: boolean
  /** Why a symlink cannot be followed (target missing, no permission); null otherwise. */
  linkError: string | null
}

/** realPath is the resolved Linux path when the requested path goes through a symlink. */
export type FileContent = { realPath: string | null } & (
  | { kind: 'text'; text: string; size: number; mtimeMs: number }
  | { kind: 'binary'; size: number }
  | { kind: 'too-large'; size: number; limit: number }
  /** Nothing is at the path: the file was deleted or moved away. */
  | { kind: 'missing' }
)

export type WriteResult =
  | { status: 'saved'; mtimeMs: number }
  /** The file changed on disk since it was read; nothing was written. */
  | { status: 'conflict'; diskMtimeMs: number }

export type FsEventType = 'create' | 'delete' | 'modify' | 'move'

export type FsEvent = {
  projectId: string
  type: FsEventType
  path: string
  isDir: boolean
}

export type WatchStatus =
  | { projectId: string; state: 'running' }
  | { projectId: string; state: 'failed'; message: string }

export type NameSearchResult = { paths: string[]; total: number; limit: number }

export type ContentMatch = { path: string; line: number; text: string }

export type ContentSearchResult = { matches: ContentMatch[]; total: number; limit: number }

export type DiscotechApi = {
  listProjects(): Promise<Project[]>
  addProject(): Promise<Project | null>
  removeProject(id: string): Promise<void>
  listDir(project: Project, linuxPath: string): Promise<DirEntry[]>
  readFile(project: Project, linuxPath: string): Promise<FileContent>
  /** Writes text; expectedMtimeMs null skips the on-disk change check (explicit overwrite). */
  writeFile(project: Project, linuxPath: string, text: string, expectedMtimeMs: number | null): Promise<WriteResult>
  /** Closes the window although tabs have unsaved edits; the user has confirmed it. */
  closeWindowDiscarding(): Promise<void>
  /** Creates a file that is not on disk, with any missing folders; a conflict when something is already there. */
  createFile(project: Project, linuxPath: string, text: string): Promise<WriteResult>
  /**
   * Moves or copies a file or folder into toDir. A taken name comes back as "exists" with nothing
   * changed, unless overwrite: then a file is replaced and a folder merged. A copy into its own
   * folder gets a free "name copy" name.
   */
  transferPath(project: Project, from: string, toDir: string, mode: TransferMode, overwrite: boolean): Promise<TransferResult>
  /** The project and tabs open when the app last ran; empty on a first launch. */
  getSession(): Promise<SessionState>
  /** Replaces the stored session. */
  setSession(state: SessionState): Promise<void>
  /** Deletes a file or folder for good. */
  deletePath(project: Project, linuxPath: string): Promise<void>
  watchProject(project: Project): Promise<void>
  searchNames(project: Project, query: string): Promise<NameSearchResult>
  searchContent(project: Project, query: string): Promise<ContentSearchResult>
  /** Text the HTML preview shows for a file instead of its disk content; null forgets it. */
  setPreviewDraft(distro: string, linuxPath: string, text: string | null): Promise<void>
  /** Reads Claude, Codex and Z.ai logins from the distro's home and asks the services for usage. */
  getUsage(distro: string): Promise<UsageReport>
  onFsEvent(listener: (event: FsEvent) => void): () => void
  onWatchStatus(listener: (status: WatchStatus) => void): () => void
}

/** An open tab; at most one per project is unpinned (the preview tab). */
export type SessionTab = {
  path: string
  pinned: boolean
  /** The text a tab holds for a file no longer at its path. */
  orphanText?: string
}

/** What was open when the app last ran. */
export type SessionState = {
  activeProjectId: string | null
  projects: Record<string, { tabs: SessionTab[]; active: string | null }>
}

export type TransferMode = 'move' | 'copy'

export type TransferResult = { status: 'done'; to: string } | { status: 'exists'; to: string; isDir: boolean }

export type UsageWindow = {
  /** Human label: "5 часов", "Неделя", "Неделя · Fable". */
  label: string
  usedPercent: number
  /** Epoch ms; null when the service did not say. */
  resetsAt: number | null
}

export type ProviderUsage =
  | { status: 'ok'; plan: string | null; windows: UsageWindow[]; source: string; fetchedAt: number }
  | { status: 'error'; message: string; source: string; fetchedAt: number }

export type UsageReport = { claude: ProviderUsage; codex: ProviderUsage; zai: ProviderUsage }

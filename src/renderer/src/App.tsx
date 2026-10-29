import { FolderInput, Replace, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Project, SessionState, TransferMode, WatchStatus } from '../../shared/api'
import type { TreeClipboard } from './FileTree'
import { baseName } from './paths'
import { toast } from 'sonner'
import { EditorArea, type OpenRequest, type PathNotice } from './EditorArea'
import { Toaster } from './Toaster'
import { ConfirmHost, confirmDialog } from './confirm'
import { Sidebar } from './Sidebar'
import { UsageStatus } from './UsageStatus'
import { errorText } from './errors'
import { DEFAULT_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, useLayoutPrefs, type ZoomPanel } from './layoutPrefs'

// Earlier builds kept the shown project in browser storage; it seeds a session that has none.
function legacyActiveProject(): string | null {
  try {
    return localStorage.getItem('discotech.activeProject')
  } catch {
    return null
  }
}

export function App(): React.JSX.Element {
  const [projects, setProjects] = useState<Project[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  // Open project and tabs from the last run; null until read from disk.
  const [session, setSession] = useState<SessionState | null>(null)
  const sessionRef = useRef<SessionState | null>(null)
  const [watchStatus, setWatchStatus] = useState<WatchStatus | null>(null)
  const [openRequest, setOpenRequest] = useState<OpenRequest | null>(null)
  const [revealPath, setRevealPath] = useState<string | null>(null)
  const [pathNotice, setPathNotice] = useState<PathNotice | null>(null)
  const [clipboard, setClipboard] = useState<TreeClipboard | null>(null)

  // With no remembered project (first launch, cleared storage) the first one in the list opens.
  const project = projects.find((p) => p.id === activeId) ?? projects[0] ?? null
  const { prefs, setSidebarWidth, zoom } = useLayoutPrefs()
  const sidebarRef = useRef<HTMLElement>(null)
  const mainRef = useRef<HTMLElement>(null)
  const zoomTarget = useRef<ZoomPanel>('editor')

  // Ctrl+wheel zooms the panel under the pointer; Ctrl+=/-/0 zoom the panel last pointed at or focused.
  useEffect(() => {
    const panels: [HTMLElement | null, ZoomPanel][] = [
      [sidebarRef.current, 'tree'],
      [mainRef.current, 'editor']
    ]
    const cleanups = panels.map(([element, panel]) => {
      if (!element) return () => {}
      const onWheel = (e: WheelEvent): void => {
        if (!e.ctrlKey) return
        e.preventDefault()
        e.stopPropagation()
        zoom(panel, e.deltaY < 0 ? 1 : -1)
      }
      const mark = (): void => {
        zoomTarget.current = panel
      }
      element.addEventListener('wheel', onWheel, { passive: false, capture: true })
      element.addEventListener('pointerenter', mark)
      element.addEventListener('focusin', mark)
      return () => {
        element.removeEventListener('wheel', onWheel, { capture: true })
        element.removeEventListener('pointerenter', mark)
        element.removeEventListener('focusin', mark)
      }
    })
    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || e.altKey) return
      const step = e.key === '=' || e.key === '+' ? 1 : e.key === '-' ? -1 : e.key === '0' ? 'reset' : null
      if (step === null) return
      e.preventDefault()
      e.stopPropagation()
      zoom(zoomTarget.current, step)
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => {
      cleanups.forEach((c) => c())
      window.removeEventListener('keydown', onKey, { capture: true })
    }
  }, [zoom])

  const startResize = (e: React.PointerEvent<HTMLDivElement>): void => {
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    const onMove = (move: PointerEvent): void => {
      const max = window.innerWidth * 0.7
      setSidebarWidth(Math.round(Math.min(max, Math.max(MIN_SIDEBAR_WIDTH, move.clientX))))
    }
    const onUp = (): void => {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      document.body.classList.remove('resizing')
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
    document.body.classList.add('resizing')
  }

  useEffect(() => {
    window.discotech
      .listProjects()
      .then(setProjects)
      .catch((e) => toast.error(errorText(e)))
    window.discotech.getSession().then(
      (loaded) => {
        sessionRef.current = loaded
        setActiveId(loaded.activeProjectId ?? legacyActiveProject())
        setSession(loaded)
      },
      (e) => {
        toast.error('Не удалось восстановить открытые вкладки', {
          description: `${errorText(e)} Вкладки начнутся заново, файл сессии перезапишется.`,
          duration: Infinity
        })
        const empty = { activeProjectId: null, projects: {} }
        sessionRef.current = empty
        setSession(empty)
      }
    )
    return window.discotech.onWatchStatus(setWatchStatus)
  }, [])

  const updateSession = useCallback((change: (state: SessionState) => SessionState) => {
    if (!sessionRef.current) return
    sessionRef.current = change(sessionRef.current)
    window.discotech
      .setSession(sessionRef.current)
      .catch((e) => toast.error('Не удалось запомнить открытые вкладки', { description: errorText(e) }))
  }, [])

  useEffect(() => {
    if (activeId) updateSession((s) => ({ ...s, activeProjectId: activeId }))
  }, [activeId, updateSession])

  const onTabsChange = useCallback(
    (projectId: string, tabs: SessionState['projects'][string]) =>
      updateSession((s) => ({ ...s, projects: { ...s.projects, [projectId]: tabs } })),
    [updateSession]
  )

  useEffect(() => {
    if (!project) return
    setWatchStatus(null)
    window.discotech.watchProject(project).catch((e) => toast.error(errorText(e)))
  }, [project])

  const addProject = async (): Promise<void> => {
    try {
      const added = await window.discotech.addProject()
      if (!added) return
      setProjects(await window.discotech.listProjects())
      setActiveId(added.id)
    } catch (e) {
      toast.error(errorText(e))
    }
  }

  const removeProject = async (id: string): Promise<void> => {
    const name = projects.find((p) => p.id === id)?.name ?? id
    if (
      (dirtyPaths[id]?.size ?? 0) > 0 &&
      !(await confirmDialog({
        title: `Убрать проект «${name}»?`,
        description: 'В нём есть несохранённые правки, они пропадут. Файлы на диске не тронуты.',
        confirmLabel: 'Убрать',
        destructive: true
      }))
    ) {
      return
    }
    try {
      await window.discotech.removeProject(id)
      const rest = await window.discotech.listProjects()
      setProjects(rest)
      updateSession((s) => {
        const { [id]: _removed, ...projects } = s.projects
        return { ...s, projects }
      })
      if (project?.id === id) setActiveId(rest[0]?.id ?? null)
    } catch (e) {
      toast.error(errorText(e))
    }
  }

  const openFile = useCallback((path: string, line?: number) => {
    setOpenRequest({ path, line, nonce: Date.now() })
    setRevealPath(path)
  }, [])

  // Open projects keep their tabs while another project is shown.
  const [visited, setVisited] = useState<Set<string>>(new Set())
  useEffect(() => {
    const id = project?.id
    if (id && !visited.has(id)) setVisited(new Set(visited).add(id))
  }, [project?.id, visited])

  const [dirtyPaths, setDirtyPaths] = useState<Record<string, ReadonlySet<string>>>({})
  const onDirtyPathsChange = useCallback((projectId: string, paths: ReadonlySet<string>) => {
    setDirtyPaths((prev) => (prev[projectId] === paths ? prev : { ...prev, [projectId]: paths }))
  }, [])
  const totalDirty = Object.values(dirtyPaths).reduce((a, b) => a + b.size, 0)

  /** Open tabs at or under `path` with unsaved edits; such files are never moved, replaced or deleted. */
  const unsavedUnder = (target: Project, path: string): string[] =>
    [...(dirtyPaths[target.id] ?? [])].filter((p) => p === path || p.startsWith(path + '/'))
  const refuseUnsaved = (verb: string, paths: string[]): boolean => {
    if (paths.length === 0) return false
    toast.error(`Не ${verb}: есть несохранённые правки в ${paths.map((p) => `«${baseName(p)}»`).join(', ')}.`, {
      description: 'Сохраните или закройте вкладку.'
    })
    return true
  }

  /**
   * Moves or copies a file or folder from the tree; open tabs follow a move. A taken name asks
   * whether to replace it (a folder merges). Returns the new path, or null when nothing changed.
   */
  const transferPath = async (target: Project, from: string, toDir: string, mode: TransferMode): Promise<string | null> => {
    const verb = mode === 'move' ? 'перенесено' : 'скопировано'
    if (mode === 'move' && refuseUnsaved(verb, unsavedUnder(target, from))) return null
    try {
      let result = await window.discotech.transferPath(target, from, toDir, mode, false)
      if (result.status === 'exists') {
        const name = baseName(result.to)
        const where = baseName(toDir) || toDir
        const ok = await confirmDialog(
          result.isDir
            ? {
                title: `Слить папки «${name}»?`,
                description: `Папка «${name}» уже есть в «${where}». Содержимое сложится вместе, файлы с совпадающими именами заменятся.`,
                confirmLabel: 'Слить',
                icon: <FolderInput size={20} />
              }
            : {
                title: `Заменить «${name}»?`,
                description: `Файл «${name}» уже есть в «${where}». Он будет заменён.`,
                confirmLabel: 'Заменить',
                destructive: true,
                icon: <Replace size={20} />
              }
        )
        if (!ok) return null
        if (refuseUnsaved(verb, unsavedUnder(target, result.to))) return null
        result = await window.discotech.transferPath(target, from, toDir, mode, true)
        if (result.status === 'exists') throw new Error(`${result.to} still exists after overwrite was confirmed.`)
      }
      if (mode === 'move') setPathNotice({ kind: 'moved', projectId: target.id, from, to: result.to, nonce: Date.now() })
      return result.to
    } catch (e) {
      toast.error(`Не ${verb}: ${errorText(e)}`)
      return null
    }
  }

  const deletePath = async (target: Project, path: string): Promise<boolean> => {
    if (refuseUnsaved('удалено', unsavedUnder(target, path))) return false
    const ok = await confirmDialog({
      title: `Удалить «${baseName(path)}» насовсем?`,
      description: 'Корзины для файлов WSL нет: вернуть будет нельзя.',
      confirmLabel: 'Удалить',
      destructive: true,
      icon: <Trash2 size={20} />
    })
    if (!ok) return false
    try {
      await window.discotech.deletePath(target, path)
      setPathNotice({ kind: 'deleted', projectId: target.id, path, nonce: Date.now() })
      setClipboard((prev) => (prev && (prev.path === path || prev.path.startsWith(path + '/')) ? null : prev))
      return true
    } catch (e) {
      toast.error(`Не удалено: ${errorText(e)}`)
      return false
    }
  }

  // The main process asks before closing the window while edits are unsaved.
  useEffect(() => {
    if (totalDirty === 0) return
    const onBeforeUnload = (e: BeforeUnloadEvent): void => e.preventDefault()
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [totalDirty])

  const watchFailed = watchStatus?.state === 'failed' && watchStatus.projectId === project?.id
  useEffect(() => {
    if (!watchFailed || !project) return
    const id = `watch:${project.id}`
    toast.error('Изменения файлов на диске не отслеживаются', {
      id,
      description: watchStatus.message,
      duration: Infinity,
      action: { label: 'Перезапустить', onClick: () => void window.discotech.watchProject(project) }
    })
    return () => void toast.dismiss(id)
  }, [watchFailed, watchStatus, project])

  return (
    <div className="app-shell">
      <div className="app">
        <Sidebar
          ref={sidebarRef}
          width={prefs.sidebarWidth}
          fontSize={prefs.fontSize.tree}
          projects={projects}
          project={project}
          onSelectProject={setActiveId}
          onAddProject={addProject}
          onRemoveProject={removeProject}
          onOpenFile={openFile}
          clipboard={clipboard}
          onClipboardChange={setClipboard}
          onTransferPath={transferPath}
          onDeletePath={deletePath}
          activePath={revealPath}
        />
        <div className="splitter" onPointerDown={startResize} onDoubleClick={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)} />
        <main className="main" ref={mainRef}>
          {session &&
            projects
              .filter((p) => visited.has(p.id))
              .map((p) => (
                <EditorArea
                  key={p.id}
                  project={p}
                  visible={p.id === project?.id}
                  fontSize={prefs.fontSize.editor}
                  openRequest={p.id === project?.id ? openRequest : null}
                  onActivePathChange={setRevealPath}
                  pathNotice={pathNotice?.projectId === p.id ? pathNotice : null}
                  onDirtyPathsChange={onDirtyPathsChange}
                  initialTabs={session.projects[p.id] ?? null}
                  onTabsChange={onTabsChange}
                />
              ))}
          {!project && (
            <>
              <div className="tab-strip drag" />
              <div className="empty">Добавьте папку проекта кнопкой слева.</div>
            </>
          )}
        </main>
      </div>
      <footer className="status-bar">
        <UsageStatus distro={project?.distro ?? projects[0]?.distro ?? null} />
        <span className="status-spacer" />
        <span className="status-muted">{project ? `${project.distro}: ${project.linuxPath}` : 'Нет проекта'}</span>
      </footer>
      <Toaster />
      <ConfirmHost />
    </div>
  )
}

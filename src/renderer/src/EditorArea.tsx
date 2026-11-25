import { FileText, GitCompare, Pin, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { PathMove, Project, SessionTab } from '../../shared/api'
import { confirmDialog } from './confirm'
import { errorText } from './errors'
import { GitDiffView, type GitDiffRequest } from './GitDiffView'
import { baseName, rootPrefix } from './paths'
import { TabBody } from './TabBody'
import { TabStrip } from './TabStrip'

export type OpenRequest =
  | { kind: 'file'; projectId: string; path: string; line?: number }
  | ({ kind: 'diff' } & GitDiffRequest)

/**
 * A group of files or folders moved or deleted from the tree: tabs at or under a move follow it;
 * tabs at or under a deleted path close (files with unsaved edits are never moved or deleted).
 */
export type PathNotice =
  | { kind: 'moved'; projectId: string; moves: PathMove[]; nonce: number }
  | { kind: 'deleted'; projectId: string; paths: string[]; nonce: number }

// At most one tab is unpinned: the preview tab that the next opened item replaces.
// A tab edited by the user is pinned.
type FileTab = SessionTab & { kind: 'file' }
type DiffTab = { kind: 'diff'; id: string; request: GitDiffRequest; pinned: boolean }
type Tab = FileTab | DiffTab

function tabId(tab: Tab): string {
  return tab.kind === 'file' ? tab.path : tab.id
}

function openPreview(tabs: Tab[], incoming: Tab, dirty: ReadonlySet<string>): Tab[] {
  const existing = tabs.find((tab) => tabId(tab) === tabId(incoming))
  if (existing) {
    if (incoming.kind === 'file') return tabs
    return tabs.map((tab) => tab === existing ? { ...incoming, pinned: existing.pinned } : tab)
  }
  const preview = tabs.find((tab) => !tab.pinned)
  if (!preview) return [...tabs, incoming]
  if (preview.kind === 'file' && hasTextToKeep(preview, dirty)) {
    return [...tabs.map((tab) => tab === preview ? { ...tab, pinned: true } : tab), incoming]
  }
  return tabs.map((tab) => tab === preview ? incoming : tab)
}

type Props = {
  project: Project
  visible: boolean
  fontSize: number
  openRequest: OpenRequest | null
  pathNotice: PathNotice | null
  onActivePathChange(path: string | null): void
  onDirtyPathsChange(projectId: string, paths: ReadonlySet<string>): void
  /** Tabs open in this project when the app last ran. */
  initialTabs: { tabs: SessionTab[]; active: string | null } | null
  onTabsChange(projectId: string, state: { tabs: SessionTab[]; active: string | null }): void
}

export function EditorArea(props: Props): React.JSX.Element {
  const { project, visible, fontSize, openRequest, pathNotice, onActivePathChange, onDirtyPathsChange } = props
  const [tabs, setTabs] = useState<Tab[]>(() => props.initialTabs?.tabs.map((tab) => ({ ...tab, kind: 'file' })) ?? [])
  const [activeId, setActiveId] = useState<string | null>(() => props.initialTabs?.active ?? null)
  const activeTab = tabs.find((tab) => tabId(tab) === activeId)
  const activePath = activeTab?.kind === 'file' ? activeTab.path : null
  const fileTabs = useMemo(() => tabs.filter((tab): tab is FileTab => tab.kind === 'file'), [tabs])
  const lastActiveFile = useRef(props.initialTabs?.active ?? null)
  const { onTabsChange } = props
  useEffect(() => {
    const savedTabs = fileTabs.map(({ kind: _kind, ...tab }) => tab)
    lastActiveFile.current = activePath ?? savedTabs.find((tab) => tab.path === lastActiveFile.current)?.path ?? savedTabs.at(-1)?.path ?? null
    onTabsChange(project.id, { tabs: savedTabs, active: lastActiveFile.current })
  }, [project.id, fileTabs, activePath, onTabsChange])
  const [reveal, setReveal] = useState<{ path: string; line: number } | null>(null)
  const [dirty, setDirty] = useState<Set<string>>(new Set())
  const dirtyRef = useRef(dirty)
  useEffect(() => {
    dirtyRef.current = dirty
  }, [dirty])
  const [deleted, setDeleted] = useState<Set<string>>(new Set())
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)

  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close, true)
    }
  }, [menu])

  useEffect(() => {
    window.discotech
      .watchOpenFiles(project, fileTabs.map((t) => t.path))
      .catch((e) => toast.error('Не удалось следить за открытыми файлами', { description: errorText(e) }))
  }, [project, fileTabs])

  useEffect(() => {
    if (!openRequest) return
    const dirtyPaths = dirtyRef.current
    if (openRequest.kind === 'diff') {
      // An untracked file may share a path with a staged deletion.
      const id = JSON.stringify([openRequest.worktreePath, openRequest.file.path, openRequest.file.code === '??'])
      const tab: DiffTab = { kind: 'diff', id, request: openRequest, pinned: false }
      setTabs((prev) => openPreview(prev, tab, dirtyPaths))
      setActiveId(id)
      return
    }
    if (!openRequest.path.startsWith(rootPrefix(project.rootPath))) return
    const { path, line } = openRequest
    setTabs((prev) => openPreview(prev, { kind: 'file', path, pinned: false }, dirtyPaths))
    setActiveId(path)
    setReveal(line === undefined ? null : { path, line })
  }, [openRequest, project])

  useEffect(() => {
    if (visible) onActivePathChange(activePath)
  }, [visible, activePath, onActivePathChange])

  useEffect(() => onDirtyPathsChange(project.id, dirty), [project.id, dirty, onDirtyPathsChange])
  // The area goes away with its project; its reported edits went with it.
  useEffect(() => () => onDirtyPathsChange(project.id, new Set()), [project.id, onDirtyPathsChange])

  // A mark without its tab can never be cleared: a tab disappears without a final report when
  // a moved file renames its tab or a preview tab is replaced. Keep marks on live tabs only.
  useEffect(() => {
    setDirty((prev) => {
      const next = new Set([...prev].filter((p) => fileTabs.some((t) => t.path === p)))
      return next.size === prev.size ? prev : next
    })
    setDeleted((prev) => {
      const next = new Set([...prev].filter((p) => fileTabs.some((t) => t.path === p)))
      return next.size === prev.size ? prev : next
    })
  }, [fileTabs])

  useEffect(() => {
    if (!pathNotice) return
    if (pathNotice.kind === 'moved') {
      const follow = (p: string): string => {
        const move = pathNotice.moves.find((m) => p === m.from || p.startsWith(m.from + '/'))
        return move ? move.to + p.slice(move.from.length) : p
      }
      setDeleted((prev) => new Set([...prev].filter((p) => follow(p) === p)))
      setTabs((prev) => prev.map((t) => t.kind === 'file' ? { ...t, path: follow(t.path) } : t))
      if (lastActiveFile.current !== null) lastActiveFile.current = follow(lastActiveFile.current)
      if (activePath !== null) setActiveId(follow(activePath))
      return
    }
    const under = (p: string): boolean => pathNotice.paths.some((root) => p === root || p.startsWith(root + '/'))
    setDeleted((prev) => new Set([...prev].filter((p) => !under(p))))
    const rest = tabs.filter((t) => !under(t.kind === 'file' ? t.path : t.request.worktreePath))
    setTabs(rest)
    if (activeId !== null && !rest.some((tab) => tabId(tab) === activeId)) {
      setActiveId(rest.length > 0 ? tabId(rest[rest.length - 1]) : null)
    }
    // Runs once per notice; tabs and selection are read as they are when it arrives.
  }, [pathNotice])

  const onDirtyChange = useCallback((path: string, isDirty: boolean, edited = isDirty) => {
    setDirty((prev) => {
      if (prev.has(path) === isDirty) return prev
      const next = new Set(prev)
      if (isDirty) next.add(path)
      else next.delete(path)
      return next
    })
    if (edited) setTabs((prev) => prev.map((t) => (t.kind === 'file' && t.path === path && !t.pinned ? { ...t, pinned: true } : t)))
  }, [])

  const onDeletedChange = useCallback((path: string, isDeleted: boolean) => {
    setDeleted((prev) => {
      if (prev.has(path) === isDeleted) return prev
      const next = new Set(prev)
      if (isDeleted) next.add(path)
      else next.delete(path)
      return next
    })
  }, [])

  const onLineRevealed = useCallback(() => setReveal(null), [])

  // A file saved under another name opens in a tab of its own.
  const onSavedAs = useCallback((path: string) => {
    setTabs((prev) => (prev.some((t) => tabId(t) === path) ? prev : [...prev, { kind: 'file', path, pinned: true }]))
    setActiveId(path)
  }, [])

  const onOrphanTextChange = useCallback((path: string, text: string | null) => {
    setTabs((prev) => {
      const tab = prev.find((t): t is FileTab => t.kind === 'file' && t.path === path)
      if (!tab || (tab.orphanText ?? null) === text) return prev
      return prev.map((t) => {
        if (t.kind !== 'file' || t.path !== path) return t
        if (text !== null) return { ...t, orphanText: text }
        const { orphanText: _dropped, ...rest } = t
        return rest
      })
    })
  }, [])

  const closeTab = async (id: string): Promise<void> => {
    const index = tabs.findIndex((tab) => tabId(tab) === id)
    const tab = tabs[index]
    if (!tab) return
    // A gone file's text lives only in its tab.
    const orphan = tab.kind === 'file' && tab.orphanText !== undefined
    if (
      tab.kind === 'file' && (dirty.has(tab.path) || orphan) &&
      !(await confirmDialog({
        title: `Закрыть «${baseName(tab.path)}»?`,
        description: orphan
          ? 'Файла больше нет на прежнем месте, его текст есть только в этой вкладке и пропадёт.'
          : 'Есть несохранённые правки, они пропадут.',
        confirmLabel: 'Закрыть без сохранения',
        destructive: true
      }))
    ) {
      return
    }
    const rest = tabs.filter((t) => tabId(t) !== id)
    setTabs(rest)
    if (tab.kind === 'file') {
      onDirtyChange(tab.path, false)
      onDeletedChange(tab.path, false)
    }
    const neighbor = rest[Math.min(index, rest.length - 1)]
    if (activeId === id) setActiveId(neighbor ? tabId(neighbor) : null)
  }

  const closeOtherTabs = async (id: string): Promise<void> => {
    const others = tabs.filter((tab) => tabId(tab) !== id)
    const unsaved = others.filter((tab): tab is FileTab => tab.kind === 'file' && hasTextToKeep(tab, dirty))
    if (
      unsaved.length > 0 &&
      !(await confirmDialog({
        title: 'Закрыть остальные вкладки?',
        description: `Несохранённый текст пропадёт: ${unsaved.map((tab) => `«${baseName(tab.path)}»`).join(', ')}.`,
        confirmLabel: 'Закрыть без сохранения',
        destructive: true
      }))
    ) return

    const closing = new Set(others.map(tabId))
    setTabs((prev) => prev.filter((tab) => !closing.has(tabId(tab))))
    setActiveId(id)
  }

  const activateTab = (tab: Tab): void => {
    setActiveId(tabId(tab))
    if (!tab.pinned) {
      setTabs((prev) => prev.map((t) => t === tab ? { ...tab, pinned: true } : t))
    }
  }

  // The unpinned tab becomes the preview tab; keep the previous one's only copy of text.
  const unpinTab = (id: string): void => {
    const rest = tabs.flatMap<Tab>((t) => {
      if (tabId(t) === id) return [{ ...t, pinned: false }]
      if (t.pinned) return [t]
      return t.kind === 'file' && hasTextToKeep(t, dirty) ? [{ ...t, pinned: true }] : []
    })
    setTabs(rest)
    if (activeId && !rest.some((t) => tabId(t) === activeId)) setActiveId(id)
  }

  return (
    <div className={visible ? 'editor-area' : 'editor-area hidden'}>
      <TabStrip activeIndex={tabs.findIndex((t) => tabId(t) === activeId)}>
        {tabs.map((t) => {
          const id = tabId(t)
          const isDirty = t.kind === 'file' && dirty.has(t.path)
          const path = t.kind === 'file' ? t.path : t.request.file.path
          const location = t.kind === 'diff' ? `Изменения · ${t.request.worktreePath}/${path}` : path
          const title = t.pinned ? location : `${location}\nЩелчок по вкладке закрепит её`
          return (
            <div
              key={id}
              className={`tab${id === activeId ? ' tab-active' : ''}${t.pinned ? '' : ' tab-preview'}${t.kind === 'diff' ? ' tab-diff' : ''}`}
              title={title}
              onClick={() => activateTab(t)}
              onAuxClick={(e) => e.button === 1 && void closeTab(id)}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ id, x: e.clientX, y: e.currentTarget.getBoundingClientRect().bottom })
              }}
            >
              {t.kind === 'diff' ? <GitCompare size={13} className="tab-icon" /> : <FileText size={13} className="tab-icon" />}
              <span className={`tab-title${t.kind === 'file' && deleted.has(path) ? ' tab-deleted' : ''}`}>{baseName(path)}</span>
              {t.pinned && (
                <button
                  className="tab-pin"
                  disabled={isDirty}
                  title={isDirty ? 'Вкладку с несохранёнными правками открепить нельзя' : 'Открепить. Следующая открытая вкладка заменит эту'}
                  onClick={(e) => {
                    e.stopPropagation()
                    unpinTab(id)
                  }}
                >
                  <Pin size={12} />
                </button>
              )}
              <button
                className={`tab-close${isDirty ? ' tab-close-dirty' : ''}`}
                title={isDirty ? 'Есть несохранённые правки. Закрыть' : 'Закрыть'}
                onClick={(e) => {
                  e.stopPropagation()
                  void closeTab(id)
                }}
              >
                <span className="tab-dot">●</span>
                <span className="tab-x">
                  <X size={12} />
                </span>
              </button>
            </div>
          )
        })}
      </TabStrip>
      {visible && menu && tabs.some((tab) => tabId(tab) === menu.id) && (
        <div className="menu" style={{ left: Math.min(menu.x, window.innerWidth - 204), top: menu.y }}>
          <button
            className="menu-item"
            disabled={tabs.length < 2}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => {
              setMenu(null)
              void closeOtherTabs(menu.id)
            }}
          >
            <span className="menu-label">Закрыть остальные</span>
          </button>
        </div>
      )}
      {tabs.length === 0 && <div className="empty">Откройте файл в дереве слева.</div>}
      {tabs.map((t) => t.kind === 'diff' ? (
        <GitDiffView key={t.id} request={t.request} fontSize={fontSize} active={visible && t.id === activeId} />
      ) : (
        <TabBody
          key={t.path}
          project={project}
          path={t.path}
          active={visible && t.path === activePath}
          fontSize={fontSize}
          revealLine={reveal?.path === t.path ? reveal.line : null}
          onLineRevealed={onLineRevealed}
          onDirtyChange={onDirtyChange}
          onDeletedChange={onDeletedChange}
          orphanText={t.orphanText ?? null}
          onOrphanTextChange={onOrphanTextChange}
          onSavedAs={onSavedAs}
        />
      ))}
    </div>
  )
}

function hasTextToKeep(tab: FileTab, dirty: ReadonlySet<string>): boolean {
  return dirty.has(tab.path) || tab.orphanText !== undefined
}

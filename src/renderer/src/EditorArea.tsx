import { FileText, Pin, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { PathMove, Project, SessionTab } from '../../shared/api'
import { confirmDialog } from './confirm'
import { errorText } from './errors'
import { baseName, rootPrefix } from './paths'
import { TabBody } from './TabBody'
import { TabStrip } from './TabStrip'

export type OpenRequest = { path: string; line?: number; nonce: number }

/**
 * A group of files or folders moved or deleted from the tree: tabs at or under a move follow it;
 * tabs at or under a deleted path close (files with unsaved edits are never moved or deleted).
 */
export type PathNotice =
  | { kind: 'moved'; projectId: string; moves: PathMove[]; nonce: number }
  | { kind: 'deleted'; projectId: string; paths: string[]; nonce: number }

// At most one tab is unpinned: the preview tab that the next opened file replaces.
// A tab edited by the user is pinned.
type Tab = SessionTab

type Props = {
  project: Project
  visible: boolean
  fontSize: number
  openRequest: OpenRequest | null
  pathNotice: PathNotice | null
  onActivePathChange(path: string | null): void
  onDirtyPathsChange(projectId: string, paths: ReadonlySet<string>): void
  /** Tabs open in this project when the app last ran. */
  initialTabs: { tabs: Tab[]; active: string | null } | null
  onTabsChange(projectId: string, state: { tabs: Tab[]; active: string | null }): void
}

export function EditorArea(props: Props): React.JSX.Element {
  const { project, visible, fontSize, openRequest, pathNotice, onActivePathChange, onDirtyPathsChange } = props
  const [tabs, setTabs] = useState<Tab[]>(() => props.initialTabs?.tabs ?? [])
  const [activePath, setActivePath] = useState<string | null>(() => props.initialTabs?.active ?? null)
  const { onTabsChange } = props
  useEffect(() => onTabsChange(project.id, { tabs, active: activePath }), [project.id, tabs, activePath, onTabsChange])
  const [reveal, setReveal] = useState<{ path: string; line: number } | null>(null)
  const [dirty, setDirty] = useState<Set<string>>(new Set())
  const dirtyRef = useRef(dirty)
  useEffect(() => {
    dirtyRef.current = dirty
  }, [dirty])
  const [deleted, setDeleted] = useState<Set<string>>(new Set())
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null)

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
      .watchOpenFiles(project, tabs.map((t) => t.path))
      .catch((e) => toast.error('Не удалось следить за открытыми файлами', { description: errorText(e) }))
  }, [project, tabs])

  useEffect(() => {
    if (!openRequest || !openRequest.path.startsWith(rootPrefix(project.rootPath))) return
    const { path, line } = openRequest
    const dirtyPaths = dirtyRef.current
    setTabs((prev) => {
      if (prev.some((t) => t.path === path)) return prev
      const tab: Tab = { path, pinned: false }
      const previewIndex = prev.findIndex((t) => !t.pinned)
      if (previewIndex < 0) return [...prev, tab]
      const preview = prev[previewIndex]
      if (!hasTextToKeep(preview, dirtyPaths)) return prev.map((t, i) => (i === previewIndex ? tab : t))
      return [...prev.map((t) => (t === preview ? { ...t, pinned: true } : t)), tab]
    })
    setActivePath(path)
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
      const next = new Set([...prev].filter((p) => tabs.some((t) => t.path === p)))
      return next.size === prev.size ? prev : next
    })
    setDeleted((prev) => {
      const next = new Set([...prev].filter((p) => tabs.some((t) => t.path === p)))
      return next.size === prev.size ? prev : next
    })
  }, [tabs])

  useEffect(() => {
    if (!pathNotice) return
    if (pathNotice.kind === 'moved') {
      const follow = (p: string): string => {
        const move = pathNotice.moves.find((m) => p === m.from || p.startsWith(m.from + '/'))
        return move ? move.to + p.slice(move.from.length) : p
      }
      setDeleted((prev) => new Set([...prev].filter((p) => follow(p) === p)))
      setTabs((prev) => prev.map((t) => ({ ...t, path: follow(t.path) })))
      setActivePath((prev) => (prev === null ? null : follow(prev)))
      return
    }
    const under = (p: string): boolean => pathNotice.paths.some((root) => p === root || p.startsWith(root + '/'))
    setDeleted((prev) => new Set([...prev].filter((p) => !under(p))))
    const rest = tabs.filter((t) => !under(t.path))
    setTabs(rest)
    if (activePath !== null && under(activePath)) setActivePath(rest[rest.length - 1]?.path ?? null)
    // Runs once per notice; tabs and activePath are read as they are when it arrives.
  }, [pathNotice])

  const onDirtyChange = useCallback((path: string, isDirty: boolean, edited = isDirty) => {
    setDirty((prev) => {
      if (prev.has(path) === isDirty) return prev
      const next = new Set(prev)
      if (isDirty) next.add(path)
      else next.delete(path)
      return next
    })
    if (edited) setTabs((prev) => prev.map((t) => (t.path === path && !t.pinned ? { ...t, pinned: true } : t)))
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
    setTabs((prev) => (prev.some((t) => t.path === path) ? prev : [...prev, { path, pinned: true }]))
    setActivePath(path)
  }, [])

  const onOrphanTextChange = useCallback((path: string, text: string | null) => {
    setTabs((prev) => {
      const tab = prev.find((t) => t.path === path)
      if (!tab || (tab.orphanText ?? null) === text) return prev
      return prev.map((t) => {
        if (t.path !== path) return t
        if (text !== null) return { ...t, orphanText: text }
        const { orphanText: _dropped, ...rest } = t
        return rest
      })
    })
  }, [])

  const closeTab = async (path: string): Promise<void> => {
    // A gone file's text lives only in its tab.
    const orphan = tabs.find((t) => t.path === path)?.orphanText !== undefined
    if (
      (dirty.has(path) || orphan) &&
      !(await confirmDialog({
        title: `Закрыть «${baseName(path)}»?`,
        description: orphan
          ? 'Файла больше нет на прежнем месте, его текст есть только в этой вкладке и пропадёт.'
          : 'Есть несохранённые правки, они пропадут.',
        confirmLabel: 'Закрыть без сохранения',
        destructive: true
      }))
    ) {
      return
    }
    const index = tabs.findIndex((t) => t.path === path)
    const rest = tabs.filter((t) => t.path !== path)
    setTabs(rest)
    onDirtyChange(path, false)
    onDeletedChange(path, false)
    if (activePath === path) setActivePath(rest[Math.min(index, rest.length - 1)]?.path ?? null)
  }

  const closeOtherTabs = async (path: string): Promise<void> => {
    const others = tabs.filter((tab) => tab.path !== path)
    const unsaved = others.filter((tab) => hasTextToKeep(tab, dirty))
    if (
      unsaved.length > 0 &&
      !(await confirmDialog({
        title: 'Закрыть остальные вкладки?',
        description: `Несохранённый текст пропадёт: ${unsaved.map((tab) => `«${baseName(tab.path)}»`).join(', ')}.`,
        confirmLabel: 'Закрыть без сохранения',
        destructive: true
      }))
    ) return

    const closing = new Set(others.map((tab) => tab.path))
    setTabs((prev) => prev.filter((tab) => !closing.has(tab.path)))
    setActivePath(path)
  }

  const activateTab = (path: string): void => {
    setActivePath(path)
    setTabs((prev) => prev.map((t) => (t.path === path && !t.pinned ? { ...t, pinned: true } : t)))
  }

  // The unpinned tab becomes the preview tab; keep the previous one's only copy of text.
  const unpinTab = (path: string): void => {
    const rest = tabs.flatMap((t) => {
      if (t.path === path) return [{ ...t, pinned: false }]
      if (t.pinned) return [t]
      return hasTextToKeep(t, dirty) ? [{ ...t, pinned: true }] : []
    })
    setTabs(rest)
    if (activePath && !rest.some((t) => t.path === activePath)) setActivePath(path)
  }

  return (
    <div className={visible ? 'editor-area' : 'editor-area hidden'}>
      <TabStrip activeIndex={tabs.findIndex((t) => t.path === activePath)}>
        {tabs.map((t) => {
          const isDirty = dirty.has(t.path)
          return (
            <div
              key={t.path}
              className={`tab${t.path === activePath ? ' tab-active' : ''}${t.pinned ? '' : ' tab-preview'}`}
              title={t.pinned ? t.path : `${t.path}\nЩелчок по вкладке закрепит её`}
              onClick={() => activateTab(t.path)}
              onAuxClick={(e) => e.button === 1 && void closeTab(t.path)}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ path: t.path, x: e.clientX, y: e.currentTarget.getBoundingClientRect().bottom })
              }}
            >
              <FileText size={13} className="tab-icon" />
              <span className={`tab-title${deleted.has(t.path) ? ' tab-deleted' : ''}`}>{baseName(t.path)}</span>
              {t.pinned && (
                <button
                  className="tab-pin"
                  disabled={isDirty}
                  title={isDirty ? 'Вкладку с несохранёнными правками открепить нельзя' : 'Открепить: следующий открытый файл заменит эту вкладку'}
                  onClick={(e) => {
                    e.stopPropagation()
                    unpinTab(t.path)
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
                  void closeTab(t.path)
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
      {visible && menu && tabs.some((tab) => tab.path === menu.path) && (
        <div className="menu" style={{ left: Math.min(menu.x, window.innerWidth - 204), top: menu.y }}>
          <button
            className="menu-item"
            disabled={tabs.length < 2}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => {
              setMenu(null)
              void closeOtherTabs(menu.path)
            }}
          >
            <span className="menu-label">Закрыть остальные</span>
          </button>
        </div>
      )}
      {tabs.length === 0 && <div className="empty">Откройте файл в дереве слева.</div>}
      {tabs.map((t) => (
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

function hasTextToKeep(tab: Tab, dirty: ReadonlySet<string>): boolean {
  return dirty.has(tab.path) || tab.orphanText !== undefined
}

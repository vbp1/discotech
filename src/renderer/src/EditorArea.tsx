import { FileText, Pin, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { Project, SessionTab } from '../../shared/api'
import { confirmDialog } from './confirm'
import { baseName } from './paths'
import { TabBody } from './TabBody'
import { TabStrip } from './TabStrip'

export type OpenRequest = { path: string; line?: number; nonce: number }

/**
 * A file or folder moved or deleted from the tree: tabs at or under `from` follow it to `to`;
 * tabs at or under a deleted path close (files with unsaved edits are never moved or deleted).
 */
export type PathNotice =
  | { kind: 'moved'; projectId: string; from: string; to: string; nonce: number }
  | { kind: 'deleted'; projectId: string; path: string; nonce: number }

// At most one tab is unpinned: the preview tab that the next opened file replaces.
// A tab with unsaved edits is always pinned.
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
  const [deleted, setDeleted] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!openRequest || !openRequest.path.startsWith(project.linuxPath + '/')) return
    const { path, line } = openRequest
    setTabs((prev) => {
      if (prev.some((t) => t.path === path)) return prev
      const tab: Tab = { path, pinned: false }
      const previewIndex = prev.findIndex((t) => !t.pinned)
      return previewIndex < 0 ? [...prev, tab] : prev.map((t, i) => (i === previewIndex ? tab : t))
    })
    setActivePath(path)
    setReveal(line === undefined ? null : { path, line })
  }, [openRequest, project])

  useEffect(() => {
    if (visible) onActivePathChange(activePath)
  }, [visible, activePath, onActivePathChange])

  useEffect(() => onDirtyPathsChange(project.id, dirty), [project.id, dirty, onDirtyPathsChange])

  useEffect(() => {
    if (!pathNotice) return
    const root = pathNotice.kind === 'moved' ? pathNotice.from : pathNotice.path
    const under = (p: string): boolean => p === root || p.startsWith(root + '/')
    setDeleted((prev) => new Set([...prev].filter((p) => !under(p))))
    if (pathNotice.kind === 'moved') {
      const follow = (p: string): string => (under(p) ? pathNotice.to + p.slice(root.length) : p)
      setTabs((prev) => prev.map((t) => ({ ...t, path: follow(t.path) })))
      setActivePath((prev) => (prev === null ? null : follow(prev)))
      return
    }
    const rest = tabs.filter((t) => !under(t.path))
    setTabs(rest)
    if (activePath !== null && under(activePath)) setActivePath(rest[rest.length - 1]?.path ?? null)
    // Runs once per notice; tabs and activePath are read as they are when it arrives.
  }, [pathNotice])

  const onDirtyChange = useCallback((path: string, isDirty: boolean) => {
    setDirty((prev) => {
      if (prev.has(path) === isDirty) return prev
      const next = new Set(prev)
      if (isDirty) next.add(path)
      else next.delete(path)
      return next
    })
    if (isDirty) setTabs((prev) => prev.map((t) => (t.path === path && !t.pinned ? { ...t, pinned: true } : t)))
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

  const activateTab = (path: string): void => {
    setActivePath(path)
    setTabs((prev) => prev.map((t) => (t.path === path && !t.pinned ? { ...t, pinned: true } : t)))
  }

  // The unpinned tab becomes the preview tab; the previous preview tab closes.
  const unpinTab = (path: string): void => {
    const rest = tabs.filter((t) => t.pinned || t.path === path).map((t) => (t.path === path ? { ...t, pinned: false } : t))
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
        />
      ))}
    </div>
  )
}

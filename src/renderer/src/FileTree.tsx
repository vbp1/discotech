import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronDown, ChevronRight, ClipboardPaste, Copy, File, FileSymlink, Folder, FolderOpen, FolderTree, Route, Scissors, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { DirEntry, Project, TransferMode } from '../../shared/api'
import { errorText } from './errors'
import { parentDir, relativeTo, rootPrefix } from './paths'

const RELOAD_DELAY_MS = 150
// A dragged item held over a closed folder this long opens it, to drop into a subfolder.
const DRAG_EXPAND_HOLD_MS = 1500
// Dragging this close to the top or bottom edge scrolls the tree.
const DRAG_EDGE_ZONE_PX = 48
const DRAG_MIME = 'application/x-discotech-path'

/** A file or folder marked with Copy (mode copy) or Cut (mode move), waiting for Paste. */
export type TreeClipboard = { projectId: string; path: string; mode: TransferMode }

type Menu = { x: number; y: number; path: string | null }

type DirState = { entries: DirEntry[] } | { error: string }

type Row =
  | { kind: 'entry'; entry: DirEntry; depth: number }
  | { kind: 'error'; path: string; message: string; depth: number }

type Props = {
  project: Project
  activePath: string | null
  fontSize: number
  onOpenFile(path: string): void
  clipboard: TreeClipboard | null
  onClipboardChange(clipboard: TreeClipboard | null): void
  onTransferPath(from: string, toDir: string, mode: TransferMode): Promise<string | null>
  onDeletePath(path: string): Promise<boolean>
}

export function FileTree(props: Props): React.JSX.Element {
  const { project, activePath, fontSize, onOpenFile, clipboard, onClipboardChange, onTransferPath, onDeletePath } = props
  const [dirs, setDirs] = useState<Map<string, DirState>>(new Map())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const scrollRef = useRef<HTMLDivElement>(null)
  const pendingReloads = useRef<Map<string, number>>(new Map())

  const loadDir = useCallback(
    async (path: string): Promise<void> => {
      let state: DirState
      try {
        state = { entries: await window.discotech.listDir(project, path) }
      } catch (e) {
        state = { error: errorText(e) }
      }
      setDirs((prev) => new Map(prev).set(path, state))
    },
    [project]
  )

  useEffect(() => {
    void loadDir(project.rootPath)
  }, [project, loadDir])

  // Reload a listed directory when something inside it changes on disk.
  const dirsRef = useRef(dirs)
  dirsRef.current = dirs
  useEffect(() => {
    const timers = pendingReloads.current
    const unsubscribe = window.discotech.onFsEvent((event) => {
      if (event.projectId !== project.id || event.type === 'modify') return
      const dir = parentDir(event.path)
      if (!dirsRef.current.has(dir) || timers.has(dir)) return
      timers.set(
        dir,
        window.setTimeout(() => {
          timers.delete(dir)
          void loadDir(dir)
        }, RELOAD_DELAY_MS)
      )
    })
    return () => {
      unsubscribe()
      timers.forEach((t) => window.clearTimeout(t))
      timers.clear()
    }
  }, [project, loadDir])

  // Expand the folders leading to the file opened from search or tabs.
  useEffect(() => {
    if (!activePath || !activePath.startsWith(rootPrefix(project.rootPath))) return
    const ancestors: string[] = []
    for (let dir = parentDir(activePath); dir.length > project.rootPath.length; dir = parentDir(dir)) {
      ancestors.unshift(dir)
    }
    setExpanded((prev) => {
      if (ancestors.every((a) => prev.has(a))) return prev
      return new Set([...prev, ...ancestors])
    })
    ancestors.filter((a) => !dirsRef.current.has(a)).forEach((a) => void loadDir(a))
  }, [activePath, project, loadDir])

  const rows = useMemo(() => {
    const out: Row[] = []
    const walk = (path: string, depth: number): void => {
      const state = dirs.get(path)
      if (!state) return
      if ('error' in state) {
        out.push({ kind: 'error', path, message: state.error, depth })
        return
      }
      for (const entry of state.entries) {
        out.push({ kind: 'entry', entry, depth })
        if (entry.isDir && expanded.has(entry.path)) walk(entry.path, depth + 1)
      }
    }
    walk(project.rootPath, 0)
    return out
  }, [dirs, expanded, project])

  const rowHeight = Math.round(fontSize * 1.65)
  const iconSize = Math.round(fontSize * 1.08)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 20
  })

  useEffect(() => {
    virtualizer.measure()
  }, [rowHeight, virtualizer])

  // Scroll to the active file once when it becomes active, as soon as its row is listed; later
  // changes of the list (a folder opened above it) leave the scroll position alone.
  const pendingReveal = useRef<string | null>(null)
  useEffect(() => {
    pendingReveal.current = activePath
  }, [activePath])
  useEffect(() => {
    const target = pendingReveal.current
    if (!target) return
    const index = rows.findIndex((r) => r.kind === 'entry' && r.entry.path === target)
    if (index < 0) return
    pendingReveal.current = null
    virtualizer.scrollToIndex(index, { align: 'auto' })
  }, [activePath, rows, virtualizer])

  // Drag and drop: rows move into the folder under the pointer, files into their own folder,
  // empty space into the project root. The target folder and its listed items are highlighted.
  const [dragSource, setDragSource] = useState<string | null>(null)
  const [dropDir, setDropDir] = useState<string | null>(null)
  const hold = useRef<{ path: string; timer: number } | null>(null)
  const edgeScroll = useRef<{ clientY: number; frame: number | null }>({ clientY: 0, frame: null })

  const clearHold = (): void => {
    if (hold.current) window.clearTimeout(hold.current.timer)
    hold.current = null
  }
  const stopEdgeScroll = (): void => {
    if (edgeScroll.current.frame !== null) cancelAnimationFrame(edgeScroll.current.frame)
    edgeScroll.current.frame = null
  }
  const endDrag = (): void => {
    clearHold()
    stopEdgeScroll()
    setDragSource(null)
    setDropDir(null)
  }
  useEffect(() => endDrag, [])

  const tickEdgeScroll = (): void => {
    edgeScroll.current.frame = null
    const viewport = scrollRef.current
    if (!viewport) return
    const y = edgeScroll.current.clientY - viewport.getBoundingClientRect().top
    const zone = DRAG_EDGE_ZONE_PX
    const strength = y < zone ? -(zone - y) / zone : y > viewport.clientHeight - zone ? (y - viewport.clientHeight + zone) / zone : 0
    if (strength === 0) return
    const before = viewport.scrollTop
    viewport.scrollTop += Math.sign(strength) * 1.25 + strength * 9
    if (viewport.scrollTop !== before) edgeScroll.current.frame = requestAnimationFrame(tickEdgeScroll)
  }

  const isOwnDrag = (e: React.DragEvent): boolean => e.dataTransfer.types.includes(DRAG_MIME)

  const dragOverTarget = (e: React.DragEvent, targetDir: string, closedDir: string | null): void => {
    if (!isOwnDrag(e)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    edgeScroll.current.clientY = e.clientY
    if (edgeScroll.current.frame === null) edgeScroll.current.frame = requestAnimationFrame(tickEdgeScroll)
    if (dropDir !== targetDir) setDropDir(targetDir)
    if (hold.current?.path === closedDir) return
    clearHold()
    if (closedDir) {
      hold.current = {
        path: closedDir,
        timer: window.setTimeout(() => {
          hold.current = null
          setExpanded((prev) => new Set(prev).add(closedDir))
          if (!dirsRef.current.has(closedDir)) void loadDir(closedDir)
        }, DRAG_EXPAND_HOLD_MS)
      }
    }
  }

  const dropOn = async (e: React.DragEvent, targetDir: string): Promise<void> => {
    if (!isOwnDrag(e)) return
    e.preventDefault()
    e.stopPropagation()
    const from = e.dataTransfer.getData(DRAG_MIME)
    endDrag()
    // Dropping back into the same folder, or a folder into itself, is no move.
    if (!from || parentDir(from) === targetDir || targetDir === from || targetDir.startsWith(from + '/')) return
    await transfer(from, targetDir, 'move')
  }

  /** Moves or copies, then refreshes the listed folders it touched and selects the result. */
  const transfer = async (from: string, targetDir: string, mode: TransferMode): Promise<string | null> => {
    const to = await onTransferPath(from, targetDir, mode)
    if (to === null) return null
    // Open folders that moved stay open at the new place, so their listings load there.
    const reopened =
      mode === 'move' ? [...expanded].filter((p) => p === from || p.startsWith(from + '/')).map((p) => to + p.slice(from.length)) : []
    if (mode === 'move') renameExpanded(from, to)
    const touched = [...dirsRef.current.keys()].filter(
      (d) => d === targetDir || d === to || d.startsWith(to + '/') || (mode === 'move' && d === parentDir(from))
    )
    new Set([...touched, ...reopened]).forEach((d) => void loadDir(d))
    setSelected(to)
    return to
  }

  const renameExpanded = (from: string, to: string): void => {
    setExpanded((prev) => {
      const moved = [...prev].filter((p) => p === from || p.startsWith(from + '/'))
      if (moved.length === 0) return prev
      const next = new Set([...prev].filter((p) => !moved.includes(p)))
      moved.forEach((p) => next.add(to + p.slice(from.length)))
      return next
    })
  }

  // Selection, clipboard and the actions of the toolbar, the context menu and the keyboard.
  const [selected, setSelected] = useState<string | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const ownClipboard = clipboard?.projectId === project.id ? clipboard : null

  const pasteDirFor = (path: string | null): string => {
    if (path === null) return project.rootPath
    const entry = findEntry(path)
    return entry?.isDir ? path : parentDir(path)
  }
  const findEntry = (path: string): DirEntry | undefined => {
    const state = dirs.get(parentDir(path))
    return state && 'entries' in state ? state.entries.find((e) => e.path === path) : undefined
  }

  const copy = (path: string | null, mode: TransferMode): void => {
    if (path) onClipboardChange({ projectId: project.id, path, mode })
  }
  const paste = async (path: string | null): Promise<void> => {
    if (!clipboard) return
    if (clipboard.projectId !== project.id) {
      toast.error('Вставка между проектами не поддерживается: вставьте в тот же проект, где копировали.')
      return
    }
    const to = await transfer(clipboard.path, pasteDirFor(path), clipboard.mode)
    if (to !== null && clipboard.mode === 'move') onClipboardChange(null)
  }
  const copyPathText = (text: string): void => {
    navigator.clipboard.writeText(text).then(
      () => toast.success('Путь скопирован', { description: text }),
      (error: unknown) => toast.error(`Не удалось скопировать путь: ${error instanceof Error ? error.message : String(error)}`)
    )
  }
  const remove = async (path: string | null): Promise<void> => {
    if (!path || !(await onDeletePath(path))) return
    if (dirsRef.current.has(parentDir(path))) void loadDir(parentDir(path))
    if (selected !== null && (selected === path || selected.startsWith(path + '/'))) setSelected(null)
  }

  const onTreeKey = (e: React.KeyboardEvent): void => {
    // Keys by position, not letter: with a Russian layout e.key is "с", "ч", "м". Input sent by
    // software may carry no e.code, so the virtual key code is checked too.
    const letter = e.code.startsWith('Key') ? e.code.slice(3) : String.fromCharCode(e.keyCode)
    if (e.ctrlKey && !e.altKey && !e.shiftKey && (letter === 'C' || letter === 'X' || letter === 'V')) {
      e.preventDefault()
      if (letter === 'V') void paste(selected)
      else copy(selected, letter === 'C' ? 'copy' : 'move')
    } else if (e.key === 'Delete' && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      void remove(selected)
    }
  }

  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey)
    scrollRef.current?.addEventListener('scroll', close)
    const scroller = scrollRef.current
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey)
      scroller?.removeEventListener('scroll', close)
    }
  }, [menu])

  const menuItem = (label: string, hint: string, icon: React.JSX.Element, disabled: boolean, run: () => void): React.JSX.Element => (
    <button
      className="menu-item"
      disabled={disabled}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={() => {
        setMenu(null)
        run()
      }}
    >
      {icon}
      <span className="menu-label">{label}</span>
      <span className="menu-hint">{hint}</span>
    </button>
  )

  const sourceDir = dragSource ? parentDir(dragSource) : null
  const highlightDir = dropDir !== null && dropDir !== sourceDir ? dropDir : null

  const toggleDir = (path: string): void => {
    const next = new Set(expanded)
    if (next.has(path)) {
      next.delete(path)
    } else {
      next.add(path)
      if (!dirs.has(path)) void loadDir(path)
    }
    setExpanded(next)
  }

  const toolbarButton = (title: string, icon: React.JSX.Element, disabled: boolean, run: () => void): React.JSX.Element => (
    <button className="icon-button" title={title} disabled={disabled} onClick={run}>
      {icon}
    </button>
  )

  return (
    <div className="tree-pane">
      <div className="tree-toolbar">
        {toolbarButton('Копировать (Ctrl+C)', <Copy size={15} />, !selected, () => copy(selected, 'copy'))}
        {toolbarButton('Вырезать (Ctrl+X)', <Scissors size={15} />, !selected, () => copy(selected, 'move'))}
        {toolbarButton(
          ownClipboard ? `Вставить «${ownClipboard.path.slice(ownClipboard.path.lastIndexOf('/') + 1)}» (Ctrl+V)` : 'Вставить (Ctrl+V)',
          <ClipboardPaste size={15} />,
          !ownClipboard,
          () => void paste(selected)
        )}
        {toolbarButton('Удалить (Delete)', <Trash2 size={15} />, !selected, () => void remove(selected))}
      </div>
      <div
        className={`tree${highlightDir === project.rootPath ? ' tree-drop' : ''}`}
        ref={scrollRef}
        style={{ fontSize }}
        tabIndex={0}
        onKeyDown={onTreeKey}
        onClick={(e) => {
          if (e.target === e.currentTarget) setSelected(null)
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY, path: null })
        }}
        onDragOver={(e) => dragOverTarget(e, project.rootPath, null)}
        onDrop={(e) => void dropOn(e, project.rootPath)}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            clearHold()
            stopEdgeScroll()
            setDropDir(null)
          }
        }}
      >
        {!dirs.has(project.rootPath) && <div className="tree-note">Загрузка…</div>}
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index]
            const style = {
              transform: `translateY(${item.start}px)`,
              height: rowHeight,
              paddingLeft: 8 + row.depth * Math.round(fontSize * 1.1)
            }
            if (row.kind === 'error') {
              return (
                <div key={`error:${row.path}`} className="tree-row tree-row-error" style={style} title={row.message}>
                  Не удалось открыть папку: {row.message}
                </div>
              )
            }
            const { entry } = row
            const isOpen = entry.isDir && expanded.has(entry.path)
            const rowDropDir = entry.isDir ? entry.path : parentDir(entry.path)
            return (
              <div
                key={entry.path}
                className={`tree-row${entry.path === activePath ? ' tree-row-active' : ''}${entry.path === selected ? ' tree-row-selected' : ''}${rowDropDir === highlightDir ? ' tree-row-drop' : ''}${ownClipboard?.mode === 'move' && ownClipboard.path === entry.path ? ' tree-row-cut' : ''}`}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setSelected(entry.path)
                  setMenu({ x: e.clientX, y: e.clientY, path: entry.path })
                }}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(DRAG_MIME, entry.path)
                  e.dataTransfer.effectAllowed = 'move'
                  setDragSource(entry.path)
                }}
                onDragEnd={endDrag}
                onDragOver={(e) => dragOverTarget(e, rowDropDir, entry.isDir && !isOpen ? entry.path : null)}
                onDrop={(e) => void dropOn(e, rowDropDir)}
                style={style}
                title={entry.linkError ? `Ссылка никуда не ведёт: ${entry.linkError}` : entry.path}
                onClick={() => {
                  setSelected(entry.path)
                  if (entry.isDir) toggleDir(entry.path)
                  else onOpenFile(entry.path)
                }}
              >
                <span className="tree-chevron">
                  {entry.isDir && (isOpen ? <ChevronDown size={iconSize} /> : <ChevronRight size={iconSize} />)}
                </span>
                <span className="tree-icon">
                  {entry.isDir ? (
                    isOpen ? <FolderOpen size={iconSize} /> : <Folder size={iconSize} />
                  ) : entry.isSymlink ? (
                    <FileSymlink size={iconSize} />
                  ) : (
                    <File size={iconSize} />
                  )}
                </span>
                <span
                  className={`tree-name${entry.isSymlink ? ' tree-name-link' : ''}${entry.linkError ? ' tree-name-broken' : ''}`}
                >
                  {entry.name}
                </span>
                {entry.linkError && <span className="tree-badge">битая ссылка</span>}
              </div>
            )
          })}
        </div>
      </div>
      {menu && (
        <div className="menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(e) => e.stopPropagation()}>
          {menuItem('Копировать', 'Ctrl+C', <Copy size={14} />, menu.path === null, () => copy(menu.path, 'copy'))}
          {menuItem('Вырезать', 'Ctrl+X', <Scissors size={14} />, menu.path === null, () => copy(menu.path, 'move'))}
          {menuItem('Вставить', 'Ctrl+V', <ClipboardPaste size={14} />, !ownClipboard, () => void paste(menu.path))}
          <div className="menu-separator" />
          {menuItem('Копировать путь', '', <Route size={14} />, menu.path === null, () => copyPathText(menu.path!))}
          {menuItem('Копировать путь от папки проекта', '', <FolderTree size={14} />, menu.path === null, () =>
            copyPathText(relativeTo(project.rootPath, menu.path!))
          )}
          <div className="menu-separator" />
          {menuItem('Удалить', 'Delete', <Trash2 size={14} />, menu.path === null, () => void remove(menu.path))}
        </div>
      )}
    </div>
  )
}

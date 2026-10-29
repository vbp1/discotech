import Editor, { type OnMount } from '@monaco-editor/react'
import { CodeXml, Eye, PencilLine } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { Project } from '../../shared/api'
import { confirmDialog } from './confirm'
import { errorText } from './errors'
import { HtmlPreview } from './HtmlPreview'
import { MarkdownEditor, type MarkdownEditorHandle } from './MarkdownEditor'
import { baseName, relativeTo } from './paths'
import { useColorScheme } from './useColorScheme'

type FileState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'deleted' }
  | { status: 'binary'; size: number }
  | { status: 'too-large'; size: number; limit: number }
  /** gone: nothing is at the path any more; the tab keeps the text it had. */
  | { status: 'text'; savedText: string; mtimeMs: number; realPath: string | null; gone: boolean }

type Notice =
  | { kind: 'disk-changed' }
  | { kind: 'save-conflict' }
  | { kind: 'reformatted' }

type Mode = 'code' | 'visual' | 'source' | 'preview'

type Props = {
  project: Project
  path: string
  active: boolean
  fontSize: number
  revealLine: number | null
  onLineRevealed(): void
  onDirtyChange(path: string, dirty: boolean): void
  onDeletedChange(path: string, deleted: boolean): void
  /** Text kept from the session for a file that was gone when the app last ran. */
  orphanText: string | null
  /** The text of a gone file, to keep across restarts; null when the file is in place. */
  onOrphanTextChange(path: string, text: string | null): void
}

const MARKDOWN_RE = /\.(md|markdown)$/i
const HTML_RE = /\.html?$/i
const DIRTY_CHECK_DELAY_MS = 300
const ORPHAN_SAVE_DELAY_MS = 500

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`
}

export function TabBody(props: Props): React.JSX.Element {
  const { project, path, active, fontSize } = props
  const isMarkdown = MARKDOWN_RE.test(path)
  const isHtml = HTML_RE.test(path)
  const [file, setFile] = useState<FileState>({ status: 'loading' })
  const [mode, setMode] = useState<Mode>(isMarkdown ? 'visual' : isHtml ? 'preview' : 'code')
  const [draft, setDraft] = useState('')
  // Visual mode: whether the editor content differs from the text it was loaded with,
  // and whether that text already differed from the disk.
  const [visualChanged, setVisualChanged] = useState(false)
  const [visualBaseDirty, setVisualBaseDirty] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [saving, setSaving] = useState(false)
  const markdownRef = useRef<MarkdownEditorHandle>(null)
  const monacoRef = useRef<Parameters<OnMount>[0] | null>(null)
  const scheme = useColorScheme()

  const savedText = file.status === 'text' ? file.savedText : null
  const edited = savedText !== null && (mode === 'visual' ? visualChanged || visualBaseDirty : draft !== savedText)
  const gone = file.status === 'text' && file.gone
  // A gone file's text is kept in the session; it is unsaved only until it gets there.
  const [orphanPending, setOrphanPending] = useState(false)
  const dirty = gone ? orphanPending : edited

  const applyDisk = useCallback(
    (text: string, mtimeMs: number, realPath: string | null) => {
      setFile({ status: 'text', savedText: text, mtimeMs, realPath, gone: false })
      setDraft(text)
      setVisualChanged(false)
      setVisualBaseDirty(false)
      if (mode === 'visual') markdownRef.current?.load(text)
    },
    [mode]
  )

  const fetchFile = useCallback(async () => {
    const content = await window.discotech.readFile(project, path)
    if (content.kind === 'missing') return { status: 'missing' } as const
    if (content.kind === 'binary') return { status: 'binary', size: content.size } as const
    if (content.kind === 'too-large') return { status: 'too-large', size: content.size, limit: content.limit } as const
    return { status: 'text', text: content.text, mtimeMs: content.mtimeMs, realPath: content.realPath } as const
  }, [project, path])

  const loadFromDisk = useCallback(async () => {
    try {
      const result = await fetchFile()
      if (result.status === 'text') applyDisk(result.text, result.mtimeMs, result.realPath)
      else if (result.status !== 'missing') setFile(result)
      else if (orphanText.current === null) setFile({ status: 'deleted' })
      else {
        setFile({ status: 'text', savedText: orphanText.current, mtimeMs: 0, realPath: null, gone: true })
        setDraft(orphanText.current)
      }
      setNotice(null)
    } catch (e) {
      setFile({ status: 'error', message: errorText(e) })
    }
  }, [fetchFile, applyDisk])

  const orphanText = useRef(props.orphanText)
  // Load once; later reloads come from disk events or explicit actions.
  const loadedOnce = useRef(false)
  useEffect(() => {
    if (loadedOnce.current) return
    loadedOnce.current = true
    void loadFromDisk()
  }, [loadFromDisk])

  useEffect(() => props.onDirtyChange(path, dirty), [dirty, path, props.onDirtyChange])
  useEffect(() => props.onDeletedChange(path, file.status === 'deleted' || gone), [file.status, gone, path, props.onDeletedChange])

  // Disk changes: an unchanged tab follows the disk; a tab with edits warns instead.
  // Text this tab wrote to disk: the watcher reports our own save like any other change.
  const lastWritten = useRef<string | null>(null)
  const stateRef = useRef({ file, edited })
  stateRef.current = { file, edited }
  const syncWithDisk = useCallback(async () => {
    const { file: current, edited: hasEdits } = stateRef.current
    try {
      const result = await fetchFile()
      if (result.status === 'missing') {
        // A text tab keeps its text; other views have nothing to keep.
        if (current.status !== 'text') setFile({ status: 'deleted' })
        else if (!current.gone) setFile({ ...current, gone: true })
        return
      }
      if (result.status !== 'text') return setFile(result)
      if (current.status === 'text' && result.text === current.savedText) {
        if (result.mtimeMs !== current.mtimeMs || current.gone) setFile({ ...current, mtimeMs: result.mtimeMs, gone: false })
      } else if (result.text === lastWritten.current) {
        // Our save is still being recorded; its handler sets the new state.
      } else if (!hasEdits && !(current.status === 'text' && current.gone)) {
        applyDisk(result.text, result.mtimeMs, result.realPath)
      } else {
        // A different file back at a gone tab's path: the tab keeps its text and mtime, so the
        // user chooses, and saving asks before overwriting the file.
        if (current.status === 'text' && current.gone) {
          // The tab's text now differs from the file: it counts as unsaved edits.
          setFile({ ...current, savedText: result.text, gone: false })
          setVisualBaseDirty(true)
        }
        setNotice({ kind: 'disk-changed' })
      }
    } catch (e) {
      if (hasEdits) toast.error(`«${baseName(path)}»: не удалось перечитать с диска`, { description: errorText(e) })
      else setFile({ status: 'error', message: errorText(e) })
    }
  }, [fetchFile, applyDisk])

  useEffect(() => {
    return window.discotech.onFsEvent((event) => {
      if (event.projectId !== project.id) return
      // A folder above the file moved or deleted reports only the folder.
      if (event.path === path || (event.isDir && path.startsWith(event.path + '/'))) void syncWithDisk()
    })
  }, [project, path, syncWithDisk])

  // Events are not delivered while another project is shown; catch up when the tab shows again.
  const wasActive = useRef(active)
  useEffect(() => {
    if (active && !wasActive.current && stateRef.current.file.status === 'text') void syncWithDisk()
    wasActive.current = active
  }, [active, syncWithDisk])

  const currentSource = (): string | null => (mode === 'visual' ? markdownRef.current!.source() : draft)

  // A gone file's text goes to the session, so the tab survives a restart.
  const currentText = useRef<() => string>(() => draft)
  currentText.current = () =>
    mode === 'visual' ? (markdownRef.current?.source() ?? markdownRef.current?.canonicalSource() ?? draft) : draft
  const orphanTimer = useRef<number | null>(null)
  const { onOrphanTextChange } = props
  const reportOrphan = useCallback(() => {
    if (orphanTimer.current !== null) window.clearTimeout(orphanTimer.current)
    setOrphanPending(true)
    orphanTimer.current = window.setTimeout(() => {
      orphanTimer.current = null
      const current = stateRef.current.file
      onOrphanTextChange(path, current.status === 'text' && current.gone ? currentText.current() : null)
      setOrphanPending(false)
    }, ORPHAN_SAVE_DELAY_MS)
  }, [path, onOrphanTextChange])
  useEffect(() => reportOrphan(), [gone, draft, reportOrphan])

  const save = async (overwrite: boolean): Promise<void> => {
    if (file.status !== 'text' || saving) return
    if (
      file.gone &&
      !(await confirmDialog({
        title: `Создать «${baseName(path)}» заново?`,
        description: `Файла больше нет на прежнем месте. Сохранение создаст его по пути ${relativeTo(project.linuxPath, path)}, вместе с недостающими папками.`,
        confirmLabel: 'Создать'
      }))
    ) {
      return
    }
    const source = currentSource()
    if (source === null) {
      toast.error(`«${baseName(path)}» не сохранён`, {
        description:
          'Правки нельзя вписать в файл, не тронув остальной текст. Файл на диске не изменён, правки остались здесь. Переключитесь в «Исходник» и сохраните оттуда — там файл пишется ровно как виден.'
      })
      return
    }
    setSaving(true)
    lastWritten.current = source
    try {
      const result = file.gone
        ? await window.discotech.createFile(project, path, source)
        : await window.discotech.writeFile(project, path, source, overwrite ? null : file.mtimeMs)
      if (result.status === 'conflict') {
        // Someone put a file back at this path: saving over it asks first.
        if (file.gone) setFile({ ...file, gone: false })
        setNotice({ kind: 'save-conflict' })
        return
      }
      setFile({ ...file, savedText: source, mtimeMs: result.mtimeMs, gone: false })
      setDraft(source)
      if (mode === 'visual') {
        markdownRef.current!.markSaved(source)
        setVisualChanged(false)
        setVisualBaseDirty(false)
      }
      setNotice(null)
    } catch (e) {
      toast.error(`«${baseName(path)}» не сохранён`, { description: errorText(e) })
    } finally {
      setSaving(false)
    }
  }

  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && !e.altKey && !e.shiftKey && e.code === 'KeyS') {
        e.preventDefault()
        e.stopPropagation()
        void saveRef.current(false)
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [active])

  const switchMode = (next: Mode): void => {
    if (next === mode || file.status !== 'text') return
    if (isHtml) {
      // Both HTML views show the same draft text.
    } else if (next === 'source') {
      const precise = markdownRef.current!.source()
      setDraft(precise ?? markdownRef.current!.canonicalSource())
      if (precise === null) setNotice({ kind: 'reformatted' })
    } else {
      markdownRef.current!.load(draft)
      setVisualChanged(false)
      setVisualBaseDirty(draft !== file.savedText)
      if (notice?.kind === 'reformatted') setNotice(null)
    }
    setMode(next)
  }

  // The visual editor reports every keystroke; comparing serializations is deferred.
  const dirtyTimer = useRef<number | null>(null)
  const onVisualChange = (): void => {
    if (dirtyTimer.current !== null) window.clearTimeout(dirtyTimer.current)
    dirtyTimer.current = window.setTimeout(() => {
      dirtyTimer.current = null
      setVisualChanged(markdownRef.current?.changed() ?? false)
    }, DIRTY_CHECK_DELAY_MS)
    if (gone) reportOrphan()
  }

  useEffect(() => {
    if (props.revealLine === null || file.status !== 'text') return
    // The visual view has no source lines to jump to.
    if (mode === 'visual' || mode === 'preview') return props.onLineRevealed()
    const editor = monacoRef.current
    if (!editor) return
    editor.revealLineInCenter(props.revealLine)
    editor.setPosition({ lineNumber: props.revealLine, column: 1 })
    props.onLineRevealed()
  })

  const renderNotice = (): React.JSX.Element | null => {
    if (!notice) return null
    const discard = (
      <button key="reload" onClick={() => void loadFromDisk()}>
        Загрузить с диска (мои правки пропадут)
      </button>
    )
    switch (notice.kind) {
      case 'disk-changed':
        return (
          <div className="banner banner-warn">
            <span>Файл изменился на диске, пока здесь есть несохранённые правки.</span>
            {discard}
            <button onClick={() => setNotice(null)}>Оставить мои правки</button>
          </div>
        )
      case 'save-conflict':
        return (
          <div className="banner banner-warn">
            <span>Не сохранено: файл на диске изменился после открытия.</span>
            <button onClick={() => void save(true)}>Перезаписать своими правками</button>
            {discard}
          </div>
        )
      case 'reformatted':
        return (
          <div className="banner banner-warn">
            <span>
              Правки из красивого вида не удалось вписать точечно, поэтому здесь весь файл в том виде, как его записывает
              редактор: отступы и пустые строки могли поменяться по всему документу. Сохранение запишет ровно этот текст.
            </span>
            <button onClick={() => setNotice(null)}>Понятно</button>
          </div>
        )
    }
  }

  const renderContent = (): React.JSX.Element => {
    if (file.status === 'loading') return <div className="empty">Загрузка…</div>
    if (file.status === 'error') return <div className="empty empty-error">Не удалось открыть файл: {file.message}</div>
    if (file.status === 'deleted') return <div className="empty empty-error">Файл удалён с диска.</div>
    if (file.status === 'binary') return <div className="empty">Двоичный файл ({formatSize(file.size)}), просмотр не поддерживается.</div>
    if (file.status === 'too-large')
      return (
        <div className="empty">
          Файл слишком большой: {formatSize(file.size)}, предел {formatSize(file.limit)}.
        </div>
      )
    return (
      <>
        {isMarkdown && (
          <div className={mode === 'visual' ? 'tab-pane' : 'tab-pane hidden'}>
            <MarkdownEditor ref={markdownRef} initialSource={file.savedText} fontSize={fontSize} onChange={onVisualChange} />
          </div>
        )}
        {mode === 'preview' && (
          <div className="tab-pane">
            <HtmlPreview distro={project.distro} path={path} html={draft} />
          </div>
        )}
        {mode !== 'visual' && mode !== 'preview' && (
          <div className="tab-pane">
            <Editor
              path={`file://${path}`}
              value={draft}
              theme={scheme === 'dark' ? 'vs-dark' : 'vs'}
              options={{ minimap: { enabled: false }, fontSize, scrollBeyondLastLine: false, wordWrap: 'on' }}
              onChange={(value) => setDraft(value ?? '')}
              onMount={(editor) => {
                monacoRef.current = editor
              }}
            />
          </div>
        )}
      </>
    )
  }

  return (
    <div className={active ? 'tab-body' : 'tab-body hidden'}>
      <div className="breadcrumb">
        <span className="breadcrumb-path">
          {relativeTo(project.linuxPath, path)}
          {file.status === 'text' && file.realPath && (
            <span title={file.realPath}> → {relativeTo(project.linuxPath, file.realPath)}</span>
          )}
        </span>
        {saving && <span className="breadcrumb-muted">Сохранение…</span>}
        {(edited || gone) && !saving && <span className="breadcrumb-muted">не сохранено · Ctrl+S</span>}
        {isMarkdown && file.status === 'text' && (
          <div className="mode-toggle">
            <button className={`icon-button${mode === 'source' ? ' active' : ''}`} title="Исходник" onClick={() => switchMode('source')}>
              <CodeXml size={15} />
            </button>
            <button className={`icon-button${mode === 'visual' ? ' active' : ''}`} title="Красиво" onClick={() => switchMode('visual')}>
              <PencilLine size={15} />
            </button>
          </div>
        )}
        {isHtml && file.status === 'text' && (
          <div className="mode-toggle">
            <button className={`icon-button${mode === 'source' ? ' active' : ''}`} title="Исходник" onClick={() => switchMode('source')}>
              <CodeXml size={15} />
            </button>
            <button className={`icon-button${mode === 'preview' ? ' active' : ''}`} title="Просмотр" onClick={() => switchMode('preview')}>
              <Eye size={15} />
            </button>
          </div>
        )}
      </div>
      {gone && (
        <div className="banner banner-warn">
          <span>
            Файла больше нет на этом месте: его удалили или перенесли. Здесь последний текст, который был открыт; сохранение
            (Ctrl+S) создаст файл заново.
          </span>
        </div>
      )}
      {renderNotice()}
      <div className="editor-body">{renderContent()}</div>
    </div>
  )
}

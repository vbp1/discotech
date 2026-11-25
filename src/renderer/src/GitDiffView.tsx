import Editor, { type OnMount } from '@monaco-editor/react'
import { editor as monacoEditor, Uri } from 'monaco-editor'
import { useEffect, useRef, useState } from 'react'
import type { GitChangedFile, GitFileDiff } from '../../shared/api'
import { errorText } from './errors'
import { useColorScheme } from './useColorScheme'

export type GitDiffRequest = { projectId: string; worktreePath: string; file: GitChangedFile }

type Props = {
  request: GitDiffRequest
  fontSize: number
  active: boolean
}

type InlineDiffProps = {
  original: string
  modified: string
  originalPath: string
  modifiedPath: string
  theme: string
  fontSize: number
}

function InlineDiff({ original, modified, originalPath, modifiedPath, theme, fontSize }: InlineDiffProps): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const instance = useRef<monacoEditor.IStandaloneDiffEditor | null>(null)
  useEffect(() => {
    if (!host.current) return
    const before = monacoEditor.createModel(original, undefined, Uri.parse(originalPath))
    const after = monacoEditor.createModel(modified, undefined, Uri.parse(modifiedPath))
    const widget = monacoEditor.createDiffEditor(host.current, {
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: false,
      ignoreTrimWhitespace: false,
      hideUnchangedRegions: { enabled: true },
      minimap: { enabled: false },
      scrollBeyondLastLine: false
    })
    widget.setModel({ original: before, modified: after })
    instance.current = widget
    return () => {
      widget.setModel(null)
      widget.dispose()
      before.dispose()
      after.dispose()
      instance.current = null
    }
  }, [original, modified, originalPath, modifiedPath])

  useEffect(() => {
    monacoEditor.setTheme(theme)
    instance.current?.updateOptions({ fontSize })
  }, [theme, fontSize, original, modified, originalPath, modifiedPath])

  return <div className="tab-pane" ref={host} />
}

export function GitDiffView({ request, fontSize, active }: Props): React.JSX.Element {
  const [loaded, setLoaded] = useState<{ request: GitDiffRequest; result: GitFileDiff | { kind: 'error'; message: string } } | null>(null)
  const scheme = useColorScheme()
  const { projectId, worktreePath, file } = request

  useEffect(() => {
    let current = true
    window.discotech.readGitFileDiff(request.projectId, request.worktreePath, request.file).then(
      (result) => { if (current) setLoaded({ request, result }) },
      (error: unknown) => { if (current) setLoaded({ request, result: { kind: 'error', message: errorText(error) } }) }
    )
    return () => { current = false }
  }, [request])

  const result = loaded?.request === request ? loaded.result : null
  const label = file.previousPath === null ? file.path : `${file.previousPath} → ${file.path}`
  const directory = worktreePath.startsWith('/') ? worktreePath : `/${worktreePath}`
  const modelPath = (side: string, name: string): string =>
    Uri.from({
      scheme: `discotech-git-${side}`,
      authority: projectId,
      path: `${directory}/${name}`,
      query: JSON.stringify([file.path, file.code === '??'])
    }).toString()
  const theme = scheme === 'dark' ? 'vs-dark' : 'vs'
  const editorOptions = { readOnly: true, minimap: { enabled: false }, scrollBeyondLastLine: false, fontSize }
  const singleSide = result?.kind === 'text' && result.original !== result.modified
    ? (result.original === '' ? 'added' : result.modified === '' ? 'removed' : null)
    : null
  const colorWholeFile: OnMount = (editor) => {
    const model = editor.getModel()
    if (!model) return
    // A Monaco diff on an empty model otherwise paints its synthetic first line as a change.
    editor.createDecorationsCollection([{
      range: model.getFullModelRange(),
      options: { isWholeLine: true, className: singleSide === 'added' ? 'line-insert' : 'line-delete' }
    }])
  }

  return (
    <div className={active ? 'tab-body git-diff-view' : 'tab-body git-diff-view hidden'}>
      <div className="breadcrumb" title={worktreePath}>
        <span className="breadcrumb-path" title={label}>{label}</span>
        <span className="breadcrumb-muted">Последний коммит → Файл на диске</span>
        {result?.kind === 'text' && result.original === result.modified && <span className="breadcrumb-muted">Изменений в тексте нет</span>}
      </div>
      {!result && <div className="empty">Загрузка сравнения…</div>}
      {result?.kind === 'error' && <div className="empty empty-error">Не удалось открыть сравнение. {result.message}</div>}
      {result?.kind === 'binary' && <div className="empty">Для двоичного файла нет построчного сравнения.</div>}
      {result?.kind === 'too-large' && <div className="empty">Файл превышает предел сравнения ({result.limit / 1024 / 1024} МБ).</div>}
      {result?.kind === 'unsupported' && <div className="empty">Построчное сравнение доступно для файлов.</div>}
      {result?.kind === 'text' && (
        <div className="tab-pane">
          {singleSide ? (
            <Editor
              path={modelPath('single', file.path)}
              value={singleSide === 'added' ? result.modified : result.original}
              theme={theme}
              loading="Загрузка сравнения…"
              onMount={colorWholeFile}
              options={{ ...editorOptions, lineNumbers: (line) => `${singleSide === 'added' ? '+' : '−'}${line}` }}
            />
          ) : (
            <InlineDiff
              original={result.original}
              modified={result.modified}
              originalPath={modelPath('original', file.previousPath ?? file.path)}
              modifiedPath={modelPath('modified', file.path)}
              theme={theme}
              fontSize={fontSize}
            />
          )}
        </div>
      )}
    </div>
  )
}

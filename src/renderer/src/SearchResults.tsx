import { useEffect, useState } from 'react'
import type { ContentSearchResult, NameSearchResult, Project } from '../../shared/api'
import { errorText } from './errors'
import { baseName, parentDir, relativeTo } from './paths'

export type SearchMode = 'names' | 'content'

const DEBOUNCE_MS = 250

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'names'; result: NameSearchResult }
  | { status: 'content'; result: ContentSearchResult }

type Props = {
  project: Project
  query: string
  mode: SearchMode
  fontSize: number
  onOpenFile(path: string, line?: number): void
}

export function SearchResults({ project, query, mode, fontSize, onOpenFile }: Props): React.JSX.Element {
  const [state, setState] = useState<State>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    const timer = window.setTimeout(async () => {
      try {
        const next: State =
          mode === 'names'
            ? { status: 'names', result: await window.discotech.searchNames(project, query) }
            : { status: 'content', result: await window.discotech.searchContent(project, query) }
        if (!cancelled) setState(next)
      } catch (e) {
        if (!cancelled) setState({ status: 'error', message: errorText(e) })
      }
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [project, query, mode])

  if (state.status === 'loading') return <div className="tree-note">Поиск…</div>
  if (state.status === 'error') return <div className="tree-note tree-note-error">Поиск не удался: {state.message}</div>

  const { result } = state
  const shown = state.status === 'names' ? state.result.paths.length : state.result.matches.length
  const summary =
    result.total === 0
      ? 'Ничего не найдено'
      : result.total > shown
        ? `Показаны первые ${shown} из ${result.total}`
        : `Найдено: ${result.total}`

  return (
    <div className="results" style={{ fontSize }}>
      <div className="tree-note">{summary}</div>
      {state.status === 'names'
        ? state.result.paths.map((path) => (
            <div key={path} className="result-row" title={path} onClick={() => onOpenFile(path)}>
              <span className="result-name">{baseName(path)}</span>
              <span className="result-dir">{relativeTo(project.linuxPath, parentDir(path))}</span>
            </div>
          ))
        : state.result.matches.map((m) => (
            <div
              key={`${m.path}:${m.line}`}
              className="result-row result-row-match"
              title={`${m.path}:${m.line}`}
              onClick={() => onOpenFile(m.path, m.line)}
            >
              <span className="result-dir">
                {relativeTo(project.linuxPath, m.path)}:{m.line}
              </span>
              <span className="result-text">{m.text.trim()}</span>
            </div>
          ))}
    </div>
  )
}

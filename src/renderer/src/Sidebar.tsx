import { FolderPlus, ListFilter, X } from 'lucide-react'
import { useState } from 'react'
import type { Project, TransferMode } from '../../shared/api'
import logo from './assets/logo.png'
import { FileTree, type TreeClipboard } from './FileTree'
import { SearchResults, type SearchMode } from './SearchResults'

type Props = {
  ref: React.Ref<HTMLElement>
  width: number
  fontSize: number
  projects: Project[]
  project: Project | null
  onSelectProject(id: string): void
  onAddProject(): void
  onRemoveProject(id: string): void
  onOpenFile(path: string, line?: number): void
  clipboard: TreeClipboard | null
  onClipboardChange(clipboard: TreeClipboard | null): void
  onTransferPath(project: Project, from: string, toDir: string, mode: TransferMode): Promise<string | null>
  onDeletePath(project: Project, path: string): Promise<boolean>
  activePath: string | null
}

export function Sidebar(props: Props): React.JSX.Element {
  const { projects, project } = props
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<SearchMode>('names')

  return (
    <aside className="sidebar" ref={props.ref} style={{ width: props.width }}>
      <div className="sidebar-top drag">
        <img className="app-logo" src={logo} alt="" draggable={false} />
        <span className="app-name">discotech</span>
      </div>
      <div className="sidebar-header">
        <select
          className="project-select"
          value={project?.id ?? ''}
          onChange={(e) => props.onSelectProject(e.target.value)}
          disabled={projects.length === 0}
        >
          {projects.length === 0 && <option value="">Нет проектов</option>}
          {projects.map((p) => (
            <option key={p.id} value={p.id} title={`${p.distro}: ${p.linuxPath}`}>
              {p.name}
            </option>
          ))}
        </select>
        <button className="icon-button" title="Добавить папку проекта" onClick={props.onAddProject}>
          <FolderPlus size={14} />
        </button>
        <button
          className="icon-button"
          title="Убрать проект из списка (файлы не удаляются)"
          disabled={!project}
          onClick={() => project && props.onRemoveProject(project.id)}
        >
          <X size={14} />
        </button>
      </div>
      {project && (
        <>
          <div className="search-box">
            <label className="search-input">
              <ListFilter size={14} />
              <input
              placeholder={mode === 'names' ? 'Найти файл' : 'Найти текст в файлах'}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
              />
              {query && (
                <button className="icon-button icon-button-sm" title="Очистить" onClick={() => setQuery('')}>
                  <X size={12} />
                </button>
              )}
            </label>
            <div className="segmented">
              <button className={mode === 'names' ? 'active' : ''} onClick={() => setMode('names')}>
                Имена
              </button>
              <button className={mode === 'content' ? 'active' : ''} onClick={() => setMode('content')}>
                Содержимое
              </button>
            </div>
          </div>
          {query.trim() ? (
            <SearchResults
              project={project}
              query={query.trim()}
              mode={mode}
              fontSize={props.fontSize}
              onOpenFile={props.onOpenFile}
            />
          ) : (
            <FileTree
              key={project.id}
              project={project}
              fontSize={props.fontSize}
              activePath={props.activePath}
              onOpenFile={props.onOpenFile}
              clipboard={props.clipboard}
              onClipboardChange={props.onClipboardChange}
              onTransferPath={(from, toDir, mode) => props.onTransferPath(project, from, toDir, mode)}
              onDeletePath={(path) => props.onDeletePath(project, path)}
            />
          )}
        </>
      )}
    </aside>
  )
}

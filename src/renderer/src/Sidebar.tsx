import { ChevronDown, ChevronRight, FolderPlus, GitBranch, ListFilter, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import type { GitChangedFile, GitWorktree, PathMove, Project, TransferMode } from '../../shared/api'
import logo from './assets/logo.png'
import { projectLocation } from './paths'
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
  onTransferPaths(project: Project, paths: string[], toDir: string, mode: TransferMode): Promise<PathMove[]>
  onDeletePaths(project: Project, paths: string[]): Promise<boolean>
  activePath: string | null
  worktrees: GitWorktree[]
  gitError: string | null
  showWorktrees: boolean
  selectedWorktreePath: string | null
  expandedWorktree: boolean
  changedFiles: GitChangedFile[] | null
  removingWorktree: boolean
  onShowFiles(): void
  onSelectWorktree(path: string | null, expanded: boolean): void
  onOpenChangedFile(file: GitChangedFile): void
  onRemoveWorktree(tree: GitWorktree): void
}

export function Sidebar(props: Props): React.JSX.Element {
  const { projects, project } = props
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<SearchMode>('names')
  const selectedWorktree = props.worktrees.find((tree) => tree.path === props.selectedWorktreePath)

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
            <option key={p.id} value={p.id} title={projectLocation(p)}>
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
          {(props.worktrees.length > 0 || props.showWorktrees) && (
            <div className="segmented sidebar-views" aria-label="Разделы проекта">
              <button className={props.showWorktrees ? '' : 'active'} aria-pressed={!props.showWorktrees} onClick={props.onShowFiles}>Файлы</button>
              <button
                className={props.showWorktrees ? 'active' : ''}
                aria-pressed={props.showWorktrees}
                onClick={() => props.onSelectWorktree(props.selectedWorktreePath, props.expandedWorktree)}
              >
                Рабочие копии
              </button>
            </div>
          )}
          {props.showWorktrees && (
            <div className="tree-pane">
              <div className="tree-toolbar">
                <button
                  className="icon-button"
                  aria-label="Удалить выбранную рабочую копию"
                  title="Удалить выбранную рабочую копию"
                  disabled={!selectedWorktree || selectedWorktree.locked || selectedWorktree.prunable || props.removingWorktree}
                  onClick={() => selectedWorktree && props.onRemoveWorktree(selectedWorktree)}
                >
                  <Trash2 size={15} />
                </button>
              </div>
              <ul className="tree worktree-list" aria-label="Рабочие копии Git" style={{ fontSize: props.fontSize }}>
                {props.worktrees.map((tree) => {
                  const expanded = tree === selectedWorktree && props.expandedWorktree
                  const disabled = tree.prunable || props.removingWorktree
                  const label = expanded ? 'Свернуть список изменений' : 'Показать изменённые файлы'
                  return (
                    <li key={tree.path}>
                      <div className="worktree-heading">
                        <button
                          className="icon-button worktree-disclosure"
                          aria-expanded={expanded}
                          aria-label={`${label} · ${tree.branch ?? tree.path}`}
                          title={label}
                          disabled={disabled}
                          onClick={() => props.onSelectWorktree(tree.path, !expanded)}
                        >
                          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                        <button
                          className="worktree-row"
                          aria-pressed={tree === selectedWorktree}
                          title={tree.path}
                          disabled={disabled}
                          onClick={() => props.onSelectWorktree(tree.path, expanded)}
                        >
                          <GitBranch size={14} />
                          <span>
                            <strong>{tree.branch ?? `HEAD ${tree.head.slice(0, 7)}`}</strong>
                            <small>{tree.path}{tree.locked ? ' · заблокирована' : tree.prunable ? ' · недоступна' : ''}</small>
                          </span>
                        </button>
                      </div>
                      {expanded && (
                        <ul className="worktree-changes" aria-label="Изменённые файлы">
                          {props.changedFiles === null ? <li className="worktree-hint">Загрузка…</li>
                            : props.changedFiles.length === 0 ? <li className="worktree-hint">Изменённых файлов нет</li>
                            : props.changedFiles.map((file) => {
                              const name = file.previousPath === null ? file.path : `${file.previousPath} → ${file.path}`
                              return (
                                <li key={file.code + file.path}>
                                  <button className="worktree-change" title={name} onClick={() => props.onOpenChangedFile(file)}>
                                    <span className="worktree-change-code" title="Статус Git">{file.code.trim()}</span>
                                    <span className="worktree-change-name" title={name}>{name}</span>
                                  </button>
                                </li>
                              )
                            })}
                        </ul>
                      )}
                    </li>
                  )
                })}
                {props.worktrees.length === 0 && <li className="worktree-hint">{props.gitError ?? 'Рабочих копий нет'}</li>}
              </ul>
            </div>
          )}
          <div className={props.showWorktrees ? 'tree-pane hidden' : 'tree-pane'}>
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
                visible={!props.showWorktrees}
                fontSize={props.fontSize}
                activePath={props.activePath}
                onOpenFile={props.onOpenFile}
                clipboard={props.clipboard}
                onClipboardChange={props.onClipboardChange}
                onTransferPaths={(paths, toDir, mode) => props.onTransferPaths(project, paths, toDir, mode)}
                onDeletePaths={(paths) => props.onDeletePaths(project, paths)}
              />
            )}
          </div>
        </>
      )}
    </aside>
  )
}

import { useEffect, useState } from 'react'
import type { GitProjectStatus } from '../../shared/api'
import { errorText } from './errors'

type Snapshot = {
  projectId: string
  path: string | null
  data: GitProjectStatus | null
  error: string | null
}

export function useGitProject(projectId: string | null, path: string | null, expanded: boolean, revision: number): {
  data: GitProjectStatus | null
  status: GitProjectStatus['status']
  changedFiles: GitProjectStatus['changedFiles']
  error: string | null
} {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)

  useEffect(() => {
    if (projectId === null) return
    let active = true
    let timer: number | undefined
    const refresh = async (): Promise<void> => {
      try {
        const data = await window.discotech.getGitProjectStatus(projectId, path, expanded)
        if (active) setSnapshot({ projectId, path, data, error: null })
      } catch (error) {
        if (active) setSnapshot({ projectId, path, data: null, error: errorText(error) })
      } finally {
        // Git metadata is outside the file tree watcher. Wait after each read to avoid overlap.
        if (active) timer = window.setTimeout(() => void refresh(), 5000)
      }
    }
    void refresh()
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [projectId, path, expanded, revision])

  const current = snapshot?.projectId === projectId ? snapshot : null
  const matching = current?.path === path ? current : null
  return {
    data: current?.data ?? null,
    status: matching?.data?.status ?? null,
    changedFiles: matching?.data?.changedFiles ?? null,
    error: matching?.error ?? null
  }
}

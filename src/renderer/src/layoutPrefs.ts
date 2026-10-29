import { useCallback, useEffect, useState } from 'react'

export type ZoomPanel = 'tree' | 'editor'

export const DEFAULT_FONT_SIZE = 13
export const MIN_FONT_SIZE = 8
export const MAX_FONT_SIZE = 32
export const DEFAULT_SIDEBAR_WIDTH = 300
export const MIN_SIDEBAR_WIDTH = 180

const STORAGE_KEY = 'discotech.layout'

type LayoutPrefs = { sidebarWidth: number; fontSize: Record<ZoomPanel, number> }

const DEFAULTS: LayoutPrefs = {
  sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
  fontSize: { tree: DEFAULT_FONT_SIZE, editor: DEFAULT_FONT_SIZE }
}

function load(): LayoutPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULTS
    const parsed = JSON.parse(raw) as Partial<LayoutPrefs>
    return { ...DEFAULTS, ...parsed, fontSize: { ...DEFAULTS.fontSize, ...parsed.fontSize } }
  } catch {
    // Layout is a per-machine convenience; unreadable storage means default layout.
    return DEFAULTS
  }
}

export function useLayoutPrefs(): {
  prefs: LayoutPrefs
  setSidebarWidth(width: number): void
  zoom(panel: ZoomPanel, step: number | 'reset'): void
} {
  const [prefs, setPrefs] = useState<LayoutPrefs>(load)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
    } catch {
      // See load(): storage is optional.
    }
  }, [prefs])

  const setSidebarWidth = useCallback((width: number) => {
    setPrefs((p) => ({ ...p, sidebarWidth: width }))
  }, [])

  const zoom = useCallback((panel: ZoomPanel, step: number | 'reset') => {
    setPrefs((p) => {
      const current = p.fontSize[panel]
      const next =
        step === 'reset' ? DEFAULT_FONT_SIZE : Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, current + step))
      return next === current ? p : { ...p, fontSize: { ...p.fontSize, [panel]: next } }
    })
  }, [])

  return { prefs, setSidebarWidth, zoom }
}

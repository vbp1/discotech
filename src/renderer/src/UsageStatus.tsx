import { RefreshCw, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProviderUsage, UsageReport, UsageWindow } from '../../shared/api'
import { ClaudeIcon, OpenAIIcon } from './providerIcons'
import { errorText } from './errors'

const REFRESH_INTERVAL_MS = 5 * 60_000
const FOCUS_REFRESH_AFTER_MS = 60_000
const TICK_MS = 30_000

type State =
  | { status: 'idle' }
  | { status: 'loading'; previous: UsageReport | null }
  | { status: 'ready'; report: UsageReport }
  | { status: 'failed'; message: string; previous: UsageReport | null }

function timeLeft(resetsAt: number | null, now: number): string {
  if (resetsAt === null) return '—'
  const minutes = Math.max(0, Math.round((resetsAt - now) / 60_000))
  if (minutes < 1) return '<1м'
  if (minutes < 60) return `${minutes}м`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}ч ${minutes % 60}м`
  return `${Math.floor(hours / 24)}д ${hours % 24}ч`
}

function resetClock(resetsAt: number | null): string {
  if (resetsAt === null) return ''
  return new Date(resetsAt).toLocaleString('ru-RU', { weekday: 'short', hour: '2-digit', minute: '2-digit' })
}

function level(percent: number): string {
  if (percent >= 90) return 'usage-high'
  if (percent >= 70) return 'usage-mid'
  return ''
}

/** The window closest to its limit decides what the status bar shows. */
function tightest(windows: UsageWindow[]): UsageWindow {
  return windows.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a))
}

type Props = { distro: string | null }

export function UsageStatus({ distro }: Props): React.JSX.Element | null {
  const [state, setState] = useState<State>({ status: 'idle' })
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(Date.now())
  const rootRef = useRef<HTMLDivElement>(null)
  const lastFetch = useRef(0)

  const report = state.status === 'ready' ? state.report : state.status === 'idle' ? null : state.previous

  const refresh = useCallback(async () => {
    if (!distro) return
    lastFetch.current = Date.now()
    setState((prev) => ({ status: 'loading', previous: prev.status === 'ready' ? prev.report : prev.status === 'idle' ? null : prev.previous }))
    try {
      const next = await window.discotech.getUsage(distro)
      setState({ status: 'ready', report: next })
    } catch (e) {
      setState((prev) => ({ status: 'failed', message: errorText(e), previous: prev.status === 'loading' ? prev.previous : null }))
    }
    setNow(Date.now())
  }, [distro])

  useEffect(() => {
    void refresh()
    const interval = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS)
    const tick = window.setInterval(() => setNow(Date.now()), TICK_MS)
    const onFocus = (): void => {
      if (Date.now() - lastFetch.current > FOCUS_REFRESH_AFTER_MS) void refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(interval)
      window.clearInterval(tick)
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!distro) return null

  const compact = (name: string, icon: React.JSX.Element, usage: ProviderUsage | undefined): React.JSX.Element => {
    if (!usage) return <span className="usage-chip status-muted" title={name}>{icon} …</span>
    if (usage.status === 'error')
      return (
        <span className="usage-chip usage-high" title={`${name}: ${usage.message}`}>
          {icon} <TriangleAlert size={12} />
        </span>
      )
    const w = tightest(usage.windows)
    return (
      <span className={`usage-chip ${level(w.usedPercent)}`} title={`${name} · ${w.label}: ${w.usedPercent}%`}>
        {icon} {Math.round(w.usedPercent)}% <span className="usage-left">{timeLeft(w.resetsAt, now)}</span>
      </span>
    )
  }

  const details = (name: string, icon: React.JSX.Element, usage: ProviderUsage): React.JSX.Element => (
    <section className="usage-provider">
      <header>
        {icon}
        <strong>{name}</strong>
        {usage.status === 'ok' && usage.plan && <span className="usage-plan">{usage.plan}</span>}
      </header>
      {usage.status === 'error' ? (
        <div className="usage-error">{usage.message}</div>
      ) : (
        usage.windows.map((w) => (
          <div key={w.label} className="usage-window">
            <div className="usage-window-head">
              <span>{w.label}</span>
              <span className={level(w.usedPercent)}>{Math.round(w.usedPercent)}%</span>
            </div>
            <div className="usage-bar">
              <div className={`usage-bar-fill ${level(w.usedPercent)}`} style={{ width: `${Math.min(100, w.usedPercent)}%` }} />
            </div>
            <div className="usage-reset">
              сброс через {timeLeft(w.resetsAt, now)}
              {w.resetsAt !== null && ` (${resetClock(w.resetsAt)})`}
            </div>
          </div>
        ))
      )}
      <div className="usage-source" title={usage.source}>
        вход: {usage.source}
      </div>
    </section>
  )

  return (
    <div className="usage" ref={rootRef}>
      <button className="usage-compact" onClick={() => setOpen(!open)} title="Лимиты Claude и Codex">
        <span className="usage-used">Used</span>
        {state.status === 'failed' && !report ? (
          <span className="usage-chip usage-high" title={state.message}>
            Лимиты <TriangleAlert size={12} />
          </span>
        ) : (
          <>
            {compact('Claude', <ClaudeIcon />, report?.claude)}
            {compact('Codex', <OpenAIIcon />, report?.codex)}
          </>
        )}
      </button>
      <button className="usage-refresh" title="Обновить лимиты" disabled={state.status === 'loading'} onClick={() => void refresh()}>
        <RefreshCw size={12} className={state.status === 'loading' ? 'spin' : ''} />
      </button>
      {open && (
        <div className="usage-popup">
          {state.status === 'failed' && <div className="usage-error">Не удалось обновить: {state.message}</div>}
          {report ? (
            <>
              {details('Claude', <ClaudeIcon />, report.claude)}
              {details('Codex', <OpenAIIcon />, report.codex)}
            </>
          ) : (
            state.status !== 'failed' && <div className="status-muted">Загрузка…</div>
          )}
          <footer className="usage-footer">
            <span className="status-muted">
              {state.status === 'loading'
                ? 'Обновление…'
                : report
                  ? `Обновлено в ${new Date(Math.min(report.claude.fetchedAt, report.codex.fetchedAt)).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}, автообновление раз в 5 минут`
                  : ''}
            </span>
            <button disabled={state.status === 'loading'} onClick={() => void refresh()}>
              Обновить
            </button>
          </footer>
        </div>
      )}
    </div>
  )
}

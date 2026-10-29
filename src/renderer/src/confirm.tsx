import { useEffect, useRef, useState } from 'react'

// In-app confirmation dialog styled as Orca's (stablyai/orca, MIT, src/renderer/src/components/
// confirmation-dialog.tsx and components/ui/dialog.tsx). One dialog at a time; Escape or a click
// outside cancels.

export type ConfirmOptions = {
  title: string
  description?: string
  confirmLabel: string
  destructive?: boolean
  icon?: React.JSX.Element
}

type Request = ConfirmOptions & { resolve(ok: boolean): void }

let show: ((request: Request) => void) | null = null

/** Asks the question in the app window; resolves true when the user confirms. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  if (!show) return Promise.reject(new Error('ConfirmHost is not mounted.'))
  const open = show
  return new Promise((resolve) => open({ ...options, resolve }))
}

export function ConfirmHost(): React.JSX.Element | null {
  const [request, setRequest] = useState<Request | null>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    show = (next) =>
      setRequest((current) => {
        // A newer question replaces an open one, which counts as cancelled.
        current?.resolve(false)
        return next
      })
    return () => {
      show = null
    }
  }, [])

  useEffect(() => {
    if (!request) return
    cancelRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        finish(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  if (!request) return null
  function finish(ok: boolean): void {
    request?.resolve(ok)
    setRequest(null)
  }

  return (
    <div className="dialog-overlay" onPointerDown={(e) => e.target === e.currentTarget && finish(false)}>
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dialog-title">
        <div className={request.icon ? 'dialog-body dialog-body-icon' : 'dialog-body'}>
          {request.icon && <div className="dialog-icon">{request.icon}</div>}
          <div className="dialog-header">
            <h2 id="dialog-title" className="dialog-title">
              {request.title}
            </h2>
            {request.description && <p className="dialog-description">{request.description}</p>}
          </div>
        </div>
        <div className="dialog-footer">
          <button ref={cancelRef} className="btn btn-outline" onClick={() => finish(false)}>
            Отмена
          </button>
          <button className={request.destructive ? 'btn btn-destructive' : 'btn btn-primary'} onClick={() => finish(true)}>
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

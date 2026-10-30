import { useEffect, useState } from 'react'
import { errorText } from './errors'

type Props = { distro: string | null; path: string; html: string }

/**
 * URL under which the main process serves project files, so the page's relative links resolve:
 * wslview://wsl/<distro>/<path> for distro projects, wslview://<drive>/<path> for Windows folders.
 */
function viewUrl(distro: string | null, projectPath: string, version: number): string {
  const encoded = projectPath.split('/').map(encodeURIComponent).join('/')
  const base = distro === null ? `wslview://${projectPath.slice(0, 1).toLowerCase()}:${encoded.slice(2)}` : `wslview://wsl/${encodeURIComponent(distro)}${encoded}`
  return `${base}?v=${version}`
}

/**
 * Renders the current text as a page in an isolated frame: scripts run, but the frame has no
 * access to the app. The text is handed to the main process, which serves it at the file's URL.
 */
export function HtmlPreview({ distro, path, html }: Props): React.JSX.Element {
  const [version, setVersion] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    window.discotech.setPreviewDraft(distro, path, html).then(
      () => current && setVersion((v) => (v ?? 0) + 1),
      (e) => current && setError(errorText(e))
    )
    return () => {
      current = false
    }
  }, [distro, path, html])

  useEffect(() => () => void window.discotech.setPreviewDraft(distro, path, null), [distro, path])

  if (error) return <div className="empty empty-error">Не удалось показать страницу: {error}</div>
  if (version === null) return <div className="html-preview" />
  return (
    <iframe
      className="html-preview"
      title={path}
      sandbox="allow-scripts allow-forms allow-popups allow-modals"
      src={viewUrl(distro, path, version)}
    />
  )
}

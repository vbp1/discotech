import { CircleCheck, Info, Loader2, OctagonX, TriangleAlert } from 'lucide-react'
import { Toaster as Sonner } from 'sonner'
import { useColorScheme } from './useColorScheme'

// Pop-up notices styled as in Orca (stablyai/orca, MIT, src/renderer/src/components/ui/sonner.tsx).
export function Toaster(): React.JSX.Element {
  const scheme = useColorScheme()
  return (
    <Sonner
      theme={scheme}
      position="bottom-right"
      closeButton
      // Keeps notices above the status bar.
      offset={{ bottom: 40 }}
      toastOptions={{ className: 'toast' }}
      icons={{
        success: <CircleCheck size={16} />,
        info: <Info size={16} />,
        warning: <TriangleAlert size={16} />,
        error: <OctagonX size={16} />,
        loading: <Loader2 size={16} className="spin" />
      }}
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--foreground)',
          '--normal-border': 'var(--border)',
          '--border-radius': 'var(--radius)',
          '--width': 'min(26rem, calc(100vw - 2rem))'
        } as React.CSSProperties
      }
    />
  )
}

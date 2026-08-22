import { useState } from 'react'
import { Button } from '@ari/ui/button'
import { useTheme } from '@ari/ui/theme-provider'
import { SettingsPage } from './SettingsPage'

const APP_VERSION = '0.1.0'
const DRAFTS_PREFIX = 'ari.drafts'

interface DiagnosticsBundle {
  appVersion: string
  userAgent: string
  theme: string
}

/** Collects the renderer-reachable facts shipped in `ari-diagnostics.json`. */
export function collectDiagnostics(theme: string): DiagnosticsBundle {
  return {
    appVersion: APP_VERSION,
    userAgent: navigator.userAgent,
    theme,
  }
}

function clearCachedDrafts(): number {
  const draftKeys: string[] = []
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i)
    if (key?.startsWith(DRAFTS_PREFIX)) draftKeys.push(key)
  }
  for (const key of draftKeys) localStorage.removeItem(key)
  return draftKeys.length
}

/** Advanced settings page: diagnostics export, journal location, danger zone. */
export function AdvancedSettings() {
  const { theme } = useTheme()
  const [confirmingClear, setConfirmingClear] = useState(false)
  const [clearedCount, setClearedCount] = useState<number | null>(null)

  const exportDiagnostics = () => {
    const blob = new Blob([JSON.stringify(collectDiagnostics(theme), null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'ari-diagnostics.json'
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const handleClearDrafts = () => {
    if (!confirmingClear) {
      setConfirmingClear(true)
      return
    }
    setClearedCount(clearCachedDrafts())
    setConfirmingClear(false)
  }

  return (
    <SettingsPage
      title="Advanced"
      description="Diagnostics and maintenance tools."
    >
      <section aria-labelledby="advanced-diagnostics-heading" className="space-y-3">
        <h2 id="advanced-diagnostics-heading" className="text-sm font-medium">
          Diagnostics
        </h2>
        <p className="text-sm text-fg-muted">
          Export app version, user agent, and active theme as JSON for bug reports.
        </p>
        <Button onClick={exportDiagnostics}>Export diagnostics</Button>
      </section>

      <section aria-labelledby="advanced-journal-heading" className="space-y-3">
        <h2 id="advanced-journal-heading" className="text-sm font-medium">
          Journal location
        </h2>
        <p className="text-sm text-fg-muted">
          Session journals live under the app data directory at{' '}
          <code className="font-mono text-xs text-fg">userData/sessions</code>, one JSONL file
          per session. Copy that folder to back up or move your history.
        </p>
      </section>

      <section aria-labelledby="advanced-danger-heading" className="space-y-3">
        <h2 id="advanced-danger-heading" className="text-sm font-medium">
          Danger zone
        </h2>
        <div className="space-y-3 rounded-md border border-border bg-surface-1 p-3">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <p className="text-sm text-fg">Clear cached drafts</p>
              <p className="text-xs text-fg-muted">
                Deletes every unsent composer draft stored on this device.
              </p>
            </div>
            {confirmingClear ? (
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-xs text-fg-muted">Delete all drafts?</span>
                <Button variant="ghost" size="sm" onClick={() => setConfirmingClear(false)}>
                  Cancel
                </Button>
                <Button variant="danger" size="sm" onClick={handleClearDrafts}>
                  Confirm
                </Button>
              </div>
            ) : (
              <Button variant="danger" size="sm" onClick={handleClearDrafts}>
                Clear cached drafts
              </Button>
            )}
          </div>
          {clearedCount != null && (
            <p role="status" className="text-xs text-fg-muted">
              Cleared {clearedCount} cached {clearedCount === 1 ? 'draft' : 'drafts'}.
            </p>
          )}
        </div>
      </section>
    </SettingsPage>
  )
}

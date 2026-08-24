import { useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { SettingsUpdate } from '@ari/contracts/settings'
import { createLogger } from '@ari/shared/logger'
import { err, formatUnknownError, ok, type Result } from '@ari/shared/result'
import { Button } from '@ari/ui/button'
import { SettingsPage } from './SettingsPage'
import { useEngineSettings } from './useEngineSettings'

const log = createLogger('settings:advanced')

const APP_VERSION = '0.1.0'
const DRAFTS_PREFIX = 'ari.drafts'

interface DiagnosticsBundle {
  appVersion: string
  userAgent: string
  appearance: string
}

/** Collects the renderer-reachable facts shipped in `ari-diagnostics.json`. */
export function collectDiagnostics(appearance: string): DiagnosticsBundle {
  return {
    appVersion: APP_VERSION,
    userAgent: navigator.userAgent,
    appearance,
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

function downloadJson(text: string, filename: string): void {
  const blob = new Blob([text], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

/**
 * Loosely validates an imported bundle: JSON object with `version === 1`
 * whose sections, when present, are plain objects. Deep field validation
 * happens engine-side in `settings.update`; window bounds are device-local
 * and never imported.
 */
export function parseSettingsBundle(raw: string): Result<SettingsUpdate, string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return err('file is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return err('settings bundle must be a JSON object')
  }
  const bundle = parsed as Record<string, unknown>
  if (bundle['version'] !== 1) {
    return err(`unsupported settings version: ${String(bundle['version'])}`)
  }
  const patch: SettingsUpdate = {}
  if (bundle['appearance'] !== undefined) {
    if (!isPlainObject(bundle['appearance'])) return err('"appearance" must be an object')
    patch.appearance = bundle['appearance']
  }
  if (bundle['sessions'] !== undefined) {
    if (!isPlainObject(bundle['sessions'])) return err('"sessions" must be an object')
    patch.sessions = bundle['sessions']
  }
  if (bundle['permissions'] !== undefined) {
    if (!isPlainObject(bundle['permissions'])) return err('"permissions" must be an object')
    patch.permissions = bundle['permissions']
  }
  return ok(patch)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Advanced settings page: diagnostics + settings bundles, journal location, danger zone. */
export function AdvancedSettings() {
  const { settings, update } = useEngineSettings()
  const [confirmingClear, setConfirmingClear] = useState(false)
  const [clearedCount, setClearedCount] = useState<number | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const exportDiagnostics = () => {
    downloadJson(
      JSON.stringify(
        collectDiagnostics(document.documentElement.dataset['ariTheme'] ?? 'obsidian'),
        null,
        2,
      ),
      'ari-diagnostics.json',
    )
  }

  const exportSettings = () => {
    if (settings === null) return
    downloadJson(JSON.stringify(settings, null, 2), 'ari-settings.json')
  }

  const handleImportChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    // Reset so re-selecting the same file fires change again.
    event.target.value = ''
    if (!file) return
    const result = parseSettingsBundle(await file.text())
    if (!result.ok) {
      setImportError(result.error)
      log.warn('settings import rejected', { reason: result.error })
      return
    }
    try {
      await update(result.value)
      setImportError(null)
    } catch (error) {
      const message = formatUnknownError(error)
      setImportError(message)
      log.warn('settings import rejected', { error: message })
    }
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

      <section aria-labelledby="advanced-bundle-heading" className="space-y-3">
        <h2 id="advanced-bundle-heading" className="text-sm font-medium">
          Settings bundle
        </h2>
        <p className="text-sm text-fg-muted">
          Export appearance, session, and permission settings as a JSON bundle, or import one
          from another device. Window bounds stay local to this machine.
        </p>
        <div className="flex gap-2">
          <Button onClick={exportSettings} disabled={settings === null}>
            Export settings
          </Button>
          <Button onClick={() => fileInputRef.current?.click()}>Import settings</Button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            aria-label="Settings bundle file"
            className="hidden"
            onChange={(e) => void handleImportChange(e)}
          />
        </div>
        {importError != null && (
          <p role="alert" className="text-xs text-danger">
            Import failed: {importError}
          </p>
        )}
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

import { useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { SettingsUpdate } from '@ari/contracts/settings'
import { createLogger } from '@ari/shared/logger'
import { err, formatUnknownError, ok, type Result } from '@ari/shared/result'
import { Button } from '@ari/ui/button'
import { useAppUpdate, type AppUpdate, type AppUpdateState, type UpdatePhase } from '../updates'
import { SettingsPage } from './SettingsPage'
import { SettingsRow } from './SettingsRow'
import { SettingsSection } from './SettingsSection'
import { useEngineSettings } from './useEngineSettings'

const log = createLogger('settings:advanced')

const DRAFTS_PREFIX = 'ari.drafts'

interface DiagnosticsBundle {
  appVersion: string
  userAgent: string
  appearance: string
}

/** Collects the renderer-reachable facts shipped in `ari-diagnostics.json`. */
export function collectDiagnostics(appearance: string, appVersion: string): DiagnosticsBundle {
  return {
    appVersion,
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
  if (bundle['notifications'] !== undefined) {
    if (!isPlainObject(bundle['notifications'])) return err('"notifications" must be an object')
    patch.notifications = bundle['notifications']
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

/** One-line status for the version row. */
export function updateStatusText(state: AppUpdateState): string {
  // An error outranks the phase: a refused step (say, a download already in
  // flight) leaves the phase where it was, and the reason is what matters.
  if (state.error !== null) return state.error
  switch (state.phase) {
    case 'checking':
      return 'Checking for updates…'
    case 'current':
      return 'Up to date.'
    case 'available':
      return `Ari ${state.availableVersion} is available to download.`
    case 'downloading':
      return `Downloading Ari ${state.availableVersion ?? state.stagedVersion ?? ''}… ${state.progress ?? 0}%`
    case 'ready':
      return `Ari ${state.stagedVersion} is ready. Restart to finish installing.`
    default:
      return 'Updates download only when you ask, and install when you restart.'
  }
}

/** The single action the version row offers, which depends on how far along the update is. */
export function updateActionFor(phase: UpdatePhase): {
  label: string
  run: 'check' | 'download' | 'install'
} {
  if (phase === 'available') return { label: 'Update', run: 'download' }
  if (phase === 'ready') return { label: 'Restart', run: 'install' }
  return { label: 'Check for updates', run: 'check' }
}

/** The version row's action button, wired to whichever step comes next. */
function VersionAction({ update }: { update: AppUpdate }) {
  const action = updateActionFor(update.phase)
  const busy = update.phase === 'checking' || update.phase === 'downloading'
  return (
    <Button
      variant={action.run === 'check' ? 'secondary' : 'primary'}
      size="sm"
      loading={busy}
      disabled={busy}
      onClick={() => void update[action.run]()}
    >
      {action.label}
    </Button>
  )
}

/** Advanced settings page: version + updates, diagnostics, bundles, danger zone. */
export function AdvancedSettings() {
  const { settings, update } = useEngineSettings()
  const appUpdate = useAppUpdate()
  const [confirmingClear, setConfirmingClear] = useState(false)
  const [clearedCount, setClearedCount] = useState<number | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const exportDiagnostics = () => {
    downloadJson(
      JSON.stringify(
        collectDiagnostics(
          document.documentElement.dataset['ariTheme'] ?? 'obsidian',
          appUpdate.currentVersion ?? 'unknown',
        ),
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
    <SettingsPage title="Advanced" description="Diagnostics and maintenance tools.">
      <SettingsSection title="Version" headingId="advanced-version-heading">
        <div className="space-y-3 px-4 py-3">
          <div className="flex min-h-8 items-center justify-between gap-6">
            <div className="min-w-0">
              <p className="text-sm font-medium text-fg">
                Ari <span data-testid="app-version">{appUpdate.currentVersion ?? '…'}</span>
              </p>
              <p className="mt-0.5 text-xs leading-relaxed text-fg-muted" role="status">
                {updateStatusText(appUpdate)}
              </p>
            </div>
            <VersionAction update={appUpdate} />
          </div>
          {appUpdate.phase === 'downloading' && (
            <div
              role="progressbar"
              aria-label="Update download progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={appUpdate.progress ?? 0}
              className="h-1 w-full overflow-hidden rounded-full bg-surface-3"
            >
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-200"
                style={{ width: `${appUpdate.progress ?? 0}%` }}
              />
            </div>
          )}
        </div>
      </SettingsSection>

      <SettingsSection title="Data">
        <SettingsRow
          label="Diagnostics"
          hint="Export app version, user agent, and active theme as JSON for bug reports."
        >
          <Button size="sm" onClick={exportDiagnostics}>
            Export diagnostics
          </Button>
        </SettingsRow>
        <div className="px-4 py-3">
          <div className="flex min-h-8 items-center justify-between gap-6">
            <div className="min-w-0 max-w-lg">
              <p className="text-sm font-medium text-fg">Settings bundle</p>
              <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">
                Export appearance, session, notification, and permission settings as a JSON bundle,
                or import one from another device. Window bounds stay local to this machine.
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button size="sm" onClick={exportSettings} disabled={settings === null}>
                Export settings
              </Button>
              <Button size="sm" onClick={() => fileInputRef.current?.click()}>
                Import settings
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json,.json"
                aria-label="Settings bundle file"
                className="hidden"
                onChange={(e) => void handleImportChange(e)}
              />
            </div>
          </div>
          {importError != null && (
            <p role="alert" className="mt-2 text-xs text-danger">
              Import failed: {importError}
            </p>
          )}
        </div>
        <SettingsRow
          label="Journal location"
          hint={
            <>
              Session journals live under the app data directory at{' '}
              <code className="font-mono text-2xs text-fg">userData/sessions</code>, one JSONL file
              per session. Copy that folder to back up or move your history.
            </>
          }
        />
      </SettingsSection>

      <SettingsSection title="Danger zone" headingId="advanced-danger-heading">
        <div className="px-4 py-3">
          <div className="flex min-h-8 items-center justify-between gap-6">
            <div className="min-w-0">
              <p className="text-sm font-medium text-fg">Clear cached drafts</p>
              <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">
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
            <p role="status" className="mt-2 text-xs text-fg-muted">
              Cleared {clearedCount} cached {clearedCount === 1 ? 'draft' : 'drafts'}.
            </p>
          )}
        </div>
      </SettingsSection>
    </SettingsPage>
  )
}

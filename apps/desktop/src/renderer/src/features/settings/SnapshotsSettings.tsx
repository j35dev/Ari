import { useEffect, useState } from 'react'
import {
  defaultSnapshotShortcut,
  snapshotShortcutError,
  type Settings,
} from '@ari/contracts/settings'
import { Switch } from '@ari/ui/switch'
import { Button } from '@ari/ui/button'
import { Kbd } from '@ari/ui/kbd'
import { shortcutFromKey } from '../speech/shortcut'
import { SettingsPage } from './SettingsPage'
import { SettingsRow } from './SettingsRow'
import { SettingsSection } from './SettingsSection'
import { useEngineSettings } from './useEngineSettings'
import type { SnapshotStatus } from '../../../../shared/snapshots'

const keyLabels: Record<string, string> = {
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
  meta: 'Cmd',
  space: 'Space',
}
export function SnapshotsSettings() {
  const { settings, update } = useEngineSettings()
  const platform = /Mac/.test(navigator.platform)
    ? 'darwin'
    : /Win/.test(navigator.platform)
      ? 'win32'
      : 'linux'
  const preferences = settings?.snapshots
  const shortcut = preferences?.shortcut || defaultSnapshotShortcut(platform)
  const [status, setStatus] = useState<SnapshotStatus | null>(null)
  const [recording, setRecording] = useState(false)
  const [candidate, setCandidate] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void window.ari?.snapshots
      ?.status()
      .then(setStatus)
      .catch((reason: unknown) => setError(String(reason)))
  }, [])
  useEffect(() => {
    if (!recording) return
    let disposed = false
    let lease: string | undefined
    const bridge = window.ari?.snapshots
    void bridge?.suppress(true).catch((reason: unknown) => setError(String(reason)))
    void window.ari?.dictation?.acquire().then((token) => {
      if (disposed) void window.ari?.dictation?.release(token)
      else lease = token
    })
    const press = (event: KeyboardEvent): void => {
      event.preventDefault()
      event.stopImmediatePropagation()
      if (event.repeat) return
      if (event.key === 'Escape') {
        setRecording(false)
        setCandidate(null)
        setError(null)
        return
      }
      const result = shortcutFromKey(event, platform)
      if (!result) return
      const invalid =
        'error' in result
          ? result.error
          : snapshotShortcutError(result.shortcut, platform, settings?.speech)
      setError(invalid)
      setCandidate(invalid || 'error' in result ? null : result.shortcut)
    }
    window.addEventListener('keydown', press, true)
    return () => {
      disposed = true
      window.removeEventListener('keydown', press, true)
      if (lease) void window.ari?.dictation?.release(lease).catch(() => undefined)
      void bridge?.suppress(false).catch(() => undefined)
    }
  }, [recording, platform, settings?.speech])
  const save = async (patch: Partial<Settings['snapshots']>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await update({ snapshots: patch })
      setRecording(false)
      setCandidate(null)
      const next = await window.ari?.snapshots?.status()
      if (next) setStatus(next)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }
  const supported = status?.supported ?? platform === 'win32'
  return (
    <SettingsPage
      title="SnapShots"
      description="Bring the window you're working in straight into your draft."
      id="settings-snapshots"
    >
      <SettingsSection title="Capture">
        <SettingsRow
          label="Enable SnapShots"
          hint="Press your shortcut in any app. Ari captures that window and quietly attaches the image to your current draft, keeping you in the app you're using."
        >
          <Switch
            aria-label="Enable SnapShots"
            checked={preferences?.enabled ?? false}
            disabled={!settings || !supported || busy || recording}
            onCheckedChange={(enabled) => {
              void save({ enabled, shortcut })
            }}
          />
        </SettingsRow>
        <SettingsRow
          label="Global shortcut"
          hint={
            recording
              ? 'Press a key chord, then Save. Escape cancels.'
              : 'Choose a chord with modifiers or a function key. App commands and dictation shortcuts are reserved.'
          }
        >
          <button
            type="button"
            aria-label="Record SnapShots shortcut"
            disabled={!supported || busy || !settings}
            onClick={() => {
              setRecording(true)
              setCandidate(null)
              setError(null)
            }}
            className="flex h-8 items-center gap-1 rounded-md px-1.5 transition-colors hover:bg-fg/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          >
            {(candidate || shortcut).split('+').map((key) => (
              <Kbd key={key}>{keyLabels[key] ?? key.toUpperCase()}</Kbd>
            ))}
          </button>
          {recording ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setRecording(false)
                  setCandidate(null)
                  setError(null)
                }}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={!candidate || busy}
                onClick={() => {
                  void save({ shortcut: candidate! })
                }}
              >
                Save
              </Button>
            </>
          ) : null}
        </SettingsRow>
      </SettingsSection>
      {error || status?.error ? (
        <p role="alert" className="text-sm text-danger">
          {error || status?.error}
        </p>
      ) : null}
      {!supported ? (
        <p className="text-[13px] text-fg-subtle">
          Window capture is currently available on Windows.
        </p>
      ) : null}
      <SettingsSection title="Arrival">
        <SettingsRow
          label="Animate captures"
          hint="A preview animates over the captured app. It lands in the composer when visible, or a brief receipt on your screen. Ari respects reduced motion."
        >
          <Switch
            aria-label="Animate captures"
            checked={preferences?.animation ?? true}
            disabled={!settings || busy}
            onCheckedChange={(animation) => {
              void save({ animation })
            }}
          />
        </SettingsRow>
        <SettingsRow label="Capture sound" hint="A quiet camera click when the image arrives.">
          <Switch
            aria-label="Capture sound"
            checked={preferences?.sound ?? true}
            disabled={!settings || busy}
            onCheckedChange={(sound) => {
              void save({ sound })
            }}
          />
        </SettingsRow>
      </SettingsSection>
      <p className="text-[13px] leading-5 text-fg-subtle">
        Captures stay on this PC until you send them. If your draft has four images, the next
        capture waits for a free slot. Pending captures survive restarting Ari.
      </p>
    </SettingsPage>
  )
}

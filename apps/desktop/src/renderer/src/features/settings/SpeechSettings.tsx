import { useCallback, useEffect, useState } from 'react'
import type { SpeechModel, SpeechProgress } from '@ari/contracts/rpc'
import { defaultSpeechShortcut, speechShortcutError } from '@ari/contracts/settings'
import { Button } from '@ari/ui/button'
import { Switch } from '@ari/ui/switch'
import { rpc } from '../../lib/rpc'
import { useSpeech } from '../speech/useSpeech'
import { isShortcutModifier, shortcutFromKey } from '../speech/shortcut'
import { SettingsPage } from './SettingsPage'
import { SettingsRow } from './SettingsRow'
import { SettingsSection } from './SettingsSection'
import { useEngineSettings } from './useEngineSettings'

function sizeLabel(bytes: number): string {
  return bytes >= 1_000_000_000
    ? `${(bytes / 1_000_000_000).toFixed(1)} GB`
    : `${Math.round(bytes / 1_000_000)} MB`
}
function progressLabel(frame: SpeechProgress): string {
  if (frame.phase === 'verifying') return 'Verifying…'
  if (frame.phase === 'installing') return 'Preparing…'
  return frame.total
    ? `${Math.min(100, Math.round((frame.received / frame.total) * 100))}%`
    : 'Downloading…'
}
function inProgress(
  frame?: SpeechProgress,
): frame is SpeechProgress & { phase: 'downloading' | 'verifying' | 'installing' } {
  return Boolean(frame && ['downloading', 'verifying', 'installing'].includes(frame.phase))
}

export function SpeechSettings() {
  const { settings, update } = useEngineSettings()
  const { status, progress, refresh } = useSpeech()
  const [models, setModels] = useState<SpeechModel[]>([])
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [recordingShortcut, setRecordingShortcut] = useState(false)
  const [shortcutError, setShortcutError] = useState<string | null>(null)
  const platform = /Mac/.test(navigator.platform) ? 'darwin' : 'linux'
  const loadModels = useCallback(async () => setModels(await rpc.invoke('speech.models')), [])
  useEffect(() => {
    void loadModels().catch((reason: unknown) => setError(String(reason)))
  }, [loadModels])
  const terminal = Object.values(progress)
    .filter((frame) => !inProgress(frame))
    .map((frame) => `${frame.id}:${frame.phase}`)
    .join('|')
  useEffect(() => {
    void loadModels().catch(() => undefined)
  }, [terminal, loadModels])
  const run = async (id: string, action: () => Promise<unknown>): Promise<void> => {
    setPending(id)
    setError(null)
    try {
      await action()
      await Promise.all([loadModels(), refresh()])
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setPending(null)
    }
  }
  const select = (model: SpeechModel): void => {
    void run(model.id, async () => {
      await rpc.invoke('speech.select', { modelId: model.id })
      await update({ speech: { enabled: true } })
    })
  }
  const activePath = status.model?.installed ? status.model.installed.path : null
  const found = models.filter(
    (model) => model.installed && (model.installed.source !== 'ari' || !model.repository),
  )
  const engineProgress = progress['engine']
  const errors = Object.values(progress)
    .filter((frame) => frame.phase === 'error')
    .map((frame) => frame.error)
    .filter(Boolean)
  const shortcut = settings?.speech.shortcut || defaultSpeechShortcut(platform)
  const modelBusy = Object.entries(progress).some(
    ([id, frame]) => id !== 'engine' && inProgress(frame),
  )

  useEffect(() => {
    if (!recordingShortcut) return
    let pressedKey = false
    const press = (event: KeyboardEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      if (event.repeat) return
      if (event.key === 'Escape') {
        setRecordingShortcut(false)
        setShortcutError(null)
        return
      }
      const result = shortcutFromKey(event, platform)
      if (!result) return
      pressedKey = true
      if ('error' in result) {
        setShortcutError(result.error)
        return
      }
      setRecordingShortcut(false)
      setShortcutError(null)
      void update({ speech: { shortcut: result.shortcut } }).catch((reason: unknown) =>
        setShortcutError(reason instanceof Error ? reason.message : String(reason)),
      )
    }
    const release = (event: KeyboardEvent): void => {
      if (
        !pressedKey &&
        isShortcutModifier(event.key) &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        !event.metaKey
      )
        setShortcutError(speechShortcutError(event.key === 'Meta' ? 'meta' : 'ctrl', platform))
    }
    const cancel = (): void => setRecordingShortcut(false)
    window.addEventListener('keydown', press, true)
    window.addEventListener('keyup', release, true)
    window.addEventListener('blur', cancel)
    return () => {
      window.removeEventListener('keydown', press, true)
      window.removeEventListener('keyup', release, true)
      window.removeEventListener('blur', cancel)
    }
  }, [recordingShortcut, platform, update])

  return (
    <SettingsPage
      id="settings-speech"
      title="Speech to text"
      description="Dictate locally. Your recordings stay on this computer; models and the speech engine download only when you set them up."
    >
      {(error || status.error || errors.length > 0) && (
        <p role="alert" className="text-sm text-danger">
          {error ?? status.error ?? errors.at(-1)}
        </p>
      )}
      <SettingsSection title="Setup">
        <SettingsRow
          label="Speech engine"
          hint={
            status.engine === 'ready'
              ? 'Installed on this computer.'
              : 'A small, separate download; no model is included in Ari.'
          }
        >
          {status.engine === 'downloading' || inProgress(engineProgress) ? (
            <>
              <span role="status" className="text-xs text-fg-muted">
                {engineProgress ? progressLabel(engineProgress) : 'Downloading…'}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void run('engine', () => rpc.invoke('speech.engine.cancel'))}
              >
                Cancel
              </Button>
            </>
          ) : status.engine === 'ready' && !status.engineError ? (
            <span className="text-xs text-fg-muted">Ready</span>
          ) : !status.engineInstallable && !status.engineError ? (
            <span role="status" className="text-xs text-fg-muted">
              Checking…
            </span>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              disabled={pending === 'engine'}
              onClick={() =>
                void run(
                  'engine',
                  status.engineInstallable
                    ? () => rpc.invoke('speech.engine.download')
                    : () => Promise.resolve(),
                )
              }
            >
              {status.engineInstallable ? 'Download engine' : 'Retry'}
            </Button>
          )}
        </SettingsRow>
        <SettingsRow
          label="Active model"
          hint={
            status.model ? (
              <span title={activePath ?? undefined}>{status.model.name}</span>
            ) : (
              'Use a model found below, or download one to set it up automatically.'
            )
          }
        >
          {status.loading && (
            <span role="status" className="text-xs text-fg-muted">
              Loading…
            </span>
          )}
          <Switch
            aria-label="Enable speech to text"
            checked={status.ready || (settings?.speech.enabled ?? false)}
            disabled={!status.model}
            onCheckedChange={(enabled) =>
              void run('enabled', () => update({ speech: { enabled } }))
            }
          />
        </SettingsRow>
        <SettingsRow
          label="Hold to talk"
          hint={
            shortcutError ? (
              <span role="alert">{shortcutError}</span>
            ) : recordingShortcut ? (
              'Press a shortcut. Esc cancels.'
            ) : (
              'Choose a key with modifiers, or F1–F24 alone.'
            )
          }
        >
          <input
            aria-label="Hold-to-talk shortcut"
            readOnly
            value={shortcut}
            className="h-8 w-36 rounded-md border border-border bg-surface-0 px-2 text-xs text-fg focus:outline-none focus:ring-2 focus:ring-accent-ring"
          />
          <Button
            size="sm"
            variant="secondary"
            aria-pressed={recordingShortcut}
            onClick={() => {
              setShortcutError(null)
              setRecordingShortcut((recording) => !recording)
            }}
          >
            {recordingShortcut ? 'Cancel' : 'Record shortcut'}
          </Button>
        </SettingsRow>
      </SettingsSection>
      <SettingsSection
        title="Found on this computer"
        description="Use existing Handy and Hugging Face GGUF models in place, without another copy."
        action={
          <Button size="sm" variant="ghost" onClick={() => void run('rescan', loadModels)}>
            Rescan
          </Button>
        }
      >
        {found.length ? (
          found.map((model) => (
            <SettingsRow
              key={model.id}
              label={model.name}
              hint={`${model.installed ? (model.installed.source === 'handy' ? 'Handy' : 'Local model') : ''} · ${sizeLabel(model.size)}`}
            >
              <Button
                size="sm"
                variant="secondary"
                disabled={
                  pending !== null ||
                  (model.installed && model.installed.path === activePath && !status.error)
                }
                onClick={() => select(model)}
              >
                {model.installed && model.installed.path === activePath
                  ? status.error
                    ? 'Retry'
                    : 'Active'
                  : 'Use model'}
              </Button>
            </SettingsRow>
          ))
        ) : (
          <SettingsRow
            label="No compatible models found"
            hint="Handy’s older .bin and ONNX models cannot be used. Download a GGUF model below."
          />
        )}
      </SettingsSection>
      <SettingsSection
        title="Download a model"
        description="Downloads can be cancelled and resumed. Each finished model is checked and selected automatically."
      >
        {models
          .filter((model) => model.repository)
          .map((model) => {
            const frame = progress[model.id]
            const active = model.installed && model.installed.path === activePath
            return (
              <SettingsRow
                key={model.id}
                label={`${model.name}${model.recommended ? ' · Recommended' : ''}`}
                hint={`${sizeLabel(model.size)} · ${model.languages.length === 1 && model.languages[0] === 'en' ? 'English' : `${model.languages.length} languages`} · ${model.description}`}
              >
                {inProgress(frame) ? (
                  <>
                    <span role="status" className="text-xs text-fg-muted">
                      {progressLabel(frame)}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        void run(model.id, () => rpc.invoke('speech.cancel', { modelId: model.id }))
                      }
                    >
                      Cancel
                    </Button>
                  </>
                ) : model.installed ? (
                  <>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={pending !== null || Boolean(active && !status.error)}
                      onClick={() => select(model)}
                    >
                      {active ? (status.error ? 'Retry' : 'Active') : 'Use model'}
                    </Button>
                    {model.installed.source === 'ari' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pending !== null}
                        onClick={() =>
                          void run(model.id, () =>
                            rpc.invoke('speech.remove', { modelId: model.id }),
                          )
                        }
                      >
                        Remove
                      </Button>
                    )}
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={pending !== null || modelBusy}
                    onClick={() =>
                      void run(model.id, () => rpc.invoke('speech.download', { modelId: model.id }))
                    }
                  >
                    {model.partial ? 'Resume' : 'Download'}
                  </Button>
                )}
                {model.partial && !inProgress(frame) && (
                  <>
                    <span className="text-xs text-fg-muted">
                      {sizeLabel(model.partial.size)} saved
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending !== null}
                      onClick={() =>
                        void run(model.id, () =>
                          rpc.invoke('speech.discard', { modelId: model.id }),
                        )
                      }
                    >
                      Discard
                    </Button>
                  </>
                )}
              </SettingsRow>
            )
          })}
      </SettingsSection>
    </SettingsPage>
  )
}

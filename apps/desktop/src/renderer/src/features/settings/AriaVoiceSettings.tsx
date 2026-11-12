import { useCallback, useEffect, useState } from 'react'
import type { RpcResults } from '@ari/contracts/rpc'
import { Button } from '@ari/ui/button'
import { Switch } from '@ari/ui/switch'
import { SettingsSection } from './SettingsSection'
import { SettingsRow } from './SettingsRow'
import { useEngineSettings } from './useEngineSettings'
import { useSpeech } from '../speech/useSpeech'
import { rpc } from '../../lib/rpc'
import { progressLabel, inProgress, sizeLabel } from './SpeechSettings'

const modelId = 'kokoro-82m-v1.0'
export function AriaVoiceSettings() {
  const { settings, update } = useEngineSettings()
  const { progress } = useSpeech()
  const [voice, setVoice] = useState<RpcResults['aria.voice.status'] | null>(null)
  const [keyStatus, setKeyStatus] = useState<RpcResults['speech.groq.status'] | null>(null)
  const [key, setKey] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const refresh = useCallback(async () => {
    const [nextVoice, nextKey] = await Promise.all([
      rpc.invoke('aria.voice.status'),
      rpc.invoke('speech.groq.status'),
    ])
    setVoice(nextVoice)
    setKeyStatus(nextKey)
  }, [])
  useEffect(() => {
    void refresh().catch(() => undefined)
    const timer = setInterval(() => void refresh().catch(() => undefined), 3000)
    return () => clearInterval(timer)
  }, [refresh])
  const run = async (action: () => Promise<unknown>) => {
    setPending(true)
    setError('')
    try {
      await action()
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setPending(false)
    }
  }
  if (!settings?.experimental.ariaEnabled) return null
  const frame = progress[modelId]
  const cloud = settings.ariaVoice.engine === 'groq' || settings.speech.provider === 'groq'
  return (
    <SettingsSection
      title="Aria voice"
      description="Kokoro runs on this computer. Aria speaks short replies to hold-to-talk requests; Read aloud works on demand. Esc or holding the shortcut again stops speech."
    >
      {(error || voice?.error || progress['groq']?.error || progress['aria-voice']?.error) && (
        <p role="alert" className="text-sm text-danger">
          {error || voice?.error || progress['aria-voice']?.error || progress['groq']?.error}
        </p>
      )}
      <SettingsRow
        label="Speak replies to voice requests"
        hint="Typed messages and routine progress stay quiet."
      >
        <Switch
          aria-label="Speak Aria voice replies"
          checked={settings.ariaVoice.mode === 'voice-replies'}
          onCheckedChange={(on) =>
            void run(() => update({ ariaVoice: { mode: on ? 'voice-replies' : 'off' } }))
          }
        />
      </SettingsRow>
      <SettingsRow label="Speech output" hint="Choose independently from speech input.">
        <select
          aria-label="Aria speech output"
          value={settings.ariaVoice.engine}
          onChange={(event) =>
            void run(() =>
              update({ ariaVoice: { engine: event.target.value as 'kokoro' | 'groq' } }),
            )
          }
        >
          <option value="kokoro">Local · Kokoro</option>
          <option value="groq">Cloud · Groq</option>
        </select>
      </SettingsRow>
      <SettingsRow label="Local voice" hint="Kokoro English, Apache-2.0.">
        <select
          aria-label="Kokoro voice"
          value={settings.ariaVoice.kokoroVoice}
          onChange={(event) =>
            void run(() =>
              update({
                ariaVoice: { kokoroVoice: event.target.value as 'af_heart' | 'am_michael' },
              }),
            )
          }
        >
          <option value="af_heart">Heart</option>
          <option value="am_michael">Michael</option>
        </select>
      </SettingsRow>
      <SettingsRow
        label="Kokoro model"
        hint="360 MB download; about 675 MB RAM while loaded. Preloads when you hold Aria’s shortcut and unloads after five idle minutes."
      >
        {inProgress(frame) ? (
          <>
            <span role="status">{progressLabel(frame)}</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void run(() => rpc.invoke('speech.cancel', { modelId }))}
            >
              Cancel
            </Button>
          </>
        ) : voice?.installed ? (
          <>
            <Button
              size="sm"
              variant="secondary"
              disabled={pending}
              onClick={() => void run(() => rpc.invoke('aria.voice.warm'))}
            >
              Check speed
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => void run(() => rpc.invoke('speech.remove', { modelId }))}
            >
              Remove
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={() => void run(() => rpc.invoke('speech.download', { modelId }))}
          >
            {frame?.received ? 'Resume download' : 'Download Kokoro'}
          </Button>
        )}
        {frame?.phase === 'error' && <span role="alert">{frame.error}</span>}
        {frame && !inProgress(frame) && frame.phase !== 'complete' && frame.received > 0 && (
          <span>{sizeLabel(frame.received)} saved</span>
        )}
      </SettingsRow>
      {voice?.hardware && (
        <SettingsRow
          label="This computer"
          hint={`${voice.hardware.logicalCores} logical cores · ${voice.hardware.ramGB} GB RAM · ${voice.hardware.threads} synthesis threads · ${voice.hardware.provider === 'dml' ? 'DirectML' : voice.hardware.provider === 'coreml' ? 'CoreML' : 'CPU'} · ${voice.hardware.rtf.toFixed(2)}× real time. ${voice.hardware.slow ? 'Too slow for smooth Kokoro speech. Choose Groq.' : 'Kokoro keeps up with speech.'}`}
        />
      )}
      <SettingsRow
        label="Speech input"
        hint="Applies to Aria hold-to-talk and general dictation. Local setup stays available as fallback."
      >
        <select
          aria-label="Speech input provider"
          value={settings.speech.provider}
          onChange={(event) =>
            void run(() =>
              update({
                speech: {
                  provider: event.target.value as 'local' | 'groq',
                  ...(event.target.value === 'groq' ? { enabled: true } : {}),
                },
              }),
            )
          }
        >
          <option value="local">Local</option>
          <option value="groq">Cloud · Groq Whisper</option>
        </select>
      </SettingsRow>
      {settings.speech.provider === 'groq' && (
        <SettingsRow
          label="Groq Whisper model"
          hint="Turbo costs $0.04 per audio hour; Large v3 costs $0.111. Minimum billed request: 10 seconds."
        >
          <select
            aria-label="Groq Whisper model"
            value={settings.speech.groqModel}
            onChange={(event) =>
              void run(() =>
                update({
                  speech: {
                    groqModel: event.target.value as 'whisper-large-v3-turbo' | 'whisper-large-v3',
                  },
                }),
              )
            }
          >
            <option value="whisper-large-v3-turbo">Whisper Large v3 Turbo</option>
            <option value="whisper-large-v3">Whisper Large v3</option>
          </select>
        </SettingsRow>
      )}
      {settings.ariaVoice.engine === 'groq' && (
        <SettingsRow
          label="Groq voice"
          hint="Orpheus V1 English · $22 per million characters. Up to 200 characters per clause."
        >
          <select
            aria-label="Groq voice"
            value={settings.ariaVoice.groqVoice}
            onChange={(event) =>
              void run(() =>
                update({
                  ariaVoice: {
                    groqVoice: event.target.value as typeof settings.ariaVoice.groqVoice,
                  },
                }),
              )
            }
          >
            {['autumn', 'diana', 'hannah', 'austin', 'daniel', 'troy'].map((id) => (
              <option value={id} key={id}>
                {id[0]!.toUpperCase() + id.slice(1)}
              </option>
            ))}
          </select>
        </SettingsRow>
      )}
      <SettingsRow
        label="Groq API key"
        hint={
          keyStatus?.configured
            ? 'Saved with this computer’s encrypted key storage.'
            : 'Paste your own key. It is encrypted with Electron safeStorage and never included in settings.'
        }
      >
        <input
          type="password"
          aria-label="Groq API key"
          autoComplete="off"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          className="h-8 rounded-md border border-border bg-surface-0 px-2 text-xs"
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={pending || !key.trim() || !keyStatus?.encryptionAvailable}
          onClick={() =>
            void run(async () => {
              await rpc.invoke('speech.groq.key', { key })
              setKey('')
            })
          }
        >
          Save key
        </Button>
        {keyStatus?.configured && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void run(() => rpc.invoke('speech.groq.key', { key: null }))}
          >
            Remove key
          </Button>
        )}
      </SettingsRow>
      {cloud && (
        <SettingsRow
          label="What leaves this computer"
          hint="Groq speech input sends only your recording. Speech output sends only Aria’s short spoken line. No chat history is sent. Groq retains usage metadata; inference content is not retained by default, but reliability and abuse logs may be kept for up to 30 days. Enable Zero Data Retention in your Groq account to opt out. Missing keys or failures fall back locally with a message."
        />
      )}
    </SettingsSection>
  )
}

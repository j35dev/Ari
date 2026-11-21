import { useEffect, useRef, useState, type Ref } from 'react'
import { motion } from 'motion/react'
import type { DiscoveredModel, EndpointFlavor } from '@ari/contracts/endpoint'
import { Input } from '@ari/ui/input'
import { createLogger } from '@ari/shared/logger'
import { rpc } from '../../lib/rpc'
import { ProviderLogo } from '../composer/provider-logo'
import { ONBOARDING_LEAD_CLASS, ONBOARDING_TITLE_CLASS } from './OnboardingFrame'
import { StepFooter } from './StepFooter'
import { DrawnCheck, listItem, staggerList, useCalm } from './onboarding-motion'

const log = createLogger('onboarding:ari-core')

type PresetId = 'openrouter' | 'openai' | 'ollama'

interface Preset {
  id: PresetId
  name: string
  hint: string
  baseUrl: string
  flavor: EndpointFlavor
  keyed: boolean
  /** Picked as the default model when the endpoint serves it, in this order. */
  prefer: readonly string[]
}

export const ARI_CORE_PRESETS: readonly Preset[] = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    hint: 'Hundreds of models with one key',
    baseUrl: 'https://openrouter.ai/api/v1',
    flavor: 'openai-chat',
    keyed: true,
    prefer: ['anthropic/claude-sonnet-4.5', 'anthropic/claude-sonnet-4', 'openai/gpt-5'],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    hint: 'GPT models with an API key',
    baseUrl: 'https://api.openai.com/v1',
    flavor: 'openai-chat',
    keyed: true,
    prefer: ['gpt-5', 'gpt-4.1', 'gpt-4o'],
  },
  {
    id: 'ollama',
    name: 'Ollama',
    hint: 'Models running on this computer',
    baseUrl: 'http://localhost:11434',
    flavor: 'ollama',
    keyed: false,
    prefer: [],
  },
]

export function defaultModel(preset: Preset, models: readonly DiscoveredModel[]): string {
  return (
    preset.prefer.find((id) => models.some((model) => model.id === id)) ??
    (preset.id === 'openai' ? models.find((model) => /^gpt-/.test(model.id))?.id : undefined) ??
    models[0]!.id
  )
}

export interface AriCoreConnection {
  name: string
  models: number
}

/**
 * Ari Core on a key or a local model: the endpoint is checked with a real
 * model listing, and only saved once that listing answers.
 */
export function OnboardingAriCore({
  connection,
  onConnected,
  onBack,
  onContinue,
  headingRef,
  primaryRef,
}: {
  connection: AriCoreConnection | null
  onConnected: (connection: AriCoreConnection) => void
  onBack: () => void
  onContinue: () => void
  headingRef: Ref<HTMLHeadingElement>
  primaryRef: Ref<HTMLButtonElement>
}) {
  const calm = useCalm()
  const [ollama, setOllama] = useState<number | null>(null)
  const [presetId, setPresetId] = useState<PresetId>('openrouter')
  const [key, setKey] = useState('')
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  const preset = ARI_CORE_PRESETS.find((entry) => entry.id === presetId)!
  const presets = ARI_CORE_PRESETS.filter((entry) => entry.id !== 'ollama' || ollama !== null)

  // Ollama is offered only when it answers on this computer.
  useEffect(() => {
    alive.current = true
    const local = ARI_CORE_PRESETS.find((entry) => entry.id === 'ollama')!
    void rpc
      .invoke('endpoints.discoverModels', {
        baseUrl: local.baseUrl,
        flavor: local.flavor,
        apiKey: null,
        persist: false,
      })
      .then((result) => {
        if (alive.current && result.error === null && result.models.length > 0) {
          setOllama(result.models.length)
          setPresetId((current) => (current === 'openrouter' ? 'ollama' : current))
        }
      })
      .catch(() => undefined)
    return () => {
      alive.current = false
    }
  }, [])

  const connect = async (): Promise<void> => {
    if (checking) return
    if (preset.keyed && key.trim() === '') {
      setError(`Paste your ${preset.name} API key first.`)
      return
    }
    setChecking(true)
    setError(null)
    try {
      const apiKey = preset.keyed ? key.trim() : null
      const listing = await rpc.invoke('endpoints.discoverModels', {
        baseUrl: preset.baseUrl,
        flavor: preset.flavor,
        apiKey,
        persist: false,
      })
      if (listing.error !== null || listing.models.length === 0) {
        if (alive.current)
          setError(
            listing.error ??
              `${preset.name} answered but offered no models. Check the key’s access and try again.`,
          )
        return
      }
      await rpc.invoke('endpoints.upsert', {
        id: `ari-setup-${preset.id}`,
        name: preset.name,
        baseUrl: preset.baseUrl,
        flavor: preset.flavor,
        model: defaultModel(preset, listing.models),
        models: listing.models.map((model) => ({
          id: model.id,
          label: model.label,
          contextWindow: model.contextWindow,
          source: 'discovered' as const,
        })),
        apiKey,
        headers: {},
      })
      // A switched-off Ari Core would hide the endpoint it was just given.
      await rpc.invoke('settings.update', { ariCore: { enabled: true } })
      if (alive.current) onConnected({ name: preset.name, models: listing.models.length })
    } catch (failure) {
      log.warn('ari core setup failed', failure)
      if (alive.current) setError('Ari could not save this connection. Try again.')
    } finally {
      if (alive.current) setChecking(false)
    }
  }

  return (
    <div>
      <h2 ref={headingRef} tabIndex={-1} className={ONBOARDING_TITLE_CLASS}>
        Use an API key or a local model
      </h2>
      <p className={ONBOARDING_LEAD_CLASS}>
        Ari Core is Ari’s own agent. It works with a model provider’s key, or with models on this
        computer.
      </p>
      <motion.div
        role="radiogroup"
        aria-label="Model provider"
        className="mt-5 flex flex-col gap-0.5"
        variants={staggerList()}
        initial={calm ? false : 'hidden'}
        animate="shown"
      >
        {presets.map((entry) => {
          const selected = entry.id === presetId
          return (
            <motion.button
              key={entry.id}
              variants={listItem}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={checking || connection !== null}
              onClick={() => {
                setPresetId(entry.id)
                setError(null)
              }}
              className={`ari-onboarding-row ${selected ? 'is-selected' : ''}`}
            >
              <span className="ari-onboarding-radio" aria-hidden="true" />
              <span className="ari-onboarding-tile text-[12px] font-semibold" aria-hidden="true">
                {entry.id === 'openai' ? <ProviderLogo kind="codex" /> : entry.name.charAt(0)}
              </span>
              <span className="min-w-0 flex-1 text-left">
                <span className="block text-sm font-medium text-fg">{entry.name}</span>
                <span className="mt-px block truncate text-[12.5px] text-fg-subtle">
                  {entry.id === 'ollama' && ollama !== null
                    ? `Running on this computer · ${ollama} model${ollama === 1 ? '' : 's'}`
                    : entry.hint}
                </span>
              </span>
            </motion.button>
          )
        })}
      </motion.div>
      {connection === null && preset.keyed && (
        <div className="mt-4">
          <label htmlFor="ari-core-key" className="mb-1.5 block text-[12.5px] text-fg-muted">
            {preset.name} API key
          </label>
          <Input
            id="ari-core-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={key}
            invalid={error !== null}
            placeholder={preset.id === 'openrouter' ? 'sk-or-…' : 'sk-…'}
            onChange={(event) => {
              setKey(event.target.value)
              setError(null)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void connect()
              }
            }}
          />
          <p className="mt-1.5 text-[12px] text-fg-subtle">
            Stored encrypted on this computer. Change it anytime in Settings → Endpoints.
          </p>
        </div>
      )}
      <div className="mt-3 min-h-5" aria-live="polite">
        {error !== null && (
          <p role="alert" className="flex items-start gap-2 text-[13px] leading-5 text-fg">
            <span className="ari-status mt-[5px]" data-status="error" aria-hidden="true" />
            <span className="min-w-0 flex-1">{error}</span>
          </p>
        )}
        {connection !== null && (
          <p role="status" className="flex items-center gap-2 text-[13px] text-fg">
            <DrawnCheck />
            Connected to {connection.name} · {connection.models} model
            {connection.models === 1 ? '' : 's'}
          </p>
        )}
      </div>
      <StepFooter
        onBack={onBack}
        primaryRef={primaryRef}
        primary={
          connection === null
            ? {
                label: checking ? 'Checking…' : 'Connect',
                onClick: () => void connect(),
                loading: checking,
              }
            : { label: 'Continue', onClick: onContinue }
        }
      />
    </div>
  )
}

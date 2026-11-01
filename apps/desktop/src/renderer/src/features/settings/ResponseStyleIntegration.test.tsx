import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  defaultSettings,
  settingsSchema,
  settingsUpdateSchema,
  type Settings,
} from '@ari/contracts/settings'
import type { Message } from '@ari/contracts/message'
import { ThemeProvider } from '@ari/ui/theme-provider'
import { themePersistence } from '../../lib/theme-persistence'
import { TranscriptView } from '../transcript/TranscriptView'
import { AppearanceSettings } from './AppearanceSettings'
import { filterSettingsIndex } from './SettingsSearch'
import { useEngineSettings } from './useEngineSettings'

const backend = vi.hoisted(() => ({
  invoke: vi.fn(),
  current: null as Settings | null,
  rejectSave: false,
}))
vi.mock('../../lib/rpc', () => ({ rpc: { invoke: backend.invoke } }))

const messages: Message[] = [
  {
    id: 'm1',
    sessionId: 'session',
    turnId: 'turn',
    role: 'assistant',
    createdAt: 1000,
    parts: [
      { type: 'tool-call', callId: 'read', name: 'Read', argsJson: '{"path":"src/app.ts"}' },
      { type: 'tool-result', callId: 'read', resultJson: '"file content"', isError: false },
      { type: 'text', text: 'A finished paragraph.\n\nA response still being written' },
    ],
  },
]

function LiveConversation() {
  const { settings } = useEngineSettings()
  return (
    <TranscriptView
      sessionId="session"
      messages={messages}
      running
      responseStyle={settings?.appearance.responseStyle}
    />
  )
}
function mount() {
  return render(
    <ThemeProvider persistence={themePersistence}>
      <AppearanceSettings />
      <LiveConversation />
    </ThemeProvider>,
  )
}

beforeEach(() => {
  localStorage.clear()
  backend.current = settingsSchema.parse(defaultSettings)
  backend.rejectSave = false
  backend.invoke.mockReset()
  backend.invoke.mockImplementation(async (method: string, payload?: unknown) => {
    if (method === 'settings.get') return backend.current
    if (method === 'theme.apply') return {}
    if (method === 'settings.update') {
      if (backend.rejectSave) throw new Error('Could not save')
      const patch = settingsUpdateSchema.parse(payload)
      backend.current = settingsSchema.parse({
        ...backend.current,
        appearance: { ...backend.current!.appearance, ...patch.appearance },
      })
      return backend.current
    }
    throw new Error(`Unexpected method ${method}`)
  })
})

async function choose(label: string) {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Response style' }))
  await user.click(screen.getByRole('option', { name: label }))
}

describe('settings-to-transcript response styles', () => {
  it('updates the active stream immediately, persists the choice, and restores the original renderer', async () => {
    const { container, unmount } = mount()
    const log = screen.getByRole('log', { name: 'Conversation transcript' })
    expect(log).toHaveAttribute('data-response-style', 'default')
    expect(log.querySelector('.ari-burst')).not.toBeNull()
    const markdown = log.querySelector('.ari-md')
    const paragraph = markdown?.querySelector('p')
    for (const label of ['Flow', 'Fold', 'Margin', 'Signal', 'Default (current Ari)']) {
      await choose(label)
      const style = label.startsWith('Default') ? 'default' : label.toLowerCase()
      await waitFor(() => expect(log).toHaveAttribute('data-response-style', style))
      expect(log.querySelector('.ari-md')).toBe(markdown)
      expect(markdown?.querySelector('p')).toBe(paragraph)
      expect(markdown).toHaveAttribute('data-streaming')
      expect(container).toHaveTextContent('A response still being written')
      expect(backend.current?.appearance.responseStyle).toBe(style)
      if (style === 'default') {
        expect(log.querySelector('.ari-burst')).not.toBeNull()
        expect(log.querySelector('.ari-response-activity')).toBeNull()
      }
    }
    await choose('Fold')
    await waitFor(() => expect(log).toHaveAttribute('data-response-style', 'fold'))
    unmount()
    mount()
    await waitFor(() =>
      expect(screen.getByRole('log')).toHaveAttribute('data-response-style', 'fold'),
    )
    expect(screen.getByRole('button', { name: 'Response style' })).toHaveTextContent('Fold')
  })

  it('keeps the old presentation in every listener when saving fails', async () => {
    mount()
    await waitFor(() => expect(backend.invoke).toHaveBeenCalledWith('settings.get'))
    backend.rejectSave = true
    await choose('Margin')
    expect(await screen.findByRole('alert')).toHaveTextContent('previous style is unchanged')
    expect(screen.getByRole('log')).toHaveAttribute('data-response-style', 'default')
    expect(backend.current?.appearance.responseStyle).toBe('default')
  })

  it('does not reset a response style when the theme changes', async () => {
    mount()
    await choose('Signal')
    await waitFor(() =>
      expect(screen.getByRole('log')).toHaveAttribute('data-response-style', 'signal'),
    )
    await userEvent.setup().click(screen.getByRole('radio', { name: /Porcelain/ }))
    await waitFor(() => expect(document.documentElement.dataset['ariTheme']).toBe('porcelain'))
    await waitFor(() => expect(backend.current?.appearance.mode).toBe('porcelain'))
    expect(backend.current?.appearance.responseStyle).toBe('signal')
    expect(screen.getByRole('log')).toHaveAttribute('data-response-style', 'signal')
  })

  it.each(['response style', 'flow', 'fold', 'margin', 'signal', 'streaming'])(
    'makes the preference discoverable by searching %s',
    (query) => {
      expect(
        filterSettingsIndex(query).some(
          (entry) => entry.label === 'Response style' && entry.section === 'settings-appearance',
        ),
      ).toBe(true)
    },
  )
})

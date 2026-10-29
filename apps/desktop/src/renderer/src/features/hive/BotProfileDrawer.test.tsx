import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { Bot } from '@ari/contracts/bot'
import type { BotRoutine } from '@ari/contracts/routine'
import { ToastProvider } from '@ari/ui/toast'
import { BotProfileDrawer } from './BotProfileDrawer'

const rpcMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  subscribe: vi.fn(() => () => undefined),
}))
vi.mock('../../lib/rpc', () => ({ rpc: rpcMocks }))
const invokeMock = rpcMocks.invoke as unknown as Mock

const FORGE: Bot = {
  id: 'bot_1',
  name: 'Forge',
  emoji: '⚒️',
  character: { shape: 'gumdrop', palette: 6 },
  title: 'Builder',
  tagline: 'Hot iron. Small diffs.',
  personaMd: '# Forge',
  driverKind: 'ari-core',
  modelId: null,
  projectId: 'proj_1',
}

const ROUTINE: BotRoutine = {
  id: 'rt_1',
  botId: 'bot_1',
  prompt: 'Check the inbox',
  at: 0,
  everyMs: 1_800_000,
  enabled: true,
  consecutiveFailures: 0,
  lastOutcomeTurnId: null,
  disabledReason: null,
}

const OTHERS: Record<string, unknown> = {
  'bots.memory.get': 'Prefer small diffs.',
  'routines.list': [],
  'project.list': [{ id: 'proj_1', name: 'Demo', path: 'C:\\repos\\demo' }],
}

function answer(method: string, params: Record<string, unknown> | undefined): unknown {
  const handler = OTHERS[method]
  if (handler !== undefined) return handler
  if (method === 'bots.memory.replace') return `${String(params?.content)}\n`
  if (method === 'bots.update') {
    return { ...FORGE, personaMd: String((params?.patch as { personaMd: string }).personaMd) }
  }
  return undefined
}

function renderDrawer(bot: Bot = FORGE): void {
  render(
    <ToastProvider>
      <BotProfileDrawer bot={bot} open onClose={() => undefined} />
    </ToastProvider>,
  )
}

beforeEach(() => {
  OTHERS['routines.list'] = []
  OTHERS['project.list'] = [{ id: 'proj_1', name: 'Demo', path: 'C:\\repos\\demo' }]
  invokeMock.mockImplementation((method: string, params: Record<string, unknown>) =>
    Promise.resolve(answer(method, params)),
  )
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('BotProfileDrawer', () => {
  it('shows the persisted memory and saves edits back whole', async () => {
    const user = userEvent.setup()
    renderDrawer()
    const memory = await screen.findByLabelText("Forge's memory")
    await waitFor(() => expect(memory).toHaveValue('Prefer small diffs.'))
    await user.clear(memory)
    await user.type(memory, 'New memory')
    expect(screen.getByText('10 / 4000')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save memory' }))
    expect(invokeMock).toHaveBeenCalledWith('bots.memory.replace', {
      botId: 'bot_1',
      content: 'New memory',
    })
    expect(await screen.findByText('Memory saved')).toBeInTheDocument()
  })

  it('saves persona edits through bots.update and a fresh save keeps them', async () => {
    const user = userEvent.setup()
    renderDrawer()
    const persona = await screen.findByLabelText("Forge's persona")
    expect(persona).toHaveValue('# Forge')
    const save = screen.getByRole('button', { name: 'Save persona' })
    expect(save).toBeDisabled()
    await user.type(persona, ' — sharper')
    await user.click(save)
    expect(invokeMock).toHaveBeenCalledWith('bots.update', {
      botId: 'bot_1',
      patch: { personaMd: '# Forge — sharper' },
    })
    expect(await screen.findByText('Persona saved')).toBeInTheDocument()
    await waitFor(() => expect(save).toBeDisabled())
  })

  it("lists this bot's routines only, and can toggle and remove one", async () => {
    let enabled = true
    invokeMock.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'routines.list') return [{ ...ROUTINE, enabled }]
      if (method === 'routines.setEnabled') {
        enabled = Boolean(params.enabled)
        return undefined
      }
      return answer(method, params)
    })
    const user = userEvent.setup()
    renderDrawer()
    expect(await screen.findByText('Check the inbox')).toBeInTheDocument()
    expect(screen.queryByText('Some other bot')).not.toBeInTheDocument()
    expect(screen.getByText('every 30 min')).toBeInTheDocument()
    await user.click(screen.getByRole('switch', { name: 'Routine every 30 min' }))
    expect(invokeMock).toHaveBeenCalledWith('routines.setEnabled', {
      routineId: 'rt_1',
      enabled: false,
    })
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Routine every 30 min' })).not.toBeChecked(),
    )
    await user.click(screen.getByRole('button', { name: 'Remove routine' }))
    expect(invokeMock).toHaveBeenCalledWith('routines.remove', { routineId: 'rt_1' })
  })

  it('says when Ari paused a failing routine', async () => {
    OTHERS['routines.list'] = [
      { ...ROUTINE, id: 'rt_3', enabled: false, disabledReason: 'too many failures' },
    ]
    renderDrawer()
    expect(await screen.findByText('Ari paused this: too many failures')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Routine every 30 min' })).not.toBeChecked()
  })

  it('still shows a bot with no routines and no project', async () => {
    const bare: Bot = { ...FORGE, projectId: undefined }
    OTHERS['project.list'] = []
    renderDrawer(bare)
    expect(await screen.findByText('no project')).toBeInTheDocument()
    expect(
      await screen.findByText('No routines yet — this bot simply waits for you.'),
    ).toBeInTheDocument()
    expect(screen.getByText('ari-core')).toBeInTheDocument()
    expect(screen.getByText('default model')).toBeInTheDocument()
  })

  it('closes from the X button', async () => {
    const onClose = vi.fn()
    render(
      <ToastProvider>
        <BotProfileDrawer bot={FORGE} open onClose={onClose} />
      </ToastProvider>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledOnce()
  })
})

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteModelCatalog } from '@ari/contracts/remote'
import { SessionScreen } from './SessionScreen'

const snapshot = {
  session: {
    id: 'sess_1',
    projectId: 'proj_1',
    title: 'Fix pairing',
    driverKind: 'codex',
    modelId: 'gpt',
    permissionMode: 'ask',
    effort: null as string | null,
    status: 'idle',
    createdAt: 1,
    updatedAt: 1,
  },
  summary: { id: 'sess_1', projectId: 'proj_1', title: 'Fix pairing', updatedAt: 1 },
  seq: 0,
  messages: [],
  pendingApprovals: [],
  pendingInputs: [],
}
const catalog: RemoteModelCatalog = {
  providers: [
    {
      driverKind: 'codex',
      available: true,
      models: [{ id: 'gpt', label: 'GPT' }],
      efforts: [
        { id: 'low', label: 'Low' },
        { id: 'high', label: 'High', current: true },
      ],
      modes: [],
    },
  ],
}
const app = vi.hoisted(() => ({
  origin: 'https://phone.test',
  connection: 'connected',
  projects: [{ id: 'proj_1', name: 'Ari' }],
  catalog: null as RemoteModelCatalog | null,
  managedComputerId: null,
  refresh: vi.fn(async () => {}),
  reconnect: vi.fn(async () => {}),
  session: {
    deviceId: 'phone',
    usable: true,
    supports: vi.fn((op: string) => op !== 'events.subscribe' && op !== 'models.efforts'),
    query: vi.fn<(op: string, params: unknown) => Promise<unknown>>(),
    send: vi.fn<(command: unknown) => Promise<unknown>>(),
  },
}))
vi.mock('../../lib/app-state', () => ({ useApp: () => app }))

beforeEach(() => {
  // jsdom lays nothing out, so it has no element scrolling to call.
  Element.prototype.scrollTo = vi.fn()
  sessionStorage.clear()
  app.catalog = catalog
  snapshot.session.status = 'idle'
  app.session.query.mockResolvedValue(snapshot)
  app.session.send.mockResolvedValue({ ok: true })
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('session controls in the composer', () => {
  it('sets the effort the user picks on this session', async () => {
    render(<SessionScreen sessionId="sess_1" onBack={vi.fn()} onForked={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Effort: High' }))
    fireEvent.click(screen.getByRole('button', { name: /^Low/ }))
    await waitFor(() =>
      expect(app.session.send).toHaveBeenCalledWith({
        op: 'session.update',
        sessionId: 'sess_1',
        effort: 'low',
      }),
    )
  })

  it('sets the permission mode the user picks, even while the agent is working', async () => {
    snapshot.session.status = 'running'
    render(<SessionScreen sessionId="sess_1" onBack={vi.fn()} onForked={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Permissions: Ask' }))
    fireEvent.click(screen.getByRole('button', { name: /^Full auto/ }))
    await waitFor(() =>
      expect(app.session.send).toHaveBeenCalledWith({
        op: 'session.update',
        sessionId: 'sess_1',
        permissionMode: 'full',
      }),
    )
  })

  it('keeps the model locked while the agent is working', async () => {
    snapshot.session.status = 'running'
    render(<SessionScreen sessionId="sess_1" onBack={vi.fn()} onForked={vi.fn()} />)
    const model = await screen.findByRole('button', { name: 'Model: Codex · GPT' })
    expect((model as HTMLButtonElement).disabled).toBe(true)
  })

  it('reports a refused change instead of pretending it applied', async () => {
    app.session.send.mockRejectedValue(new Error('this provider does not offer that effort level'))
    render(<SessionScreen sessionId="sess_1" onBack={vi.fn()} onForked={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Effort: High' }))
    fireEvent.click(screen.getByRole('button', { name: /^Low/ }))
    expect((await screen.findByRole('alert')).textContent).toContain('does not offer that effort')
  })
})

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { ProjectDraft, type ProjectDraftClient } from './ProjectDraft'
import { groupRepositories } from './repository-groups'
import type { SelectionHost } from './machine-policy'
import { catalogFixture } from './fixtures.test-support'
import { remoteModelCatalogSchema } from '@ari/contracts/remote'
import { dropDraftIntentMemory } from '../composer/draft-recovery-store'
import { dropDraftTextMemory } from '../composer/use-drafts'

const rpc = vi.hoisted(() => ({ invoke: vi.fn(), subscribe: vi.fn(() => () => {}) }))
vi.mock('../../lib/rpc', () => ({ rpc }))
vi.mock('../speech/useSpeech', () => ({ useSpeech: () => ({ status: { ready: false } }) }))
const group = groupRepositories(['local', 'host-a', 'host-b'].map((hostId) => ({
  hostId, hostName: hostId === 'local' ? 'This PC' : hostId, projectId: `project-${hostId}`,
  name: 'Ari', checkoutLabel: `Checkout ${hostId}`, local: hostId === 'local', repository: { canonicalKey: 'github.com/ari/ari' },
})))[0]!
const host = (id: string, cpu = 0.2): SelectionHost => ({ id, name: id === 'local' ? 'This PC' : id,
  connected: true, compatible: true, hasProject: true, usableCatalog: true, preference: 'normal',
  resources: { sampledAt: Date.now(), available: true, cpuUtilization: cpu,
    availableMemoryBytes: 4 * 1024 ** 3, totalMemoryBytes: 16 * 1024 ** 3 },
})
const pick = { driverKind: 'codex' as const, modelId: 'gpt-6.1-sol', permissionMode: 'ask' as const, effort: 'high' }
let client: ProjectDraftClient
let props: ComponentProps<typeof ProjectDraft>
beforeEach(() => {
  localStorage.clear(); dropDraftIntentMemory(); dropDraftTextMemory(); rpc.invoke.mockReset()
  client = {
    catalog: vi.fn(async () => remoteModelCatalogSchema.parse(catalogFixture)),
    workspaces: vi.fn<ProjectDraftClient['workspaces']>(async (projectId) => ({ projectId, truncated: false, options: [
      { token: 'branch-main', label: 'Main branch', kind: 'branch', branch: 'main', workspaceMode: 'isolated' },
    ] })),
    create: vi.fn<ProjectDraftClient['create']>(async () => ({ kind: 'remote', machineId: 'host-a', sessionId: 'sess_created' })),
    stage: vi.fn(async () => []), prompt: vi.fn(async () => {}),
    checkCreate: vi.fn(async () => null), checkPrompt: vi.fn(async () => false),
  }
  props = { draftId: 'draft-one', group, hosts: [host('local'), host('host-a'), host('host-b')],
    autoEnabled: false, clientFor: () => client, defaultFor: () => pick, onRememberHost: vi.fn(),
    onCreated: vi.fn(), onClose: vi.fn() }
})
const start = async () => {
  const user = userEvent.setup()
  render(<ProjectDraft {...props} initialHostId="host-a" />)
  await screen.findByRole('option', { name: 'Main branch' })
  await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Keep this original prompt')
  await user.click(screen.getByRole('button', { name: 'Send' }))
  return user
}

describe('project draft with normal Composer', () => {
  it('starts on This PC, changes host without creating, and never detects local providers for the supplied catalog', async () => {
    const user = userEvent.setup()
    render(<ProjectDraft {...props} />)
    await screen.findByRole('option', { name: 'Main branch' })
    expect(screen.getByRole('button', { name: 'Execution machine' })).toHaveTextContent('This PC')
    await user.click(screen.getByRole('button', { name: 'Execution machine' }))
    await user.click(screen.getByRole('menuitem', { name: 'host-a' }))
    expect(props.onRememberHost).toHaveBeenCalledWith('host-a')
    expect(client.create).not.toHaveBeenCalled()
    expect(rpc.invoke).not.toHaveBeenCalledWith('providers.detect')
    expect(rpc.invoke.mock.calls.some(([method]) => String(method).startsWith('endpoints.'))).toBe(false)
  })
  it('leaves Auto stable through resource refresh and recomputes only when reselected', async () => {
    const user = userEvent.setup()
    const view = render(<ProjectDraft {...props} autoEnabled hosts={[host('host-a', 0.1), host('host-b', 0.5)]} />)
    await screen.findByRole('option', { name: 'Main branch' })
    const originalReason = screen.getByText(/10% CPU/).textContent
    view.rerender(<ProjectDraft {...props} autoEnabled hosts={[host('host-a', 0.6), host('host-b', 0.05)]} />)
    expect(screen.getByRole('button', { name: 'Execution machine' })).toHaveTextContent('Auto · host-a')
    expect(screen.getByText(/10% CPU/).textContent).toBe(originalReason)
    await user.click(screen.getByRole('button', { name: 'Execution machine' }))
    await user.click(screen.getByRole('menuitem', { name: /Auto/ }))
    expect(screen.getByRole('button', { name: 'Execution machine' })).toHaveTextContent('Auto · host-b')
    expect(client.create).not.toHaveBeenCalled()
  })
  it('requires manual selection when Auto resources are busy or stale, while keeping a busy manual host usable', async () => {
    const user = userEvent.setup()
    props.hosts = [host('host-a', 0.9), { ...host('host-b'), resources: { ...host('host-b').resources!, sampledAt: Date.now() - 60_000 } }]
    render(<ProjectDraft {...props} autoEnabled />)
    expect(screen.getByText(/Select a machine manually/)).toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Do this')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(client.create).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Execution machine' }))
    expect(screen.getByRole('menuitem', { name: 'host-a' })).toBeEnabled()
  })
  it('restores a branch choice with its immutable host lock', async () => {
    const user = userEvent.setup()
    const view = render(<ProjectDraft {...props} initialHostId="host-a" />)
    await screen.findByRole('option', { name: 'Main branch' })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Project workspace' }), 'branch-main')
    expect(screen.getByRole('button', { name: 'Execution machine' })).toBeDisabled()
    view.unmount()
    render(<ProjectDraft {...props} />)
    await screen.findByRole('option', { name: 'Main branch' })
    expect(screen.getByRole('combobox', { name: 'Project workspace' })).toHaveValue('branch-main')
    expect(screen.getByRole('button', { name: 'Execution machine' })).toHaveTextContent('host-a')
    expect(screen.getByRole('button', { name: 'Execution machine' })).toBeDisabled()
    expect(client.create).not.toHaveBeenCalled()
  })
  it('retains the original receipt and text through repeated unknown creation checks without retry', async () => {
    vi.mocked(client.create).mockRejectedValue(new Error('Acknowledgement lost'))
    const user = await start()
    await screen.findByRole('button', { name: 'Check original submission' })
    expect(screen.getByRole('button', { name: 'Execution machine' })).toBeDisabled()
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Keep this original prompt')
    for (let i = 0; i < 2; i++) {
      await user.click(screen.getByRole('button', { name: 'Check original submission' }))
      await waitFor(() => expect(client.checkCreate).toHaveBeenCalledTimes(i + 1))
    }
    expect(client.create).toHaveBeenCalledOnce()
    expect(client.prompt).not.toHaveBeenCalled()
    expect(props.onCreated).not.toHaveBeenCalled()
  })
  it('never recreates or resends a confirmed session with an uncertain first prompt', async () => {
    vi.mocked(client.prompt).mockRejectedValue(new Error('Prompt acknowledgement lost'))
    const user = await start()
    await screen.findByRole('button', { name: 'Check original submission' })
    await user.click(screen.getByRole('button', { name: 'Check original submission' }))
    await waitFor(() => expect(client.checkPrompt).toHaveBeenCalledOnce())
    expect(client.create).toHaveBeenCalledOnce(); expect(client.prompt).toHaveBeenCalledOnce()
    expect(client.checkCreate).not.toHaveBeenCalled(); expect(props.onCreated).not.toHaveBeenCalled()
    vi.mocked(client.checkPrompt).mockResolvedValue(true)
    await user.click(screen.getByRole('button', { name: 'Check original submission' }))
    await waitFor(() => expect(props.onCreated).toHaveBeenCalledWith({ kind: 'remote', machineId: 'host-a', sessionId: 'sess_created' }))
  })
  it('moves original text and image intent to the created session after a staging failure', async () => {
    vi.mocked(client.stage).mockRejectedValue(new Error('Stage acknowledgement lost'))
    const user = userEvent.setup()
    render(<ProjectDraft {...props} initialHostId="host-a" />)
    await screen.findByRole('option', { name: 'Main branch' })
    const input = screen.getByRole('textbox', { name: 'Message' })
    fireEvent.paste(input, { clipboardData: { files: [new File(['original image bytes'], 'shot.png', { type: 'image/png' })] } })
    await user.type(input, 'Original with images')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByRole('button', { name: 'Open created session' })
    await user.click(screen.getByRole('button', { name: 'Open created session' }))
    expect(client.create).toHaveBeenCalledOnce(); expect(client.stage).toHaveBeenCalledOnce()
    expect(client.prompt).not.toHaveBeenCalled()
    expect(props.onCreated).toHaveBeenCalledWith({ kind: 'remote', machineId: 'host-a', sessionId: 'sess_created' },
      expect.objectContaining({ text: 'Original with images', images: [expect.objectContaining({ metadata: expect.objectContaining({ name: 'shot.png' }) })] }))
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '@ari/contracts/settings'
import { createOnboardingCompletion, type OnboardingChoice } from './onboarding-completion'

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn<(method: string, params: { path?: string }) => Promise<unknown>>(),
}))
vi.mock('../../lib/rpc', () => ({ rpc: { invoke } }))
const choice: OnboardingChoice = {
  projects: [
    { path: '/work/ari', name: 'Ari', sources: ['claude'], lastUsedAt: null },
    { path: '/work/docs', name: 'Docs', sources: ['codex'], lastUsedAt: null },
  ],
  driverKind: 'claude',
  permissionMode: 'ask',
  createSession: true,
}
const signal = () => new AbortController().signal
beforeEach(() => {
  invoke.mockReset()
  invoke.mockImplementation(async (method: string, params: { path?: string }) => {
    if (method === 'project.open') return { id: params.path, status: 'ok' }
    if (method === 'session.create') return { sessionId: 'first-session' }
    throw new Error(`unexpected RPC: ${method}`)
  })
})

describe('onboarding completion', () => {
  it('opens only chosen projects, creates an idle session and then saves the default and completion', async () => {
    const save = vi.fn().mockResolvedValue(defaultSettings)
    const finish = createOnboardingCompletion(save)
    const result = await finish(choice, signal())
    expect(result).toEqual({
      ok: true,
      value: { sessionId: 'first-session', driverKind: 'claude' },
    })
    expect(invoke.mock.calls.map(([method]) => method)).toEqual([
      'project.open',
      'project.open',
      'session.create',
    ])
    expect(invoke).toHaveBeenCalledWith('session.create', {
      projectId: '/work/ari',
      title: 'New session',
      driverKind: 'claude',
      modelId: null,
      permissionMode: 'ask',
    })
    expect(save).toHaveBeenCalledWith({
      onboarding: { completedAt: expect.any(Number) as unknown },
      sessions: { defaultDriverKind: 'claude' },
    })
    expect(save.mock.invocationCallOrder[0]).toBeGreaterThan(
      invoke.mock.invocationCallOrder.at(-1)!,
    )
    expect(await finish(choice, signal())).toEqual(result)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('retains successful projects and retries only failures without prematurely saving completion', async () => {
    const save = vi.fn().mockResolvedValue(defaultSettings)
    invoke.mockRejectedValueOnce(new Error('disk unavailable'))
    const finish = createOnboardingCompletion(save)
    expect(await finish(choice, signal())).toMatchObject({
      ok: false,
      error: { stage: 'projects', failedPaths: ['/work/ari'] },
    })
    expect(save).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalledWith('session.create', expect.anything())
    invoke.mockClear()
    expect((await finish(choice, signal())).ok).toBe(true)
    expect(invoke.mock.calls.filter(([method]) => method === 'project.open')).toEqual([
      ['project.open', { path: '/work/ari' }],
    ])
  })

  it('treats missing folders as retryable and permits continuing with the successful subset', async () => {
    const save = vi.fn().mockResolvedValue(defaultSettings)
    invoke.mockResolvedValueOnce({ id: 'missing', status: 'missing' })
    const finish = createOnboardingCompletion(save)
    expect(await finish(choice, signal())).toMatchObject({
      ok: false,
      error: { stage: 'projects' },
    })
    expect(save).not.toHaveBeenCalled()
    expect((await finish({ ...choice, projects: choice.projects.slice(1) }, signal())).ok).toBe(
      true,
    )
    expect(invoke).toHaveBeenCalledWith(
      'session.create',
      expect.objectContaining({ projectId: '/work/docs' }),
    )
  })

  it('does not duplicate a created session when saving settings fails', async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error('read only'))
      .mockResolvedValue(defaultSettings)
    const finish = createOnboardingCompletion(save)
    expect(await finish(choice, signal())).toMatchObject({
      ok: false,
      error: { stage: 'settings' },
    })
    expect((await finish(choice, signal())).ok).toBe(true)
    expect(invoke.mock.calls.filter(([method]) => method === 'session.create')).toHaveLength(1)
    expect(invoke.mock.calls.filter(([method]) => method === 'project.open')).toHaveLength(2)
  })

  it('can retry or omit a failed first-session creation', async () => {
    const save = vi.fn().mockResolvedValue(defaultSettings)
    const base = invoke.getMockImplementation()!
    invoke.mockImplementation((method: string, params: { path?: string }) =>
      method === 'session.create' ? Promise.reject(new Error('busy')) : base(method, params),
    )
    const finish = createOnboardingCompletion(save)
    expect(await finish(choice, signal())).toMatchObject({ ok: false, error: { stage: 'session' } })
    expect(save).not.toHaveBeenCalled()
    expect(await finish({ ...choice, createSession: false }, signal())).toEqual({
      ok: true,
      value: { sessionId: null, driverKind: 'claude' },
    })
  })

  it('skips without adding folders, starting agents or overwriting the saved default', async () => {
    const save = vi.fn().mockResolvedValue(defaultSettings)
    const finish = createOnboardingCompletion(save)
    expect(await finish({ ...choice, projects: [], driverKind: null }, signal())).toEqual({
      ok: true,
      value: { sessionId: null, driverKind: null },
    })
    expect(invoke).not.toHaveBeenCalled()
    expect(save).toHaveBeenCalledWith({
      onboarding: { completedAt: expect.any(Number) as unknown },
    })
  })

  it('adds folders without forcing a session when there is no selected agent', async () => {
    const save = vi.fn().mockResolvedValue(defaultSettings)
    const finish = createOnboardingCompletion(save)
    await finish({ ...choice, driverKind: null }, signal())
    expect(invoke.mock.calls.every(([method]) => method === 'project.open')).toBe(true)
  })

  it('deduplicates Windows spellings and coalesces double clicks', async () => {
    const save = vi.fn().mockResolvedValue(defaultSettings)
    const finish = createOnboardingCompletion(save)
    const one = choice.projects[0]!
    const windows = {
      ...choice,
      projects: [
        { ...one, path: 'C:\\Work\\Ari' },
        { ...one, path: 'c:/work/ari/' },
      ],
    }
    const first = finish(windows, signal())
    const second = finish(windows, signal())
    expect(second).toBe(first)
    await first
    expect(invoke.mock.calls.filter(([method]) => method === 'project.open')).toHaveLength(1)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('stops subsequent mutations when the owner leaves during a project open', async () => {
    const save = vi.fn().mockResolvedValue(defaultSettings)
    const controller = new AbortController()
    invoke.mockImplementationOnce(async () => {
      controller.abort()
      return { id: 'one', status: 'ok' }
    })
    const finish = createOnboardingCompletion(save)
    expect(await finish(choice, controller.signal)).toMatchObject({
      ok: false,
      error: { stage: 'cancelled' },
    })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(save).not.toHaveBeenCalled()
    expect(await finish(choice, controller.signal)).toMatchObject({
      ok: false,
      error: { stage: 'cancelled' },
    })
    expect(invoke).toHaveBeenCalledTimes(1)
  })
})

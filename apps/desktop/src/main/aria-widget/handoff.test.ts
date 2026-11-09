// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { sendToAria, type HandoffDeps } from './handoff'

function fake(activeTurnId: string | null = null): HandoffDeps {
  return {
    current: () => true,
    open: vi.fn(async () => ({ sessionId: 'aria' })),
    load: vi.fn(async () => ({ activeTurnId })),
    dispatch: vi.fn(async () => ({ accepted: true })),
  }
}

describe('dictation hand-off', () => {
  it.each([
    [null, 'turn.start'],
    ['running', 'message.enqueue'],
  ] as const)('uses composer dispatch for active turn %s', async (active, type) => {
    const deps = fake(active)
    await sendToAria(deps, '  Fix the build  ')
    expect(deps.open).toHaveBeenCalledOnce()
    expect(deps.load).toHaveBeenCalledWith('aria')
    expect(deps.dispatch).toHaveBeenCalledExactlyOnceWith({
      type,
      sessionId: 'aria',
      text: 'Fix the build',
      attachments: [],
    })
  })

  it('does not create a chat for silence', async () => {
    const deps = fake()
    await sendToAria(deps, ' \n ')
    expect(deps.open).not.toHaveBeenCalled()
  })

  it('does not send after the hold was cancelled or timed out while opening Aria', async () => {
    const deps = fake()
    deps.current = () => false
    await sendToAria(deps, 'Old speech')
    expect(deps.load).not.toHaveBeenCalled()
    expect(deps.dispatch).not.toHaveBeenCalled()
  })

  it('queues when an automatic Aria turn races the idle read', async () => {
    const deps = fake()
    deps.dispatch = vi
      .fn()
      .mockResolvedValueOnce({ accepted: false, reason: 'a turn is already active' })
      .mockResolvedValueOnce({ accepted: true })
    await sendToAria(deps, 'Fix the build')
    expect(deps.dispatch).toHaveBeenLastCalledWith({
      type: 'message.enqueue',
      sessionId: 'aria',
      text: 'Fix the build',
      attachments: [],
    })
  })

  it('surfaces refusal and missing-session errors without announcing sent', async () => {
    const deps = fake()
    deps.dispatch = async () => ({ accepted: false, reason: 'Provider not configured' })
    await expect(sendToAria(deps, 'Hello')).rejects.toThrow('Provider not configured')
    deps.load = async () => null
    await expect(sendToAria(deps, 'Hello')).rejects.toThrow('Could not load Aria')
  })
})

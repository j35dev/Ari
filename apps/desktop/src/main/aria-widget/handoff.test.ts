// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { sendToAria, type HandoffDeps } from './handoff'

function fake(): HandoffDeps {
  return {
    current: () => true,
    open: vi.fn(async () => ({ sessionId: 'aria' })),
    dispatch: vi.fn(async () => ({ accepted: true })),
  }
}

describe('dictation hand-off', () => {
  it('dispatches a single enqueue without loading or racing session state', async () => {
    const deps = fake()
    await sendToAria(deps, '  Fix the build  ')
    expect(deps.open).toHaveBeenCalledOnce()
    expect(deps.dispatch).toHaveBeenCalledExactlyOnceWith({
      type: 'message.enqueue',
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
    expect(deps.dispatch).not.toHaveBeenCalled()
  })

  it('surfaces refusal without announcing sent', async () => {
    const deps = fake()
    deps.dispatch = async () => ({ accepted: false, reason: 'Provider not configured' })
    await expect(sendToAria(deps, 'Hello')).rejects.toThrow('Provider not configured')
  })
})

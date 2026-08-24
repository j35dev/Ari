import { describe, expect, it, vi } from 'vitest'
import {
  requestTerminalTab,
  subscribeTerminalRequests,
  type TerminalTabRequest,
} from './terminal-requests'

const req: TerminalTabRequest = {
  title: 'app: dev',
  cwd: 'C:\\repo',
  command: 'pnpm run dev',
}

describe('terminal request bus', () => {
  it('delivers directly when a view is subscribed', () => {
    const seen: TerminalTabRequest[] = []
    const unsubscribe = subscribeTerminalRequests((r) => seen.push(r))

    requestTerminalTab(req)

    expect(seen).toEqual([req])
    unsubscribe()
  })

  it('queues requests fired before the terminal mounts and drains on subscribe', () => {
    const seen: TerminalTabRequest[] = []

    requestTerminalTab({ ...req, title: 'early' })
    requestTerminalTab({ ...req, title: 'second' })

    const unsubscribe = subscribeTerminalRequests((r) => seen.push(r))
    expect(seen.map((r) => r.title)).toEqual(['early', 'second'])
    unsubscribe()
  })

  it('requeues for the next subscriber while nobody listens', () => {
    const fn = vi.fn()
    const unsubscribe = subscribeTerminalRequests(fn)
    unsubscribe()

    // With listener === null the request parks in the queue — exactly how a
    // click that also mounts the terminal view still lands.
    requestTerminalTab(req)
    expect(fn).not.toHaveBeenCalled()

    const next = vi.fn()
    const off = subscribeTerminalRequests(next)
    expect(next).toHaveBeenCalledExactlyOnceWith(req)
    off()
  })
})

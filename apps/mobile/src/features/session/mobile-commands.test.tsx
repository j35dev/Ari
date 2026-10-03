// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from './Composer'
import { ReviewIntegration } from './ReviewIntegration'
import { RemoteError } from '../../lib/gateway-client'
import { NewSessionSheet } from '../projects/NewSessionSheet'

const app = vi.hoisted(() => ({
  origin: 'https://computer.example',
  connection: 'connected',
  projects: [{ id: 'project-1', name: 'Ari' }],
  catalog: null,
  refresh: vi.fn(),
  session: { deviceId: 'phone-1', supports: vi.fn(() => true), send: vi.fn(), query: vi.fn() },
}))
vi.mock('../../lib/app-state', () => ({ useApp: () => app }))
let root: Root
let host: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  sessionStorage.clear()
  app.session.send.mockReset()
  app.session.query.mockReset()
  app.refresh.mockReset().mockResolvedValue(undefined)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})
async function click(label: string): Promise<void> {
  const button = Array.from(document.querySelectorAll('button')).find(
    (entry) => entry.textContent === label || entry.getAttribute('aria-label') === label,
  )
  expect(button, label).toBeDefined()
  await act(async () => button?.click())
}
async function type(text: string): Promise<void> {
  const area = host.querySelector('textarea')
  if (area === null) throw new Error('Composer not rendered')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(area, text)
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const preview = {
  sessionId: 'child-1',
  parentSessionId: 'parent-1',
  snapshotCommit: 'a'.repeat(40),
  expectedParentSnapshot: 'b'.repeat(40),
  files: [{ path: 'src/main.ts', status: 'modified', additions: 3, deletions: 1, binary: false }],
}

describe('mobile command decisions', () => {
  it('restores an uncertain queued submission after remount and retries the same payload and receipt', async () => {
    app.session.send
      .mockRejectedValueOnce(new RemoteError('unreachable', 'lost acknowledgement'))
      .mockResolvedValue({ ok: true })
    const render = async (): Promise<void> => {
      await act(async () =>
        root.render(
          <Composer
            sessionId="session-1"
            status="running"
            modelLabel="Codex"
            disabled={false}
            onDetails={vi.fn()}
            onSent={vi.fn().mockResolvedValue(undefined)}
            onError={vi.fn()}
          />,
        ),
      )
    }
    await render()
    await type('Run the tests')
    await click('Queue message')
    const first = app.session.send.mock.calls[0]
    expect(first?.[0]).toMatchObject({ op: 'session.queue', text: 'Run the tests' })
    await act(async () => root.unmount())
    root = createRoot(host)
    await render()
    expect(app.session.send).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain('Unconfirmed submission restored')
    await click('Retry same submission')
    expect(app.session.send.mock.calls[1]).toEqual(first)
    expect(host.textContent).toContain('Queued on your computer')
    expect(host.querySelector('textarea')?.value).toBe('')
  })
  it('keeps offline drafts editable without sending them automatically', async () => {
    await act(async () =>
      root.render(
        <Composer
          sessionId="session-1"
          status="idle"
          modelLabel="Codex"
          disabled
          onDetails={vi.fn()}
          onSent={vi.fn()}
          onError={vi.fn()}
        />,
      ),
    )
    await type('Keep this for later')
    expect(host.querySelector('textarea')?.value).toBe('Keep this for later')
    expect(sessionStorage.getItem('ari.draft:https://computer.example:phone-1:session-1')).toBe(
      'Keep this for later',
    )
    expect(app.session.send).not.toHaveBeenCalled()
  })
  it('reviews both snapshots and retains the same integration receipt after a lost response', async () => {
    app.session.query.mockResolvedValue({ preview, error: null })
    app.session.send
      .mockRejectedValueOnce(new RemoteError('unreachable', 'lost acknowledgement'))
      .mockResolvedValue({ ok: true, result: { status: 'integrated' } })
    const changed = vi.fn().mockResolvedValue(undefined)
    await act(async () =>
      root.render(<ReviewIntegration sessionId="child-1" onChanged={changed} />),
    )
    await click('Review integration')
    expect(document.body.textContent).toContain('src/main.ts')
    await click('Integrate reviewed changes')
    const first = app.session.send.mock.calls[0]
    expect(first?.[0]).toEqual({
      op: 'changes.integrate',
      sessionId: 'child-1',
      snapshotCommit: preview.snapshotCommit,
      expectedParentSnapshot: preview.expectedParentSnapshot,
    })
    await click('Retry same integration')
    expect(app.session.send.mock.calls[1]).toEqual(first)
    expect(document.body.textContent).toContain('Changes integrated into the parent workspace')
    expect(changed).toHaveBeenCalledOnce()
  })
  it('requires a fresh preview after a stale-parent refusal', async () => {
    app.session.query.mockResolvedValue({ preview, error: null })
    app.session.send.mockRejectedValue(
      new RemoteError('conflict', 'The parent changed. Refresh the preview.'),
    )
    await act(async () =>
      root.render(<ReviewIntegration sessionId="child-1" onChanged={vi.fn()} />),
    )
    await click('Review integration')
    await click('Integrate reviewed changes')
    expect(document.body.textContent).toContain('The parent changed')
    expect(
      Array.from(document.querySelectorAll('button')).some(
        (button) => button.textContent === 'Retry same integration',
      ),
    ).toBe(false)
    await click('Refresh preview')
    expect(app.session.query).toHaveBeenCalledTimes(2)
    expect(app.session.send).toHaveBeenCalledTimes(1)
  })
  it('refuses to send if the browser cannot preserve the receipt', async () => {
    const failure = vi.fn()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage quota')
    })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await act(async () =>
      root.render(
        <Composer
          sessionId="session-1"
          status="idle"
          modelLabel="Codex"
          disabled={false}
          onDetails={vi.fn()}
          onSent={vi.fn()}
          onError={failure}
        />,
      ),
    )
    await type('Do the task')
    await click('Send message')
    expect(app.session.send).not.toHaveBeenCalled()
    expect(failure).toHaveBeenCalledWith(expect.stringContaining('has not been sent'))
    vi.restoreAllMocks()
  })
  it('restores an uncertain creation after dismissing the sheet without duplicating the session', async () => {
    app.session.send
      .mockRejectedValueOnce(new RemoteError('unreachable', 'lost acknowledgement'))
      .mockResolvedValue({ ok: true, result: { sessionId: 'new-1' } })
    const open = vi.fn()
    const render = async (): Promise<void> => {
      await act(async () => root.render(<NewSessionSheet onClose={vi.fn()} onOpen={open} />))
    }
    await render()
    await type('Build this task')
    await click('Create session')
    const first = app.session.send.mock.calls[0]
    await act(async () => root.unmount())
    root = createRoot(host)
    await render()
    expect(document.body.textContent).toContain('An unconfirmed creation was restored')
    expect(app.session.send).toHaveBeenCalledTimes(1)
    await click('Retry same creation')
    expect(app.session.send.mock.calls[1]).toEqual(first)
    expect(open).toHaveBeenCalledWith('new-1')
    expect(sessionStorage.getItem('ari.draft:https://computer.example:phone-1:new-1')).toBe(
      'Build this task',
    )
  })
  it('opens a confirmed creation even if refreshing the session list fails', async () => {
    app.session.send.mockResolvedValue({ ok: true, result: { sessionId: 'new-2' } })
    app.refresh.mockRejectedValue(new Error('offline list'))
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const open = vi.fn()
    await act(async () => root.render(<NewSessionSheet onClose={vi.fn()} onOpen={open} />))
    await click('Create session')
    expect(open).toHaveBeenCalledWith('new-2')
    expect(app.session.send).toHaveBeenCalledTimes(1)
    expect(sessionStorage.getItem('ari.creation:https://computer.example:phone-1')).toBeNull()
    warning.mockRestore()
  })
})

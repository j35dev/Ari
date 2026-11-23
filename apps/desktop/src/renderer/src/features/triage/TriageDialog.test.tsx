import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TriageCase, TriageSnapshot } from '@ari/contracts/triage'
import { TriageWorkspace } from './TriageDialog'
vi.mock('../composer/ModelSelector', () => ({ ModelSelector: () => <span>Agent picker</span> }))
vi.mock('../session/SessionView', () => ({
  SessionView: ({ sessionId }: { sessionId: string }) => <div>Conversation {sessionId}</div>,
}))
const agent = {
  driverKind: 'codex' as const,
  modelId: null,
  effort: 'high',
  permissionMode: 'ask' as const,
}
let item: TriageCase
let invoke: ReturnType<typeof vi.fn<(method: string, params?: unknown) => Promise<unknown>>>
function snapshot(): TriageSnapshot {
  return {
    case: item,
    context: {
      version: 1,
      appVersion: '0.3.22',
      buildCommit: null,
      profile: 'Ari',
      machine: 'Test PC',
      platform: 'win32',
      arch: 'x64',
      osRelease: '11',
      nodeVersion: '22',
      electronVersion: '43',
      collectedAt: Date.now(),
      providers: [],
      logs: 'Sanitized diagnostic',
      exclusions: ['Prompts'],
    },
  }
}
beforeEach(() => {
  item = {
    version: 1,
    id: `triage_${'a'.repeat(32)}`,
    description: 'Ari freezes on session switch',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    phase: 'ready',
    projectId: null,
    fixProjectId: null,
    investigationSessionId: null,
    fixSessionId: null,
    agent: null,
    fixAgent: null,
    includeLogs: null,
    source: null,
    sourceError: null,
    fixBase: null,
    fixBranch: null,
    issueDraft: { title: 'Session switch freezes', body: 'Initial report' },
    prDraft: { title: 'Fix switch', body: 'Fix details' },
    issue: null,
    pr: null,
    issueReceipt: null,
    prReceipt: null,
    verification: null,
  }
  invoke = vi.fn(async (method: string, raw?: unknown) => {
    const params = (raw ?? {}) as { kind?: string; draft?: { title: string; body: string } }
    if (method === 'triage.list') return []
    if (method === 'triage.prepare' || method === 'triage.get') return snapshot()
    if (method === 'providers.efforts') return { efforts: [] }
    if (method === 'triage.account') return { account: 'contributor', error: null }
    if (method === 'triage.start') {
      item = { ...item, investigationSessionId: 'investigation', agent }
      return snapshot()
    }
    if (method === 'triage.saveDraft') {
      item = { ...item, [params.kind === 'pr' ? 'prDraft' : 'issueDraft']: params.draft }
      return item
    }
    if (method === 'triage.publishIssue') {
      item = { ...item, issue: { number: 5, url: 'https://github.com/j35dev/Ari/issues/5' } }
      return item
    }
    return item
  })
  window.ari = { invoke, subscribe: () => () => undefined }
})
async function prepare() {
  render(
    <TriageWorkspace
      defaults={agent}
      initialDescription="Ari freezes on session switch"
      onClose={() => undefined}
      onOpenSession={() => undefined}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Prepare investigation' }))
  await screen.findByText('Ready for your agent.')
}
describe('triage workspace', () => {
  it('reviews diagnostic selection before starting a real session', async () => {
    await prepare()
    fireEvent.click(screen.getByRole('checkbox', { name: /Include recent diagnostic/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Start investigation' }))
    await screen.findByText('Conversation investigation')
    expect(invoke).toHaveBeenCalledWith('triage.start', {
      id: item.id,
      mode: 'investigate',
      agent,
      includeLogs: false,
    })
  })
  it('publishes only the reviewed draft with the displayed account', async () => {
    await prepare()
    fireEvent.click(screen.getByRole('button', { name: 'Issue draft' }))
    await screen.findByText('Publishing as contributor')
    expect(invoke.mock.calls.some(([method]) => method === 'triage.publishIssue')).toBe(false)
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Reviewed title' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create GitHub issue' }))
    await screen.findByRole('link', { name: /Open issue #5/ })
    expect(invoke).toHaveBeenCalledWith('triage.publishIssue', {
      id: item.id,
      draft: { title: 'Reviewed title', body: 'Initial report' },
      account: 'contributor',
    })
  })
  it('saves the last edit when the workspace is closed before debounce', async () => {
    const view = render(
      <TriageWorkspace
        defaults={agent}
        initialDescription="Bug"
        onClose={() => undefined}
        onOpenSession={() => undefined}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Prepare investigation' }))
    await screen.findByText('Ready for your agent.')
    fireEvent.click(screen.getByRole('button', { name: 'Issue draft' }))
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Last edit' } })
    await act(async () => view.unmount())
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('triage.saveDraft', {
        id: item.id,
        kind: 'issue',
        draft: { title: 'Last edit', body: 'Initial report' },
      }),
    )
  })
})

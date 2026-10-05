import { describe, expect, it } from 'vitest'
import type { RemoteAttention } from '@ari/contracts/remote'
import type { SessionSummary } from '@ari/contracts/rpc'
import { shelve, type ShelfFilter } from './shelves'

const projects = [
  { id: 'ari', name: 'Ari' },
  { id: 'site', name: 'Website' },
]
function session(id: string, fields: Partial<SessionSummary> = {}): SessionSummary {
  return { id, projectId: 'ari', title: id, updatedAt: 100, messageCount: 1, ...fields }
}
function attention(
  sessionId: string,
  fields: Partial<RemoteAttention['items'][number]> = {},
): RemoteAttention['items'][number] {
  return {
    sessionId,
    projectId: 'ari',
    title: sessionId,
    status: 'waiting-approval',
    updatedAt: 100,
    seq: 1,
    pendingApprovals: [],
    pendingInputs: [],
    error: null,
    ...fields,
  }
}
const everything: ShelfFilter = { projectId: null, query: '', projects, archived: false }
const approval = {
  approvalId: 'a1',
  toolName: 'Bash',
  summaryJson: '{}',
  options: [],
} as unknown as RemoteAttention['items'][number]['pendingApprovals'][number]

describe('the home list', () => {
  it('puts each session on one shelf, most urgent first', () => {
    const shelves = shelve(
      [
        session('old', { updatedAt: 1 }),
        session('pinned', { pinned: true }),
        session('busy', { status: 'running' }),
        session('blocked', { status: 'waiting-approval', pinned: true }),
        session('new', { updatedAt: 200 }),
      ],
      [attention('blocked', { pendingApprovals: [approval] })],
      everything,
    )
    expect(shelves.map((shelf) => [shelf.title, shelf.rows.map((row) => row.session.id)])).toEqual([
      ['Needs you', ['blocked']],
      ['Working', ['busy']],
      ['Pinned', ['pinned']],
      ['Recent', ['new', 'old']],
    ])
  })

  it('says what a blocked session is waiting for', () => {
    const [needsYou] = shelve(
      [session('a'), session('b'), session('c')],
      [
        attention('a', { pendingApprovals: [approval, approval] }),
        attention('b', {
          pendingInputs: [
            { inputId: 'i', prompt: 'Which branch?', choicesJson: null },
          ] as unknown as RemoteAttention['items'][number]['pendingInputs'],
        }),
        attention('c', { error: 'The provider signed out.', status: 'error' }),
      ],
      everything,
    )
    expect(needsYou?.rows.map((row) => row.ask)).toEqual([
      'Wants to use Bash, and 1 more',
      'Which branch?',
      'The provider signed out.',
    ])
  })

  it('lists a blocked session the session list has not caught up with yet', () => {
    const [needsYou] = shelve(
      [],
      [attention('fresh', { title: 'Fresh', pendingApprovals: [approval] })],
      everything,
    )
    expect(needsYou?.rows[0]?.session).toMatchObject({ id: 'fresh', title: 'Fresh' })
  })

  it('falls back to session status when the desktop cannot list what needs attention', () => {
    const shelves = shelve(
      [session('blocked', { status: 'waiting-approval' }), session('broken', { status: 'error' })],
      null,
      everything,
    )
    expect(shelves[0]?.title).toBe('Needs you')
    expect(shelves[0]?.rows.map((row) => [row.session.id, row.ask])).toEqual([
      ['blocked', 'Waiting for your approval'],
      ['broken', 'Stopped with an error'],
    ])
  })

  it('narrows to one project and to a search across titles and project names', () => {
    const sessions = [
      session('Fix pairing'),
      session('Landing page', { projectId: 'site' }),
      session('Pricing', { projectId: 'site' }),
    ]
    const ids = (filter: Partial<ShelfFilter>): string[] =>
      shelve(sessions, [], { ...everything, ...filter }).flatMap((shelf) =>
        shelf.rows.map((row) => row.session.id),
      )
    expect(ids({ projectId: 'site' })).toEqual(['Landing page', 'Pricing'])
    expect(ids({ query: 'pair' })).toEqual(['Fix pairing'])
    expect(ids({ query: 'website' })).toEqual(['Landing page', 'Pricing'])
  })

  it('keeps archived sessions out of sight until asked for', () => {
    const sessions = [session('live'), session('gone', { archived: true, status: 'running' })]
    expect(shelve(sessions, [], everything).map((shelf) => shelf.title)).toEqual(['Recent'])
    expect(
      shelve(sessions, [], { ...everything, archived: true }).map((shelf) => shelf.title),
    ).toEqual(['Recent', 'Archived'])
  })
})

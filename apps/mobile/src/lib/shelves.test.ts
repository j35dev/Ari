import { describe, expect, it } from 'vitest'
import type { RemoteAttention } from '@ari/contracts/remote'
import type { RemoteSessionSummary as SessionSummary } from '@ari/contracts/remote'
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
      ['Running', ['busy']],
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
      ],
      everything,
    )
    expect(needsYou?.rows.map((row) => row.ask)).toEqual([
      'Wants to use Bash, and 1 more',
      'Which branch?',
    ])
  })

  it('files a failed session with the recent ones instead of claiming attention forever', () => {
    const shelves = shelve(
      [session('broken', { status: 'error' })],
      [attention('broken', { error: 'The provider signed out.', status: 'error' })],
      everything,
    )
    expect(shelves.map((shelf) => [shelf.title, shelf.rows.map((row) => row.state)])).toEqual([
      ['Recent', ['failed']],
    ])
  })

  it('never shows a turn the computer is not running as work in progress', () => {
    const shelves = shelve(
      [
        session('orphaned', { status: 'running', live: false }),
        session('busy', { status: 'running', live: true }),
        // A desktop from before `live` was reported is believed.
        session('older', { status: 'running' }),
        session('lead'),
        session('dead child', { parentSessionId: 'lead', status: 'running', live: false }),
      ],
      [],
      everything,
    )
    expect(
      shelves.map((shelf) => [shelf.title, shelf.rows.map((row) => [row.session.id, row.state])]),
    ).toEqual([
      [
        'Running',
        [
          ['busy', 'running'],
          ['older', 'running'],
        ],
      ],
      [
        'Recent',
        [
          ['orphaned', 'stalled'],
          ['lead', 'idle'],
        ],
      ],
    ])
    expect(shelves[1]?.rows[1]?.agents).toEqual({ total: 1, working: 0 })
  })

  it('treats an archived session as finished whatever its journal says', () => {
    const [archived] = shelve([session('gone', { archived: true, status: 'running' })], [], {
      ...everything,
      archived: true,
    })
    expect(archived?.rows.map((row) => row.state)).toEqual(['idle'])
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
    ])
    expect(shelves[1]?.rows.map((row) => [row.session.id, row.state])).toEqual([
      ['broken', 'failed'],
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

  it('lets a session stand in for the agents it delegated to', () => {
    const sessions = [
      session('lead'),
      session('parser', { parentSessionId: 'lead', status: 'running', updatedAt: 300 }),
      session('docs', { parentSessionId: 'lead' }),
      session('nested', { parentSessionId: 'parser', status: 'running' }),
      session('solo'),
    ]
    const shelves = shelve(sessions, [], everything)
    expect(shelves.map((shelf) => [shelf.title, shelf.rows.map((row) => row.session.id)])).toEqual([
      // Idle itself, but its agents are still at it.
      ['Running', ['lead']],
      ['Recent', ['solo']],
    ])
    expect(shelves[0]?.rows[0]?.agents).toEqual({ total: 3, working: 2 })
  })

  it('shows an agent by itself when it is the one that needs the user, or is searched for', () => {
    const sessions = [
      session('lead'),
      session('parser', { parentSessionId: 'lead', status: 'waiting-approval' }),
      session('docs', { parentSessionId: 'lead' }),
    ]
    const [needsYou, recent] = shelve(
      sessions,
      [attention('parser', { pendingApprovals: [approval] })],
      everything,
    )
    expect(needsYou?.rows.map((row) => [row.session.id, row.parentTitle])).toEqual([
      ['parser', 'lead'],
    ])
    expect(recent?.rows.map((row) => row.session.id)).toEqual(['lead'])

    const found = shelve(sessions, [], { ...everything, query: 'docs' })
    expect(found.flatMap((shelf) => shelf.rows.map((row) => row.session.id))).toEqual(['docs'])
    // An agent whose parent is not in the list is an ordinary row.
    const orphan = shelve([session('lost', { parentSessionId: 'gone' })], [], everything)
    expect(orphan[0]?.rows[0]?.parentTitle).toBeUndefined()
  })

  it('keeps archived sessions out of sight until asked for', () => {
    const sessions = [session('live'), session('gone', { archived: true, status: 'running' })]
    expect(shelve(sessions, [], everything).map((shelf) => shelf.title)).toEqual(['Recent'])
    expect(
      shelve(sessions, [], { ...everything, archived: true }).map((shelf) => shelf.title),
    ).toEqual(['Recent', 'Archived'])
  })
})

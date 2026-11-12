import { isHelmSession } from '@ari/contracts/helm'
import type { Session } from '@ari/contracts/session'
import type { SessionSummary } from '@ari/contracts/rpc'
import type { SessionActivity } from '../session/session-activity'
import { descendantIds } from '../session/session-tree'
import { sectionLabel } from '../../lib/recipes'
import { startedByAria } from './aria-activity'

type OverviewSession = SessionSummary & Pick<Session, 'createdBy'>

export type OverviewState = 'attention' | 'working' | 'queued' | 'done' | 'error' | 'idle'

export interface OverviewItem {
  session: OverviewSession
  state: OverviewState
  /** What the row says under the title. */
  detail: string
}

export interface OverviewGroups {
  needsYou: OverviewItem[]
  working: OverviewItem[]
  finished: OverviewItem[]
  recent: OverviewItem[]
}

/** How many quiet, idle sessions the overview keeps in view. */
const RECENT_LIMIT = 5

function describe(
  activity: SessionActivity | undefined,
  attention: number,
): Pick<OverviewItem, 'state' | 'detail'> {
  if (attention > 0 || activity?.phase === 'paused') {
    return {
      state: 'attention',
      detail:
        activity?.pauseReason === 'approval'
          ? 'Waiting for your approval'
          : activity?.pauseReason === 'input'
            ? 'Waiting for your answer'
            : attention > 1
              ? `${String(attention)} things need you`
              : 'Needs you',
    }
  }
  switch (activity?.phase) {
    case 'working':
      return { state: 'working', detail: 'Working' }
    case 'queued':
      return { state: 'queued', detail: 'Queued' }
    case 'done':
      return { state: 'done', detail: 'Finished' }
    case 'error':
      return { state: 'error', detail: 'Stopped with an error' }
    default:
      return { state: 'idle', detail: 'Idle' }
  }
}

/**
 * The sessions Aria is leading, sorted by what the user should look at first:
 * the ones waiting on them, then the ones running, then results, then the
 * rest. Covers every session Aria started and everything delegated below them.
 */
export function ariaOverview(
  sessions: readonly OverviewSession[],
  activityOf: (id: string) => SessionActivity | undefined,
  attentionCountOf: (id: string) => number = () => 0,
): OverviewGroups {
  const live = sessions.filter((session) => !session.archived && !isHelmSession(session))
  const led = new Set<string>()
  for (const session of live) {
    if (!startedByAria(session)) continue
    led.add(session.id)
    for (const id of descendantIds(live, session.id)) led.add(id)
  }
  const groups: OverviewGroups = { needsYou: [], working: [], finished: [], recent: [] }
  const newestFirst = [...live]
    .filter((session) => led.has(session.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  for (const session of newestFirst) {
    const item = { session, ...describe(activityOf(session.id), attentionCountOf(session.id)) }
    if (item.state === 'attention') groups.needsYou.push(item)
    else if (item.state === 'working' || item.state === 'queued') groups.working.push(item)
    else if (item.state === 'done' || item.state === 'error') groups.finished.push(item)
    else if (groups.recent.length < RECENT_LIMIT) groups.recent.push(item)
  }
  return groups
}

const GROUPS: { key: keyof OverviewGroups; label: string }[] = [
  { key: 'needsYou', label: 'Needs you' },
  { key: 'working', label: 'Working' },
  { key: 'finished', label: 'Finished' },
  { key: 'recent', label: 'Recent' },
]

/**
 * Aria's desk: everything she is leading, in one list, so the user can see
 * what needs them without opening each session.
 */
export function AriaOverview({
  sessions,
  activityOf,
  attentionCountOf,
  projectNameOf,
  onOpen,
}: {
  sessions: readonly OverviewSession[]
  activityOf: (id: string) => SessionActivity | undefined
  attentionCountOf?: (id: string) => number
  projectNameOf: (projectId: string) => string | null
  onOpen: (sessionId: string) => void
}) {
  const groups = ariaOverview(sessions, activityOf, attentionCountOf)
  const empty = GROUPS.every((group) => groups[group.key].length === 0)

  if (empty) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 p-8 text-center">
        <p className="text-sm font-medium text-fg">Nothing running</p>
        <p className="max-w-60 text-[13px] text-fg-subtle">
          Sessions Aria starts for you show up here, with the ones that need you first.
        </p>
      </div>
    )
  }

  return (
    <div className="ari-scroll h-full overflow-y-auto pb-3">
      {GROUPS.map((group) => {
        const items = groups[group.key]
        if (items.length === 0) return null
        return (
          <section key={group.key} aria-label={group.label}>
            <h3 className={`${sectionLabel} px-4 pb-1 pt-4 font-normal`}>{group.label}</h3>
            <ul>
              {items.map((item) => {
                const project = projectNameOf(item.session.projectId)
                return (
                  <li key={item.session.id}>
                    <button
                      type="button"
                      onClick={() => onOpen(item.session.id)}
                      className="grid w-full grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-4 py-2 text-left transition-colors hover:bg-fg/5 focus-visible:bg-fg/5 focus-visible:outline-none"
                    >
                      <span
                        className="ari-status"
                        data-status={item.state === 'idle' ? undefined : item.state}
                        aria-hidden
                      />
                      <span className="truncate text-sm font-medium text-fg">
                        {item.session.title || 'New session'}
                      </span>
                      {project !== null ? (
                        <span className="max-w-28 truncate text-xs text-fg-subtle">{project}</span>
                      ) : (
                        <span />
                      )}
                      <span
                        className={`col-span-2 col-start-2 truncate text-[13px] ${
                          item.state === 'attention' ? 'text-accent' : 'text-fg-subtle'
                        }`}
                      >
                        {item.detail}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        )
      })}
    </div>
  )
}

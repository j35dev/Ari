import type { ChildTask } from '@ari/contracts/agent-control'

/** How one delegated child reads on a phone; the desktop's task cards use the same words. */
export type AgentState = 'working' | 'needs-you' | 'waiting' | 'done' | 'failed' | 'stopped' | 'idle'

export const AGENT_LABEL: Record<AgentState, string> = {
  working: 'Working',
  'needs-you': 'Needs you',
  waiting: 'Waiting on its agents',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
  idle: 'Not started',
}

export function agentState(task: ChildTask): AgentState {
  switch (task.workState) {
    case 'working':
      return 'working'
    case 'blocked_on_user':
      return 'needs-you'
    case 'waiting_for_children':
      return 'waiting'
    case 'not_started':
      return 'idle'
    case 'result_available':
      if (task.latestTurn?.stopReason === 'error') return 'failed'
      return task.latestTurn?.stopReason === 'interrupted' ? 'stopped' : 'done'
  }
}

/** States with something still in motion: these are what "Stop all" stops. */
export function isLive(state: AgentState): boolean {
  return state === 'working' || state === 'needs-you' || state === 'waiting'
}

const ORDER: AgentState[] = ['needs-you', 'working', 'waiting', 'failed', 'stopped', 'done', 'idle']
const PHRASE: Record<AgentState, string> = {
  'needs-you': 'needs you',
  working: 'working',
  waiting: 'waiting',
  failed: 'failed',
  stopped: 'stopped',
  done: 'done',
  idle: 'not started',
}

/** Agents in the order a person should look at them: the one that needs them first. */
export function byUrgency(tasks: readonly ChildTask[]): ChildTask[] {
  return [...tasks].sort(
    (a, b) => ORDER.indexOf(agentState(a)) - ORDER.indexOf(agentState(b)),
  )
}

/**
 * What a session that has ended its own turn is waiting on, for the line
 * under its title. Null when its agents are all finished.
 */
export function agentsStatus(tasks: readonly ChildTask[]): string | null {
  const states = tasks.map(agentState)
  const asking = states.filter((state) => state === 'needs-you').length
  if (asking > 0) return `${asking} agent${asking === 1 ? ' needs' : 's need'} you`
  const running = states.filter((state) => state === 'working' || state === 'waiting').length
  return running > 0 ? `waiting on ${running} agent${running === 1 ? '' : 's'}` : null
}

/** `3 agents · 1 needs you · 2 working`, most urgent first. */
export function agentsSummary(tasks: readonly ChildTask[]): string {
  const states = tasks.map(agentState)
  const counts = ORDER.flatMap((state) => {
    const count = states.filter((entry) => entry === state).length
    return count > 0 ? [`${count} ${PHRASE[state]}`] : []
  })
  return [`${tasks.length} agent${tasks.length === 1 ? '' : 's'}`, ...counts].join(' · ')
}

/** The bracketed line Ari opens a delegation update with. */
const SIGNATURE = /^\[Ari delegation update:[^\]]*\]\s*/

/**
 * A delegation update as a phone shows it: one line saying who reported, and
 * the delivered text without Ari's own preface for whoever wants to read it.
 */
export function delegationUpdate(
  text: string,
  sessionIds: readonly string[],
  titleOf: (id: string) => string | undefined,
): { headline: string; body: string } {
  const names = sessionIds.map((id) => titleOf(id) ?? 'A removed session')
  const failed = sessionIds.filter((id) => text.includes(`(${id}) failed.`)).length
  const who =
    names.length <= 2 ? names.join(' and ') : `${names[0] ?? 'One'} and ${names.length - 1} others`
  const verb = failed === names.length ? 'failed' : 'reported back'
  return { headline: `${who} ${verb}`, body: text.replace(SIGNATURE, '') }
}

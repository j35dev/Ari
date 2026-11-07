import { presentChildTask } from '@ari/contracts/orchestration-presentation'
import type { ChildTask } from '@ari/contracts/agent-control'

/** How one delegated child reads on a phone; the desktop's task cards use the same words. */
export type AgentState =
  | 'working'
  | 'needs-you'
  | 'needs-lead'
  | 'queued'
  | 'starting'
  | 'stopping'
  | 'unknown'
  | 'waiting'
  | 'done'
  | 'failed'
  | 'stopped'
  | 'idle'

export const AGENT_LABEL: Record<AgentState, string> = {
  working: 'Working',
  queued: 'Queued',
  'needs-lead': 'Needs lead',
  starting: 'Starting',
  stopping: 'Stopping',
  unknown: 'Activity unknown',
  'needs-you': 'Needs you',
  waiting: 'Waiting on its agents',
  done: 'Result ready',
  failed: 'Failed',
  stopped: 'Interrupted',
  idle: 'Not started',
}

export function agentState(task: ChildTask): AgentState {
  const state = presentChildTask(task).state
  return state === 'completed' ? 'done' : state === 'interrupted' ? 'stopped' : state
}

/** States with something still in motion: these are what "Stop all" stops. */
export function isLive(state: AgentState): boolean {
  return !['done', 'failed', 'stopped', 'idle'].includes(state)
}

const ORDER: AgentState[] = [
  'needs-you',
  'needs-lead',
  'unknown',
  'queued',
  'starting',
  'stopping',
  'working',
  'waiting',
  'failed',
  'stopped',
  'done',
  'idle',
]
const PHRASE: Record<AgentState, string> = {
  'needs-you': 'needs you',
  working: 'working',
  waiting: 'waiting',
  failed: 'failed',
  stopped: 'interrupted',
  done: 'results ready',
  'needs-lead': 'needs lead',
  queued: 'queued',
  starting: 'starting',
  stopping: 'stopping',
  unknown: 'activity unknown',
  idle: 'not started',
}

/** Agents in the order a person should look at them: the one that needs them first. */
export function byUrgency(tasks: readonly ChildTask[]): ChildTask[] {
  return [...tasks].sort((a, b) => ORDER.indexOf(agentState(a)) - ORDER.indexOf(agentState(b)))
}

/**
 * What a session that has ended its own turn is waiting on, for the line
 * under its title. Null when its agents are all finished.
 */
export function agentsStatus(tasks: readonly ChildTask[]): string | null {
  const states = tasks.map(agentState)
  const asking = states.filter((state) => state === 'needs-you').length
  if (asking > 0) return `${asking} agent${asking === 1 ? ' needs' : 's need'} you`
  const lead = states.filter((state) => state === 'needs-lead').length
  if (lead > 0) return `${lead} agent${lead === 1 ? ' needs' : 's need'} lead`
  const running = states.filter(isLive).length
  return running > 0 ? `waiting on ${running} agent${running === 1 ? '' : 's'}` : null
}

/** `3 agents · 1 needs you · 2 working`, most urgent first. */
export function agentsSummary(tasks: readonly ChildTask[]): string {
  const states = tasks.map(agentState)
  const counts = ORDER.flatMap((state) => {
    const count = states.filter((entry) => entry === state).length
    return count > 0
      ? [`${count} ${state === 'done' && count === 1 ? 'result ready' : PHRASE[state]}`]
      : []
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

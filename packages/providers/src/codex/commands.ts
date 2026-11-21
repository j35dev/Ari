/**
 * Codex slash commands Ari runs as app-server methods. The Codex TUI handles
 * them client-side; the app-server exposes the same operations as JSON-RPC
 * (`thread/compact/start`, `review/start`, `thread/goal/*`), so Ari calls
 * those instead of sending the command to the model as text.
 */

/** What `/goal <args>` asks for, read the way the Codex TUI reads it. */
export type GoalRequest =
  | { kind: 'get' }
  | { kind: 'clear' }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'edit' }
  | { kind: 'set'; objective: string }

/** `/goal [<objective>|clear|edit|pause|resume]`: a lone keyword is a subcommand. */
export function parseGoalArgs(args: string): GoalRequest {
  const trimmed = args.trim()
  if (trimmed.length === 0) return { kind: 'get' }
  switch (trimmed.toLowerCase()) {
    case 'clear':
      return { kind: 'clear' }
    case 'pause':
      return { kind: 'pause' }
    case 'resume':
      return { kind: 'resume' }
    case 'edit':
      return { kind: 'edit' }
    default:
      return { kind: 'set', objective: trimmed }
  }
}

/** `thread/goal/*`'s `ThreadGoal`. */
export interface CodexGoal {
  objective?: string
  status?: string
  tokenBudget?: number | null
  tokensUsed?: number
  timeUsedSeconds?: number
}

const STATUS_LABELS: Record<string, string> = {
  active: 'active',
  paused: 'paused',
  blocked: 'stalled',
  usageLimited: 'usage limited',
  budgetLimited: 'limited by budget',
  complete: 'complete',
}

function duration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** The goal as a notice: objective, then status, time and tokens on one line. */
export function describeGoal(goal: CodexGoal | null | undefined): string {
  if (!goal || typeof goal.objective !== 'string') return 'No goal is set for this Codex thread.'
  const facts = [`Status: ${STATUS_LABELS[goal.status ?? ''] ?? goal.status ?? 'unknown'}`]
  if (typeof goal.timeUsedSeconds === 'number' && goal.timeUsedSeconds > 0)
    facts.push(`Time used: ${duration(goal.timeUsedSeconds)}`)
  if (typeof goal.tokensUsed === 'number') {
    facts.push(
      typeof goal.tokenBudget === 'number'
        ? `Tokens used: ${goal.tokensUsed.toLocaleString('en-US')} of ${goal.tokenBudget.toLocaleString('en-US')}`
        : `Tokens used: ${goal.tokensUsed.toLocaleString('en-US')}`,
    )
  }
  return `Goal: ${goal.objective}\n${facts.join(' · ')}`
}

/** `review/start`'s target: the uncommitted changes, or what the user asked for. */
export function reviewTarget(
  args: string,
): { type: 'uncommittedChanges' } | { type: 'custom'; instructions: string } {
  const instructions = args.trim()
  return instructions.length > 0 ? { type: 'custom', instructions } : { type: 'uncommittedChanges' }
}

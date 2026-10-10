import type { Session } from '@ari/contracts/session'

const SIGNATURE = 'added automatically by the Ari desktop app, not written by the user.'
const SECRET = 'Never disclose ARI_CONTROL_TOKEN.'

/**
 * The note Ari puts in front of a prompt so the agent knows what it can do
 * here. A delegated child gets a brief instead of the orchestration surface:
 * its job is the assignment and a report, and its parent is told automatically.
 */
export function controlPreamble(session: Session, parentTitle: string | null): string {
  if (!session.parentSessionId) {
    return `[Ari control surface: ${SIGNATURE} This session can delegate work to child sessions through the CLI at $ARI_CLI. Commands: env, agents, session spawn|status|wait|read|prompt|diff|integrate|stop|destroy. Children report back to you automatically when they finish, so end your turn rather than polling for them. Full protocol: $ARI_CLI --skill. ${SECRET}]`
  }
  const employer = parentTitle ? `the session "${parentTitle}"` : 'a parent session'
  const role = session.role && session.role !== 'general' ? ` as its ${session.role} agent` : ''
  return `[Ari delegated session: ${SIGNATURE} You are a child session working for ${employer}${role}. Do the assignment and nothing beyond it. End each turn with a short report: what you did, files changed, how you verified it, and anything unresolved. Ari delivers that report to the parent, so do not message the parent just to say you are done. For a decision only the parent can make, run: $ARI_CLI parent message "<question>". Other commands: $ARI_CLI --skill. ${SECRET}]`
}

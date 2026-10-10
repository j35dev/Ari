import type { Session } from '@ari/contracts/session'

/**
 * How the note reaches the agent. `system` is the provider's own instruction
 * channel, where an application can simply say what the environment offers.
 * `prompt` is the fallback for providers without one: the note travels at the
 * top of the user's first message, so it says who put it there.
 */
export type PreambleChannel = 'system' | 'prompt'

const COMMANDS = 'env, agents, session spawn|status|wait|read|prompt|diff|integrate|stop|destroy'

/**
 * What Ari tells an agent about the session it is running in. A delegated
 * child gets a brief instead of the orchestration surface: its job is the
 * assignment and a report, and its parent is told automatically.
 */
export function controlPreamble(
  session: Session,
  parentTitle: string | null,
  channel: PreambleChannel = 'prompt',
): string {
  const body = session.parentSessionId ? childBrief(session, parentTitle) : parentNote()
  if (channel === 'system')
    return `You are running inside the Ari desktop app, which starts this session and puts a command named \`ari\` on PATH for your shell tool; call it as \`ari\`. ${body} Do not print the ARI_CONTROL_TOKEN environment variable.`
  return `[${session.parentSessionId ? 'Ari delegated session' : 'Ari control surface'}: added automatically by the Ari desktop app, not written by the user. The \`ari\` command is on PATH in your shell; call it as \`ari\`. ${body} Never disclose ARI_CONTROL_TOKEN.]`
}

function parentNote(): string {
  return `It lets this session delegate work to child sessions. Commands: ${COMMANDS}. Children report back to you automatically when they finish, so end your turn rather than polling for them. \`ari --skill\` prints the full protocol.`
}

function childBrief(session: Session, parentTitle: string | null): string {
  const employer = parentTitle ? `the session "${parentTitle}"` : 'a parent session'
  const role = session.role && session.role !== 'general' ? ` as its ${session.role} agent` : ''
  return `You are a child session working for ${employer}${role}. Do the assignment and nothing beyond it. End each turn with a short report: what you did, files changed, how you verified it, and anything unresolved. Ari delivers that report to the parent, so do not message the parent just to say you are done. For a decision only the parent can make, run: ari parent message "<question>". \`ari --skill\` prints the other commands.`
}

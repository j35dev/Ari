import type { RpcResults } from '@ari/contracts/rpc'
import type { MessagePart } from '@ari/contracts/message'
import { createLogger } from '@ari/shared/logger'
import { newTypedId } from '@ari/shared/ids'
import { listPiSessions, readPiTranscript } from '@ari/providers/pi/sessions'
import type { PiTranscript } from '@ari/providers/pi/sessions'
import type { SessionStore } from '@ari/engine/session-store'
import type { ProjectStore } from '@ari/engine/projects'

const log = createLogger('desktop:session-import')

/**
 * Brings a session the user already had in pi into Ari, as a real journal.
 *
 * The import is a replay, not a link: it writes Ari's own events so the
 * transcript renders, searches, and resumes like any other session. pi's file
 * is only read — it stays exactly where it was and remains resumable in pi
 * afterwards, so importing can never cost someone their history.
 *
 * The imported session carries `session.ref.observed` with pi's own session id,
 * which is what lets the next turn continue the same thread rather than
 * starting cold from a wall of replayed text.
 */

export interface SessionImportDeps {
  sessions: SessionStore
  projects: ProjectStore
  now?: () => number
}

/** Sessions pi has on disk, annotated with whether Ari already imported them. */
export async function listImportableSessions(
  deps: SessionImportDeps,
  cwd?: string,
): Promise<RpcResults['sessions.importable']> {
  const found = await listPiSessions(cwd === undefined ? {} : { cwd })
  const already = await importedRefs(deps.sessions)
  return found.map((session) => ({
    kind: 'pi' as const,
    id: session.id,
    path: session.path,
    cwd: session.cwd,
    title: session.title,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    messageCount: session.messageCount,
    imported: already.has(session.id),
  }))
}

/**
 * Replays one pi session file into a new Ari journal. Refuses rather than
 * duplicating when the same pi session was imported before, so a double click
 * cannot leave two copies in the sidebar.
 */
export async function importPiSession(
  params: { path: string; projectId?: string },
  deps: SessionImportDeps,
): Promise<RpcResults['sessions.import']> {
  const transcript = await readPiTranscript(params.path)
  if (transcript === null) {
    return { ok: false, error: 'That file is not a readable pi session.' }
  }

  const already = await importedRefs(deps.sessions)
  if (already.has(transcript.sessionId)) {
    return { ok: false, error: 'This pi session is already in Ari.' }
  }

  const projectId = params.projectId ?? projectFor(transcript.cwd, deps.projects)
  if (projectId === null) {
    return {
      ok: false,
      error: `No Ari project for ${transcript.cwd || 'that folder'} — open the folder first, then import.`,
    }
  }

  const sessionId = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  await writeImportedJournal(sessionId, projectId, transcript, deps)
  log.info('imported a pi session', {
    sessionId,
    piSessionId: transcript.sessionId,
    entries: transcript.entries.length,
  })
  return { ok: true, sessionId, title: transcript.title, messageCount: transcript.entries.length }
}

/**
 * Writes the journal for an imported transcript.
 *
 * Every event is stamped with the pi timestamp it came from, so the imported
 * session sorts into the sidebar where the work actually happened rather than
 * at "now". Each user message opens a turn and the assistant traffic that
 * follows settles it — the same shape a live turn produces, which is what makes
 * the transcript, the message rail, and per-turn usage all work unchanged.
 */
async function writeImportedJournal(
  sessionId: string,
  projectId: string,
  transcript: PiTranscript,
  deps: SessionImportDeps,
): Promise<void> {
  const append = deps.sessions.append.bind(deps.sessions)
  const now = deps.now ?? Date.now
  const startedAt = transcript.startedAt > 0 ? transcript.startedAt : now()
  const lastAt = transcript.entries.at(-1)?.at ?? startedAt

  await append(sessionId, {
    type: 'session.created',
    at: startedAt,
    session: {
      id: sessionId,
      projectId,
      title: transcript.title,
      driverKind: 'pi',
      modelId: transcript.model,
      permissionMode: 'ask',
      status: 'idle',
      createdAt: startedAt,
      updatedAt: lastAt,
    },
  })
  await append(sessionId, { type: 'session.ref.observed', at: startedAt, ref: transcript.sessionId })

  let turnId: string | null = null
  let messageId: string | null = null

  const settle = async (at: number): Promise<void> => {
    if (turnId === null) return
    await append(sessionId, {
      type: 'turn.settled',
      at,
      turnId,
      stopReason: 'completed',
      errorMessage: null,
    })
    turnId = null
    messageId = null
  }

  for (const entry of transcript.entries) {
    const at = entry.at > 0 ? entry.at : startedAt

    if (entry.kind === 'user') {
      await settle(at)
      turnId = newTypedId('turn')
      await append(sessionId, { type: 'turn.started', at, turnId })
      await append(sessionId, {
        type: 'user.message.added',
        at,
        message: {
          id: newTypedId('msg'),
          sessionId,
          turnId,
          role: 'user',
          parts: [{ type: 'text', text: entry.text }],
          createdAt: at,
        },
      })
      continue
    }

    // Assistant traffic that predates any user message (pi's own startup notes)
    // still needs a turn to hang from.
    if (turnId === null) {
      turnId = newTypedId('turn')
      await append(sessionId, { type: 'turn.started', at, turnId })
    }
    messageId ??= newTypedId('msg')

    if (entry.kind === 'assistant') {
      const parts: MessagePart[] = [
        ...entry.blocks.map((block) =>
          block.type === 'thinking'
            ? ({ type: 'thinking', text: block.text } satisfies MessagePart)
            : ({ type: 'text', text: block.text } satisfies MessagePart),
        ),
        ...entry.toolCalls.map(
          (call) =>
            ({
              type: 'tool-call',
              callId: call.callId,
              name: call.name,
              argsJson: call.argsJson,
            }) satisfies MessagePart,
        ),
      ]
      if (entry.errorMessage !== null) {
        parts.push({ type: 'text', text: `\n\n⚠ ${entry.errorMessage}` })
      }
      if (parts.length > 0) {
        await append(sessionId, { type: 'assistant.parts.appended', at, messageId, parts })
      }
      if (entry.usage !== null) {
        await append(sessionId, {
          type: 'usage.recorded',
          at,
          inputTokens: entry.usage.inputTokens,
          outputTokens: entry.usage.outputTokens,
          costUsd: entry.usage.costUsd,
        })
      }
      continue
    }

    await append(sessionId, {
      type: 'assistant.parts.appended',
      at,
      messageId,
      parts: [
        {
          type: 'tool-result',
          callId: entry.callId,
          resultJson: entry.resultJson,
          isError: entry.isError,
        },
      ],
    })
  }

  await settle(lastAt)
}

/**
 * pi session ids Ari has already imported, read from the journals' own
 * `session.ref.observed`. There is no separate bookkeeping to fall out of sync:
 * the ref that makes an imported session resumable is the same one that marks
 * it imported. Folding a read model per session is the cost of that, so the
 * listing round is bounded by how many sessions the user has.
 */
async function importedRefs(sessions: SessionStore): Promise<Set<string>> {
  const refs = new Set<string>()
  const listed = await sessions.listSessions().catch(() => [])
  for (const summary of listed) {
    const model = await sessions.load(summary.id).catch(() => null)
    if (model?.session?.driverKind !== 'pi') continue
    const ref = model.providerSessionId
    if (typeof ref === 'string' && ref.length > 0) refs.add(ref)
  }
  return refs
}

/** The registered project whose folder is the session's cwd, if any. */
function projectFor(cwd: string, projects: ProjectStore): string | null {
  if (cwd.length === 0) return null
  const norm = (value: string): string =>
    value.replace(/[/\\]+$/, '').replace(/\\/g, '/').toLowerCase()
  const target = norm(cwd)
  return projects.list().find((project) => norm(project.path) === target)?.id ?? null
}

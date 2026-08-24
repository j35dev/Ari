import { journalEventSchema } from '@ari/contracts/events'
import type { ParsedLine } from '@ari/shared/jsonl'
import { applyEvent, initialReadModel, type SessionReadModel } from './projection'

/** One journal line that failed JSON or schema validation during replay. */
export interface RejectedLine {
  /** 1-based line number within the segment it came from. */
  line: number
  /** Human-facing reason: JSON error or flattened zod issue. */
  reason: string
  /** Verbatim source text, quarantined so nothing is silently lost. */
  raw: string
}

/** Replay outcome: the folded model plus what had to be quarantined. */
export interface ReplayOutcome {
  model: SessionReadModel
  rejected: RejectedLine[]
}

/** Count + first reason, the shape the UI shows as a replay diagnostic. */
export interface ReplayDiagnostics {
  rejectedCount: number
  firstReason: string | null
}

function reasonOf(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  const issue = error.issues[0]
  if (!issue) return 'invalid journal event'
  const path = issue.path.map(String).join('.')
  return path.length > 0 ? `${path}: ${issue.message}` : issue.message
}

/**
 * Folds parsed journal lines into a read model, validating every line against
 * {@link journalEventSchema} first. An unparseable or schema-invalid line is
 * never applied and never thrown: it lands in `rejected` for quarantine while
 * replay continues with the remaining valid lines.
 */
export function replayEntries(entries: ParsedLine<unknown>[]): ReplayOutcome {
  let model = initialReadModel()
  const rejected: RejectedLine[] = []
  for (const entry of entries) {
    if (entry.kind === 'error') {
      rejected.push({ line: entry.line, reason: entry.message, raw: entry.raw })
      continue
    }
    const parsed = journalEventSchema.safeParse(entry.value)
    if (!parsed.success) {
      rejected.push({ line: entry.line, reason: reasonOf(parsed.error), raw: entry.raw })
      continue
    }
    model = applyEvent(model, parsed.data)
  }
  return { model, rejected }
}

export function diagnosticsOf(rejected: RejectedLine[]): ReplayDiagnostics {
  return { rejectedCount: rejected.length, firstReason: rejected[0]?.reason ?? null }
}

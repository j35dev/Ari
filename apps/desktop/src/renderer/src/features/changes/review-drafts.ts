import { useSyncExternalStore } from 'react'
import { sourceControlSchemas } from '@ari/contracts/rpc'
import { createLogger } from '@ari/shared/logger'

const log = createLogger('ui:review-drafts')
const EMPTY: readonly ReviewDraft[] = []
const MAX_DRAFTS = 50
const cache = new Map<string, readonly ReviewDraft[]>()
const listeners = new Set<() => void>()

/** A review note kept with the session until the next message sends it. */
export interface ReviewDraft {
  id: string
  path: string
  line: number | null
  text: string
  side?: 'old' | 'new'
  startLine?: number
  endLine?: number
  context?: string
  comparisonId?: string
}

export interface ReviewRangeInput {
  path: string
  comparisonId: string
  side: 'old' | 'new'
  startLine: number
  endLine: number
  context: string
}

function storageKey(sessionId: string): string {
  return `ari:review-drafts:${sessionId}`
}

function emit(): void {
  for (const listener of listeners) listener()
}

function draftId(): string {
  return crypto.randomUUID()
}

function bounded(value: string, max: number): string {
  return value.trim().slice(0, max)
}

function optionalOid(value: unknown): string | undefined {
  return typeof value === 'string' && sourceControlSchemas.oid.safeParse(value).success
    ? value
    : undefined
}

function optionalLines(
  value: Record<string, unknown>,
): Pick<ReviewDraft, 'startLine' | 'endLine' | 'side'> | undefined {
  const start = value['startLine']
  const end = value['endLine']
  if (start === undefined && end === undefined && value['side'] === undefined) return {}
  if (
    typeof start !== 'number' ||
    typeof end !== 'number' ||
    !Number.isInteger(start) ||
    !Number.isInteger(end)
  )
    return undefined
  if (start < 1 || end < start) return undefined
  const side = value['side']
  if (side !== 'old' && side !== 'new') return undefined
  return { startLine: start, endLine: end, side }
}

function parseDraft(value: unknown): ReviewDraft | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>
  if (!sourceControlSchemas.path.safeParse(row['path']).success) return null
  if (typeof row['text'] !== 'string') return null
  const text = bounded(row['text'], 8000)
  if (text.length === 0) return null
  const line =
    row['line'] === null
      ? null
      : typeof row['line'] === 'number' && Number.isInteger(row['line']) && row['line'] > 0
        ? row['line']
        : null
  if (row['line'] !== null && row['line'] !== undefined && line === null) return null
  const lines = optionalLines(row)
  if (lines === undefined) return null
  const context = typeof row['context'] === 'string' ? row['context'].slice(0, 8000) : undefined
  const comparisonId =
    row['comparisonId'] === undefined ? undefined : optionalOid(row['comparisonId'])
  if (row['comparisonId'] !== undefined && comparisonId === undefined) return null
  const id =
    typeof row['id'] === 'string' && row['id'].trim().length > 0
      ? row['id'].trim().slice(0, 128)
      : draftId()
  return {
    id,
    path: row['path'] as string,
    line,
    text,
    ...lines,
    ...(context !== undefined && context.length > 0 ? { context } : {}),
    ...(comparisonId !== undefined ? { comparisonId } : {}),
  }
}

function load(sessionId: string): readonly ReviewDraft[] {
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(storageKey(sessionId)) ?? 'null')
    if (!Array.isArray(raw)) return EMPTY
    const drafts = raw.flatMap((item) => {
      const draft = parseDraft(item)
      return draft ? [draft] : []
    })
    return drafts.length === 0 ? EMPTY : drafts.slice(-MAX_DRAFTS)
  } catch (error) {
    log.warn('Review drafts unavailable', { error: String(error) })
    return EMPTY
  }
}

/** Drops the in-memory copy so the next read comes back from session storage. */
export function dropReviewDraftMemory(): void {
  cache.clear()
}

export function subscribeReviewDrafts(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function readReviewDrafts(sessionId: string): readonly ReviewDraft[] {
  const hit = cache.get(sessionId)
  if (hit) return hit
  const loaded = load(sessionId)
  cache.set(sessionId, loaded)
  return loaded
}

export function writeReviewDrafts(sessionId: string, drafts: readonly ReviewDraft[]): void {
  const next = drafts.length === 0 ? EMPTY : drafts.slice(-MAX_DRAFTS)
  cache.set(sessionId, next)
  try {
    if (next.length === 0) sessionStorage.removeItem(storageKey(sessionId))
    else sessionStorage.setItem(storageKey(sessionId), JSON.stringify(next))
  } catch (error) {
    log.warn('Review drafts could not be saved', { error: String(error) })
  }
  emit()
}

export function useReviewDrafts(sessionId: string): readonly ReviewDraft[] {
  return useSyncExternalStore(subscribeReviewDrafts, () => readReviewDrafts(sessionId))
}

/** Saves a transcript line note onto the session's next message. */
export function appendReviewNote(
  sessionId: string,
  note: { path: string; line: number | null; text: string },
): void {
  const text = bounded(note.text, 8000)
  if (text.length === 0 || !sourceControlSchemas.path.safeParse(note.path).success) return
  const line = note.line !== null && Number.isInteger(note.line) && note.line > 0 ? note.line : null
  writeReviewDrafts(sessionId, [
    ...readReviewDrafts(sessionId),
    { id: draftId(), path: note.path, line, text },
  ])
}

/**
 * Remembers one selected review range per file, comparison, and side.
 * Extending the selection replaces the previous draft instead of stacking copies.
 */
export function rememberReviewRange(sessionId: string, range: ReviewRangeInput): void {
  if (
    !sourceControlSchemas.path.safeParse(range.path).success ||
    !sourceControlSchemas.oid.safeParse(range.comparisonId).success ||
    !Number.isInteger(range.startLine) ||
    !Number.isInteger(range.endLine) ||
    range.startLine < 1 ||
    range.endLine < range.startLine
  ) {
    return
  }
  const context = range.context.slice(0, 8000)
  const text =
    range.startLine === range.endLine
      ? `Selected ${range.side} line ${range.startLine}`
      : `Selected ${range.side} lines ${range.startLine}-${range.endLine}`
  const draft: ReviewDraft = {
    id: draftId(),
    path: range.path,
    line: range.side === 'new' ? range.startLine : null,
    text,
    side: range.side,
    startLine: range.startLine,
    endLine: range.endLine,
    ...(context.length > 0 ? { context } : {}),
    comparisonId: range.comparisonId,
  }
  const current = readReviewDrafts(sessionId)
  const index = current.findIndex(
    (item) =>
      item.path === range.path &&
      item.comparisonId === range.comparisonId &&
      item.side === range.side,
  )
  const next = current.slice()
  if (index >= 0) next[index] = { ...draft, id: current[index]!.id }
  else next.push(draft)
  writeReviewDrafts(sessionId, next)
}

export function reviewDraftChipLabel(draft: ReviewDraft): string {
  const file = draft.path.split(/[\\/]/).pop() ?? draft.path
  if (
    draft.startLine !== undefined &&
    draft.endLine !== undefined &&
    draft.endLine !== draft.startLine
  ) {
    return `${file}:${draft.startLine}-${draft.endLine}`
  }
  const line = draft.line ?? draft.startLine ?? null
  return line !== null ? `${file}:${line}` : file
}

export function formatReviewDrafts(drafts: readonly ReviewDraft[]): string {
  if (drafts.length === 0) return ''
  const lines = drafts.map((draft) => {
    const span =
      draft.startLine !== undefined && draft.endLine !== undefined
        ? `:${draft.startLine}${draft.endLine === draft.startLine ? '' : `-${draft.endLine}`}${
            draft.side ? ` (${draft.side})` : ''
          }`
        : draft.line !== null
          ? `:${draft.line}`
          : ''
    const head = `- ${draft.path}${span} — ${draft.text}`
    if (!draft.context || draft.context === draft.text) return head
    return `${head}\n${draft.context
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n')}`
  })
  return `Review notes on your changes:\n${lines.join('\n')}`
}

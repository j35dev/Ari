import { editDiffStat, type EditDiffStat } from './edit-diff'
import { resultHint } from './result-hint'
import { describeToolCall, effectiveToolName, humanizeToolName, type ToolKind } from './toolLabels'
import type { ToolGroupRow, TranscriptBlock } from './types'

export type ResponseToolState = 'running' | 'returned' | 'failed' | 'unanswered'

export const toolKindLabels: Record<ToolKind, string> = {
  run: 'Run',
  edit: 'Edit',
  read: 'Read',
  search: 'Search',
  todo: 'Plan',
}

export interface ResponseToolInfo {
  kind: ToolKind
  target: string
  title: string
  hint: string | null
  preview: string | null
  stat: EditDiffStat | null
}

const MAX_PREVIEW_INPUT = 64 * 1024
const MAX_PREVIEW_CHARS = 480
const PREVIEW_KEYS = [
  'output',
  'stdout',
  'text',
  'content',
  'result',
  'body',
  'message',
  'stderr',
  'error',
] as const
const cache = new WeakMap<
  TranscriptBlock,
  { result: TranscriptBlock | undefined; info: ResponseToolInfo }
>()

function contentText(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return null
  const texts: string[] = []
  let size = 0
  for (const part of value) {
    if (part === null || typeof part !== 'object') continue
    const record = part as Record<string, unknown>
    if (record.type !== 'text' || typeof record.text !== 'string') continue
    texts.push(record.text.slice(0, MAX_PREVIEW_CHARS))
    size += record.text.length
    if (size >= MAX_PREVIEW_CHARS) break
  }
  return texts.length > 0 ? texts.join('\n') : null
}

/** A bounded excerpt, never serialized image data or a megabyte-sized parse in a live card. */
export function responseResultPreview(raw: string | undefined): string | null {
  if (!raw || raw.length > MAX_PREVIEW_INPUT) return null
  let value: unknown = raw
  try {
    value = JSON.parse(raw) as unknown
  } catch {
    /* Plain terminal output is already text. */
  }
  let body = contentText(value)
  if (body === null && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    for (const key of PREVIEW_KEYS) {
      body = contentText(record[key])
      if (body !== null) break
    }
  }
  if (body === null || body.trim().length === 0) return null
  // Remove terminal SGR/control sequences from the excerpt, not from the stored result.
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g')
  const cleaned = body.replace(ansi, '').trim()
  const lines = cleaned.split('\n', 5)
  const excerpt = lines.slice(0, 4).join('\n').slice(0, MAX_PREVIEW_CHARS)
  return excerpt.length < cleaned.length ? `${excerpt.trimEnd()}…` : excerpt
}

/** Results are authoritative. A missing result must never become a success check on settle. */
export function responseToolState(
  result: TranscriptBlock | undefined,
  turnRunning: boolean,
): ResponseToolState {
  if (result !== undefined) return result.isError ? 'failed' : 'returned'
  return turnRunning ? 'running' : 'unanswered'
}

export const responseToolStateLabels: Record<ResponseToolState, string> = {
  running: 'Running',
  returned: 'Returned',
  failed: 'Failed',
  unanswered: 'No result',
}

/** Cache by immutable source identity so appending another call does not reparse old outputs. */
export function responseToolInfo(
  call: TranscriptBlock,
  result: TranscriptBlock | undefined,
): ResponseToolInfo {
  const previous = cache.get(call)
  if (previous !== undefined && previous.result === result) return previous.info
  const { kind, target } = describeToolCall(call)
  const info: ResponseToolInfo = {
    kind,
    target,
    title:
      target.length > 0
        ? `${toolKindLabels[kind]} ${target}`
        : humanizeToolName(effectiveToolName(call.name, call.argsJson)),
    hint:
      (result?.resultJson?.length ?? 0) <= MAX_PREVIEW_INPUT
        ? resultHint(kind, result?.resultJson, result?.isError === true)
        : null,
    preview: responseResultPreview(result?.resultJson),
    stat: kind === 'edit' ? editDiffStat(call.argsJson) : null,
  }
  cache.set(call, { result, info })
  return info
}

/** In a parallel run, a returned newest call must not conceal an earlier pending one. */
export function foregroundResponseCall(
  row: ToolGroupRow,
  turnRunning: boolean,
): TranscriptBlock | undefined {
  if (turnRunning) {
    for (let i = row.calls.length - 1; i >= 0; i--) {
      const call = row.calls[i]
      if (call && (!call.callId || !row.resultsByCallId.has(call.callId))) return call
    }
  }
  return row.calls[row.calls.length - 1]
}

import { useMemo, type ReactNode } from 'react'
import { CopyButton } from './CopyButton'
import { CodeBlock } from './CodeBlock'
import { DiffViewer } from '../diffs'
import {
  ariToolName,
  classifyToolCall,
  effectiveToolName,
  parseToolArgs,
  shortenPath,
  stringArg,
} from './toolLabels'
import type { ToolKind } from './toolLabels'
import type { TranscriptBlock } from './types'

/** Command keys providers use for shell invocations, most common first. */
const COMMAND_KEYS = ['command', 'cmd', 'script'] as const

const OLD_KEYS = ['old_string', 'old_str', 'oldText', 'old_text', 'original'] as const
const NEW_KEYS = ['new_string', 'new_str', 'newText', 'new_text', 'replacement', 'content', 'file_text'] as const
const DIFF_KEYS = ['diff', 'patch'] as const
const PATH_KEYS = ['file_path', 'filePath', 'target_file', 'notebook_path', 'path'] as const
const QUERY_KEYS = ['pattern', 'query', 'q', 'url'] as const
const FILTER_KEYS = ['path', 'include', 'glob', 'file_pattern'] as const

/** Cap for Before/After panels so a huge rewrite cannot flood the card. */
const MAX_PANEL_CHARS = 4000

/** A labeled value row: uppercase field name, mono body. */
function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-0.5 text-2xs uppercase tracking-wide text-fg-subtle">{label}</div>
      {children}
    </div>
  )
}

function MonoValue({ value }: { value: string }) {
  return (
    <div className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-sm bg-surface-0 p-1.5 font-mono text-2xs text-fg-muted">
      {value.length > MAX_PANEL_CHARS ? `${value.slice(0, MAX_PANEL_CHARS)}…` : value}
    </div>
  )
}

/** One structured section: a labeled mono body with a tinted left edge. */
function Panel({
  label,
  labelClass,
  value,
  borderClass,
}: {
  label: string
  labelClass: string
  value: string
  borderClass: string
}) {
  return (
    <Field label={<span className={labelClass}>{label}</span>}>
      <div className={`border-l-2 ${borderClass} pl-1.5`}>
        <MonoValue value={value} />
      </div>
    </Field>
  )
}

function FallbackJson({ argsJson }: { argsJson: string }) {
  let pretty = argsJson
  try {
    pretty = JSON.stringify(JSON.parse(argsJson) as unknown, null, 2) ?? argsJson
  } catch {
    // keep raw string
  }
  return <MonoValue value={pretty} />
}

const KIND_BODY: Record<ToolKind, (payload: Record<string, unknown>) => ReactNode> = {
  run: (payload) => {
    const command = stringArg(payload, COMMAND_KEYS)
    if (command === null) return null
    return (
      <Field label="command">
        <div className="rounded-sm bg-surface-0 p-1.5">
          <CodeBlock
            code={command}
            lang="shellscript"
            className="whitespace-pre-wrap break-all font-mono text-2xs"
          />
        </div>
      </Field>
    )
  },
  edit: (payload) => {
    const diff = stringArg(payload, DIFF_KEYS)
    if (diff !== null) {
      return (
        <Field label="patch">
          <DiffViewer diffText={diff} />
        </Field>
      )
    }
    const oldText = stringArg(payload, OLD_KEYS)
    const newText = stringArg(payload, NEW_KEYS)
    if (oldText === null && newText === null) return null
    return (
      <div className="space-y-1.5">
        {oldText !== null ? (
          <Panel label="Before" labelClass="text-danger" value={oldText} borderClass="border-danger-subtle" />
        ) : null}
        {newText !== null ? (
          <Panel label="After" labelClass="text-success" value={newText} borderClass="border-success-subtle" />
        ) : null}
      </div>
    )
  },
  read: (payload) => {
    const path = stringArg(payload, PATH_KEYS)
    if (path === null) return null
    return (
      <Field label="file">
        <MonoValue value={shortenPath(path)} />
      </Field>
    )
  },
  search: (payload) => {
    const query = stringArg(payload, QUERY_KEYS)
    if (query === null) return null
    const filter = stringArg(payload, FILTER_KEYS)
    return (
      <div className="space-y-1.5">
        <Field label="query">
          <MonoValue value={query} />
        </Field>
        {filter !== null ? (
          <Field label="scope">
            <MonoValue value={shortenPath(filter)} />
          </Field>
        ) : null}
      </div>
    )
  },
}

/**
 * Expanded body of one tool step, branded as an Ari tool: a header naming the
 * Ari identity ("Ari Run") beside the provider's own tool name, then the
 * arguments rendered per kind — highlighted command for runs, Before/After
 * panels for edits, labeled fields for reads and searches. Anything the
 * structured views cannot express falls back to the raw pretty-printed JSON.
 */
export function ToolCallDetails({ call }: { call: TranscriptBlock }) {
  const kind = useMemo(() => classifyToolCall(call), [call])
  const providerName = useMemo(() => effectiveToolName(call.name, call.argsJson), [call])
  const parsed = useMemo(() => parseToolArgs(call.argsJson), [call.argsJson])
  const body = parsed !== null ? KIND_BODY[kind](parsed.payload) : null

  return (
    <div className="space-y-1.5 p-2">
      <div className="flex items-center gap-1.5">
        <span className="text-2xs font-semibold text-fg">{ariToolName(kind)}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-fg-subtle" title={providerName}>
          {providerName}
        </span>
        {call.argsJson ? <CopyButton text={call.argsJson} /> : null}
      </div>
      {body ?? (call.argsJson ? <FallbackJson argsJson={call.argsJson} /> : null)}
    </div>
  )
}

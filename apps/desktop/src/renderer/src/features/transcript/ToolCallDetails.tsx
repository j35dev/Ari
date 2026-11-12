import { useMemo, type ReactNode } from 'react'
import { CopyButton } from './CopyButton'
import { CodeBlock } from './CodeBlock'
import { DiffViewer } from '../diffs'
import { editPayloadToDiff } from './edit-diff'
import {
  ariToolName,
  classifyToolCall,
  effectiveToolName,
  parseToolArgs,
  shortenPath,
  stringArg,
  todoItems,
} from './toolLabels'
import type { ToolKind } from './toolLabels'
import type { TranscriptBlock } from './types'

/** Command keys providers use for shell invocations, most common first. */
const COMMAND_KEYS = ['command', 'cmd', 'script'] as const

const OLD_KEYS = ['old_string', 'old_str', 'oldText', 'old_text', 'original'] as const
const NEW_KEYS = [
  'new_string',
  'new_str',
  'newText',
  'new_text',
  'replacement',
  'content',
  'file_text',
] as const
const DIFF_KEYS = ['diff', 'patch'] as const
const PATH_KEYS = ['file_path', 'filePath', 'target_file', 'notebook_path', 'path'] as const
const QUERY_KEYS = ['pattern', 'query', 'q', 'url'] as const
const FILTER_KEYS = ['path', 'include', 'glob', 'file_pattern'] as const

/** Cap for Before/After panels so a huge rewrite cannot flood the card. */
const MAX_PANEL_CHARS = 4000

/** Horizontal inset shared by everything in the well that is not a diff. */
const INSET = 'px-3'

/**
 * A labeled value: a quiet caption over its body. `bleed` lets the body run
 * edge to edge, so a diff's line tints reach the sides of the well.
 */
function Field({
  label,
  bleed = false,
  children,
}: {
  label: ReactNode
  bleed?: boolean
  children: ReactNode
}) {
  return (
    <div className="min-w-0">
      <div className={`mb-1 text-xs text-fg-subtle first-letter:uppercase ${INSET}`}>{label}</div>
      <div className={bleed ? 'border-t border-border' : INSET}>{children}</div>
    </div>
  )
}

function MonoValue({ value }: { value: string }) {
  return (
    <div className="max-h-60 overflow-auto whitespace-pre-wrap break-all font-mono">
      {value.length > MAX_PANEL_CHARS ? `${value.slice(0, MAX_PANEL_CHARS)}…` : value}
    </div>
  )
}

/** One side of an edit with no diff to show: a labeled mono body in the diff tint. */
function Panel({ label, value, tint }: { label: string; value: string; tint: string }) {
  return (
    <Field label={label} bleed>
      <div className={`px-3 py-1 text-fg ${tint}`}>
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
        <CodeBlock
          code={command}
          lang="shellscript"
          className="whitespace-pre-wrap break-all font-mono"
        />
      </Field>
    )
  },
  edit: (payload) => {
    const diff = stringArg(payload, DIFF_KEYS)
    if (diff !== null) {
      return (
        <Field label="patch" bleed>
          <DiffViewer diffText={diff} />
        </Field>
      )
    }
    const synthesized = editPayloadToDiff(payload)
    if (synthesized !== null) {
      return (
        <Field label="changes" bleed>
          <DiffViewer diffText={synthesized.diffText} />
        </Field>
      )
    }
    const oldText = stringArg(payload, OLD_KEYS)
    const newText = stringArg(payload, NEW_KEYS)
    if (oldText === null && newText === null) return null
    return (
      <div className="space-y-2">
        {oldText !== null ? <Panel label="Before" value={oldText} tint="bg-danger-subtle" /> : null}
        {newText !== null ? <Panel label="After" value={newText} tint="bg-success-subtle" /> : null}
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
      <div className="space-y-2">
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
  todo: (payload) => {
    const items = todoItems(payload)
    if (items === null) return null
    return (
      <div className={`space-y-1 ${INSET}`}>
        {items.map((item, i) => (
          <div key={i} className="flex items-start gap-2">
            <span
              role="img"
              aria-label={item.done ? 'done' : item.active ? 'in progress' : 'pending'}
              data-status={item.done ? 'done' : item.active ? 'working' : 'queued'}
              className="ari-status mt-[3px]"
            />
            <span
              className={`min-w-0 flex-1 whitespace-pre-wrap break-words ${
                item.done ? 'text-fg-subtle line-through' : 'text-fg-muted'
              }`}
            >
              {item.text}
            </span>
          </div>
        ))}
      </div>
    )
  },
}

/**
 * Expanded body of one tool step, branded as an Ari tool: a quiet 28px header
 * naming the Ari identity ("Ari Run") beside the provider's own tool name,
 * then the arguments rendered per kind — highlighted command for runs, a
 * synthesized unified diff for edits, checklists for plans, labeled fields for
 * reads and searches. Anything the structured views cannot express falls back
 * to the raw pretty-printed JSON.
 */
export function ToolCallDetails({ call }: { call: TranscriptBlock }) {
  const kind = useMemo(() => classifyToolCall(call), [call])
  const providerName = useMemo(() => effectiveToolName(call.name, call.argsJson), [call])
  const parsed = useMemo(() => parseToolArgs(call.argsJson), [call.argsJson])
  const body = parsed !== null ? KIND_BODY[kind](parsed.payload) : null

  return (
    <div className="space-y-2 pb-2.5 pt-1">
      <div className="flex h-7 items-center gap-2 pl-3 pr-1">
        <span className="text-xs font-medium text-fg">{ariToolName(kind)}</span>
        <span
          className="min-w-0 flex-1 truncate font-mono text-xs text-fg-subtle"
          title={providerName}
        >
          {providerName}
        </span>
        {call.argsJson ? <CopyButton text={call.argsJson} /> : null}
      </div>
      {body ??
        (call.argsJson ? (
          <div className={INSET}>
            <FallbackJson argsJson={call.argsJson} />
          </div>
        ) : null)}
    </div>
  )
}

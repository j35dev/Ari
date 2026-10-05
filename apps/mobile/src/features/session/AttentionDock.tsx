import { useState, type ReactNode } from 'react'
import type { RemoteApproval, RemoteInput } from '@ari/contracts/remote'
import { effectiveToolName, humanizeToolName, parseToolArgs, stringArg } from '@ari/ui/tool-labels'
import { summarizeToolDetail } from '../../lib/format'

const COMMAND_KEYS = ['command', 'cmd', 'script']
const PATH_KEYS = ['file_path', 'filePath', 'target_file', 'path']
const SUBJECT_KEYS = [...COMMAND_KEYS, ...PATH_KEYS, 'pattern', 'query', 'url']
/** Exact names only: a guess from a name fragment must never word a permission request. */
const EDIT_TOOLS = new Set([
  'edit',
  'multiedit',
  'write',
  'write_file',
  'apply_patch',
  'create_file',
])

function questionFor(name: string, payload: Record<string, unknown> | undefined): string {
  if (payload !== undefined) {
    if (stringArg(payload, COMMAND_KEYS) !== null) return 'Run this command?'
    if (EDIT_TOOLS.has(name.toLowerCase()) && stringArg(payload, PATH_KEYS) !== null)
      return 'Edit this file?'
  }
  return `Allow ${humanizeToolName(name)}?`
}

/**
 * What the agent is waiting on, in place of the composer: one request at a
 * time, the provider's own choices, and nothing else to tap by mistake.
 */
export function AttentionDock({
  approvals,
  inputs,
  onApprove,
  onAnswer,
}: {
  approvals: readonly RemoteApproval[]
  inputs: readonly RemoteInput[]
  onApprove: (approvalId: string, optionId: string) => Promise<void>
  onAnswer: (inputId: string, value: string) => Promise<void>
}): ReactNode {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const total = approvals.length + inputs.length
  const send = (answer: () => Promise<void>): void => {
    if (busy) return
    setBusy(true)
    setFailure(null)
    void answer()
      .catch((error: unknown) =>
        setFailure(error instanceof Error ? error.message : 'The computer refused that.'),
      )
      .finally(() => setBusy(false))
  }
  const [approval] = approvals
  const [input] = inputs
  return (
    <section
      aria-label="The agent is waiting for you"
      className="mobile-composer dock-rise shrink-0 px-4 pt-2"
    >
      <div className="rounded-3xl border border-warning bg-surface-1 p-4">
        {total > 1 && <p className="mb-2 text-xs text-fg-subtle">1 of {total}</p>}
        {approval !== undefined ? (
          <Approval
            key={approval.approvalId}
            approval={approval}
            busy={busy}
            onPick={(optionId) => send(() => onApprove(approval.approvalId, optionId))}
          />
        ) : input !== undefined ? (
          <Question
            key={input.inputId}
            input={input}
            busy={busy}
            onAnswer={(value) => send(() => onAnswer(input.inputId, value))}
          />
        ) : null}
        {failure !== null && (
          <p role="alert" className="mt-3 text-xs text-danger">
            {failure}
          </p>
        )}
      </div>
    </section>
  )
}

function Approval({
  approval,
  busy,
  onPick,
}: {
  approval: RemoteApproval
  busy: boolean
  onPick: (optionId: string) => void
}): ReactNode {
  const [full, setFull] = useState(false)
  const name = effectiveToolName(approval.toolName, approval.summaryJson)
  const payload = parseToolArgs(approval.summaryJson)?.payload
  const subject = payload === undefined ? null : stringArg(payload, SUBJECT_KEYS)
  const primary = approval.options.find((option) => option.kind?.startsWith('allow') === true)
  return (
    <>
      <h2 className="text-[17px] font-semibold tracking-tight">{questionFor(name, payload)}</h2>
      {subject !== null && (
        <pre className="step-detail mt-2 max-h-32 bg-surface-2 text-fg">{subject}</pre>
      )}
      <button
        type="button"
        aria-expanded={full}
        className="min-h-9 text-xs text-fg-subtle"
        onClick={() => setFull((shown) => !shown)}
      >
        {full ? 'Hide full request' : 'Show full request'}
      </button>
      {full && (
        <pre className="step-detail mb-1 max-h-40 bg-surface-2">
          {pretty(approval.summaryJson) || summarizeToolDetail(approval.summaryJson)}
        </pre>
      )}
      <div className="mt-1 space-y-2">
        {approval.options.map((option) => (
          <button
            key={option.optionId}
            type="button"
            disabled={busy}
            onClick={() => onPick(option.optionId)}
            className={
              option === primary
                ? 'primary-button w-full'
                : `secondary-button w-full bg-surface-2 ${option.kind?.startsWith('reject') === true ? 'text-danger' : ''}`
            }
          >
            {option.name}
          </button>
        ))}
      </div>
    </>
  )
}

function Question({
  input,
  busy,
  onAnswer,
}: {
  input: RemoteInput
  busy: boolean
  onAnswer: (value: string) => void
}): ReactNode {
  const [value, setValue] = useState('')
  const choices = parseChoices(input.choicesJson)
  return (
    <>
      <p className="text-xs text-fg-subtle">The agent is asking</p>
      <h2 className="mt-1 whitespace-pre-wrap text-[16px] font-medium leading-snug">
        {input.prompt}
      </h2>
      {choices.length > 0 ? (
        <div className="mt-3 space-y-2">
          {choices.map((choice) => (
            <button
              key={choice}
              type="button"
              disabled={busy}
              onClick={() => onAnswer(choice)}
              className="secondary-button w-full justify-start bg-surface-2 text-left"
            >
              {choice}
            </button>
          ))}
        </div>
      ) : (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (value.trim() !== '') onAnswer(value)
          }}
        >
          <input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            aria-label="Your answer"
            disabled={busy}
            className="min-h-12 min-w-0 flex-1 rounded-xl bg-surface-2 px-3"
          />
          <button type="submit" className="primary-button" disabled={busy || value.trim() === ''}>
            Send answer
          </button>
        </form>
      )}
    </>
  )
}

function parseChoices(choicesJson: string | null): string[] {
  if (choicesJson === null) return []
  try {
    const parsed: unknown = JSON.parse(choicesJson)
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : []
  } catch {
    return []
  }
}

function pretty(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json) as unknown, null, 2)
  } catch {
    return ''
  }
}

import { useId, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { ChevronDown } from 'lucide-react'
import type { ApprovalOption } from '@ari/contracts/common'
import type { Command } from '@ari/contracts/commands'
import { outlineButton, primaryButton } from '../../lib/recipes'
import { refuseButton } from './buttons'

type ApprovalRespond = Extract<Command, { type: 'approval.respond' }>

/**
 * How an approval was answered: the offered option by its exact id, or — for
 * an approval that recorded no options — the coarse decision. The two are not
 * interchangeable: the engine rejects any optionId the approval did not offer.
 */
export type ApprovalAnswer =
  { optionId: string } | { decision: NonNullable<ApprovalRespond['decision']> }

interface Choice {
  key: string
  name: string
  kind: string | null
  answer: ApprovalAnswer
}

/** The choices shown for an approval that recorded no options. */
const LEGACY_CHOICES: Choice[] = [
  { key: 'allow', name: 'Allow', kind: 'allow_once', answer: { decision: 'allow' } },
  {
    key: 'always-allow',
    name: 'Always allow',
    kind: 'allow_always',
    answer: { decision: 'always-allow' },
  },
  { key: 'deny', name: 'Deny', kind: 'reject_once', answer: { decision: 'deny' } },
]

function offeredChoices(options: ApprovalOption[]): Choice[] {
  return options.map((option) => ({
    key: option.optionId,
    name: option.name,
    kind: option.kind,
    answer: { optionId: option.optionId },
  }))
}

/**
 * Shortcut letters by kind, so `y`/`a`/`n` keep meaning what they always did.
 * A kind only ever picks which letter to print — never which option an answer
 * resolves to, which is the id's job.
 */
const SHORTCUTS: readonly (readonly [string, string])[] = [
  ['allow_once', 'Y'],
  ['allow_always', 'A'],
  ['reject_once', 'N'],
  ['reject_always', 'N'],
]

/**
 * One shortcut per option, first-come: when a provider offers two grants of a
 * kind, the second gets no letter rather than a duplicate that would fire the
 * wrong one.
 */
function shortcutKeys(choices: Choice[]): (string | null)[] {
  const taken = new Set<string>()
  return choices.map((choice) => {
    const entry = SHORTCUTS.find(([kind]) => kind === choice.kind)
    if (entry === undefined || taken.has(entry[1])) return null
    taken.add(entry[1])
    return entry[1]
  })
}

/** Underscores and hyphens become spaces so `Ari_delegation` reads as a name. */
export function formatApprovalToolName(name: string): string {
  return name.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
}

export interface ApprovalCardProps {
  /** Engine-side approval request id; surfaced for correlation/debugging. */
  approvalId: string
  /** Name of the tool the agent wants to run. */
  toolName: string
  /** JSON string describing what the tool intends to do. */
  summaryJson: string
  /**
   * The choices the provider offered, in its own order. Empty for journals
   * recorded before options were captured and for providers that advertised
   * none; both fall back to the decision vocabulary the engine still accepts.
   */
  options: ApprovalOption[]
  /** Called with the user's choice, ready to spread into `approval.respond`. */
  onRespond: (answer: ApprovalAnswer) => void
  /** 1-based position among pending approvals (T3's "1/N" counter). */
  position?: number
  /** Total pending approvals; renders the counter with `position`. */
  total?: number
}

function prettySummary(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json) as unknown, null, 2)
  } catch {
    return json
  }
}

/**
 * Pulls the single most meaningful line out of a tool summary — the command
 * for shell-like tools, the path for file tools — so the card reads at a
 * glance and raw JSON stays as backup detail.
 */
export function approvalHeadline(summaryJson: string): { label: string; detail: string } | null {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(summaryJson) as Record<string, unknown>
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const rawInput = parsed['rawInput']
  if (rawInput !== null && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    parsed = rawInput as Record<string, unknown>
  }
  const command = parsed['command'] ?? parsed['cmd']
  if (typeof command === 'string' && command.trim().length > 0) {
    return { label: 'Command', detail: command }
  }
  const path = parsed['path'] ?? parsed['file_path'] ?? parsed['filePath']
  if (typeof path === 'string' && path.trim().length > 0) {
    return { label: 'File', detail: path }
  }
  return null
}

function ShortcutHint({ children }: { children: string }) {
  return (
    <span aria-hidden="true" className="font-mono text-[11px] font-normal opacity-60">
      {children}
    </span>
  )
}

/** Ink for the one-off grant, an outline for the standing one, quiet for a refusal. */
function choiceClass(kind: string | null): string {
  if (kind === 'reject_once' || kind === 'reject_always') return refuseButton
  return kind === 'allow_always' ? outlineButton : primaryButton
}

/**
 * One pending approval as a row in the tab on the composer's top edge: the
 * needs-you dot, what is being asked with the command or path as a mono chip,
 * and exactly the choices the provider advertised at the right. Focusable;
 * the shortcuts `y`/`a`/`n` map onto the first allow, persistent allow, and
 * refusal when those exist. The full request opens below the row, inside the
 * same tab, from "Raw request".
 */
export function ApprovalCard({
  approvalId,
  toolName,
  summaryJson,
  options,
  onRespond,
  position,
  total,
}: ApprovalCardProps) {
  const choices = options.length > 0 ? offeredChoices(options) : LEGACY_CHOICES
  const keys = shortcutKeys(choices)
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const key = event.key.toUpperCase()
    const index = keys.indexOf(key)
    if (index === -1) return
    const choice = choices[index]
    if (choice === undefined) return
    event.preventDefault()
    onRespond(choice.answer)
  }

  const headline = approvalHeadline(summaryJson)
  const displayName = formatApprovalToolName(toolName)
  const [rawOpen, setRawOpen] = useState(false)
  const rawId = useId()

  return (
    <div
      data-approval-id={approvalId}
      role="group"
      aria-label={`Approval requested: ${toolName}`}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="px-3.5 py-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring"
    >
      {/* One row when it fits; the choices drop under the request when the
          pane is too narrow to hold both. */}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
        <div className="flex min-w-[min(14rem,100%)] flex-1 items-center gap-2.5">
          <span aria-hidden="true" className="ari-status" data-status="attention" />
          <p className="shrink-0 text-[13.5px] text-fg">Permission needed</p>
          <p className="min-w-0 shrink truncate text-[13.5px] text-fg-muted">{displayName}</p>
          {headline ? (
            <p className="flex min-w-0 flex-1 items-center gap-1.5" title={headline.detail}>
              <span className="shrink-0 text-xs text-fg-subtle">{headline.label}</span>
              <code className="min-w-0 truncate rounded-sm bg-fg/9 px-1.5 py-px font-mono text-[12.5px] text-fg">
                {headline.detail}
              </code>
            </p>
          ) : null}
        </div>
        <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          {/* The toggle is a bare disclosure; what it opens sits below the
              row so it can run the full width of the tab. */}
          <details
            className="shrink-0"
            open={rawOpen}
            onToggle={(event) => setRawOpen(event.currentTarget.open)}
          >
            <summary
              aria-controls={rawId}
              className="flex h-7 cursor-pointer select-none list-none items-center gap-1 rounded-md px-1.5 text-xs text-fg-subtle transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring [&::-webkit-details-marker]:hidden"
            >
              Raw request
              <ChevronDown
                size={12}
                strokeWidth={1.75}
                aria-hidden
                className={`transition-transform duration-[var(--ari-dur-fast)] motion-reduce:transition-none ${rawOpen ? 'rotate-180' : ''}`}
              />
            </summary>
          </details>
          {position !== undefined && total !== undefined && total > 1 ? (
            <span className="shrink-0 px-1 text-xs tabular-nums text-fg-subtle">
              {position}/{total}
            </span>
          ) : null}
          {choices.map((choice, index) => {
            const shortcut = keys[index] ?? null
            return (
              <button
                key={choice.key}
                type="button"
                title={shortcut === null ? choice.name : `${choice.name} (${shortcut})`}
                className={choiceClass(choice.kind)}
                onClick={() => onRespond(choice.answer)}
              >
                {choice.name}
                {shortcut === null ? null : <ShortcutHint>{shortcut}</ShortcutHint>}
              </button>
            )
          })}
        </div>
      </div>
      <pre
        id={rawId}
        hidden={!rawOpen}
        className="ari-scroll mt-2.5 max-h-40 overflow-auto rounded-lg border border-border bg-surface-0 px-3 py-2 font-mono text-[12.5px] leading-relaxed text-fg-muted"
      >
        {prettySummary(summaryJson)}
      </pre>
    </div>
  )
}

import { useId, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { ChevronDown } from 'lucide-react'
import type { ApprovalOption } from '@ari/contracts/common'
import type { Command } from '@ari/contracts/commands'
import { Shielded } from '@ari/ui/shielded'
import { useThemeColors } from '@ari/ui/theme-provider'

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
  /** Who asked when it is not the session's own agent, such as a Claude subagent. */
  requester?: string
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
    <span aria-hidden="true" className="key">
      {children}
    </span>
  )
}

/** Ink for the one-off grant, an outline for the standing one, quiet for a refusal. */
function choiceClass(kind: string | null): string {
  if (kind === 'reject_once' || kind === 'reject_always') return 'refuse'
  return kind === 'allow_always' ? 'outline' : 'primary'
}

const SAFE_COLOR = /^[#\w().,%\s/-]+$/
/**
 * The card's own styles, with the palette written in as values. It lives in a shadow
 * root (see Shielded) so theme CSS cannot relabel, reorder or hide a choice, and it
 * reads no custom properties because a theme can override or re-register those.
 */
function approvalCss(colors: Record<string, string>): string {
  const c = (role: string) => {
    const value = colors[role] ?? ''
    return SAFE_COLOR.test(value) ? value : 'CanvasText'
  }
  const wash = (percent: number) => `color-mix(in srgb,${c('fg')} ${percent}%,transparent)`
  return `*{box-sizing:border-box}[hidden]{display:none !important}p{margin:0}
.card{display:block;color:${c('fg')};font:13.5px/1.45 system-ui,sans-serif;text-align:left}
.row{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px}
.ask{display:flex;flex:1 1 0%;min-width:min(14rem,100%);align-items:center;gap:10px}
.dot{flex:none;width:7px;height:7px;margin:0 3.5px;border-radius:50%;background:${c('accent')};box-shadow:0 0 0 3px ${c('accent-subtle')}}
.title{flex-shrink:0}
.tool{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${c('fg-muted')}}
.headline{display:flex;flex:1 1 0%;min-width:0;align-items:center;gap:6px}
.label{flex-shrink:0;font-size:12px;color:${c('fg-subtle')}}
code{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-radius:4px;background:${wash(9)};padding:1px 6px;font:12.5px/1.45 ui-monospace,monospace}
.choices{margin-left:auto;display:flex;flex-shrink:0;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:6px}
summary{display:flex;height:28px;cursor:pointer;user-select:none;list-style:none;align-items:center;gap:4px;border-radius:6px;padding:0 6px;font-size:12px;color:${c('fg-subtle')}}
summary::-webkit-details-marker{display:none}
summary:hover{color:${c('fg')}}
.chev{transition:transform 150ms}.chev.open{transform:rotate(180deg)}
.count{flex-shrink:0;padding:0 4px;font-size:12px;font-variant-numeric:tabular-nums;color:${c('fg-subtle')}}
button{all:unset;box-sizing:border-box;display:inline-flex;height:28px;align-items:center;justify-content:center;gap:6px;border-radius:6px;padding:0 10px;font:500 13px/1 system-ui,sans-serif;cursor:pointer;transition:background-color 150ms,color 150ms}
:focus-visible{outline:2px solid ${c('accent-ring')};outline-offset:1px}
.primary{background:${c('fg')};color:${c('bg')}}
.primary:hover{background:color-mix(in srgb,${c('fg')} 90%,transparent)}
.outline{border:1px solid ${c('border-strong')}}
.outline:hover{background:${wash(6)}}
.refuse{color:${c('fg-muted')}}
.refuse:hover{background:${c('danger-subtle')};color:${c('danger')}}
.key{font:11px ui-monospace,monospace;opacity:.6}
pre{margin:10px 0 0;max-height:160px;overflow:auto;border:1px solid ${c('border')};border-radius:8px;background:${c('surface-0')};padding:8px 12px;font:12.5px/1.625 ui-monospace,monospace;color:${c('fg-muted')}}
@media (prefers-reduced-motion:reduce){.chev,button{transition:none}}`
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
  requester,
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
  const colors = useThemeColors()

  return (
    <div
      data-approval-id={approvalId}
      role="group"
      aria-label={`Approval requested: ${toolName}${requester ? ` by ${requester}` : ''}`}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="px-3.5 py-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring"
    >
      <Shielded css={approvalCss(colors)}>
        <div className="card">
          {/* One row when it fits; the choices drop under the request when the
              pane is too narrow to hold both. */}
          <div className="row">
            <div className="ask">
              <span aria-hidden="true" className="dot" />
              <p className="title">Permission needed</p>
              <p className="tool">
                {requester ? `${requester} · ` : null}
                {displayName}
              </p>
              {headline ? (
                <p className="headline" title={headline.detail}>
                  <span className="label">{headline.label}</span>
                  <code>{headline.detail}</code>
                </p>
              ) : null}
            </div>
            <div className="choices">
              {/* The toggle is a bare disclosure; what it opens sits below the
                  row so it can run the full width of the tab. */}
              <details open={rawOpen} onToggle={(event) => setRawOpen(event.currentTarget.open)}>
                <summary aria-controls={rawId}>
                  Raw request
                  <ChevronDown
                    size={12}
                    strokeWidth={1.75}
                    aria-hidden
                    className={rawOpen ? 'chev open' : 'chev'}
                  />
                </summary>
              </details>
              {position !== undefined && total !== undefined && total > 1 ? (
                <span className="count">
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
          <pre id={rawId} hidden={!rawOpen}>
            {prettySummary(summaryJson)}
          </pre>
        </div>
      </Shielded>
    </div>
  )
}

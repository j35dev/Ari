import type { KeyboardEvent } from 'react'
import { Button } from '@ari/ui/button'
import type { ApprovalOption } from '@ari/contracts/common'

/** The choices shown for journals recorded before options were captured. */
const LEGACY_CHOICES: ApprovalOption[] = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'always-allow', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
]

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
function shortcutKeys(options: ApprovalOption[]): (string | null)[] {
  const taken = new Set<string>()
  return options.map((option) => {
    const entry = SHORTCUTS.find(([kind]) => kind === option.kind)
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
   * The choices the provider offered, in its own order. Empty only for
   * journals recorded before options were captured, which fall back to the
   * decision vocabulary the engine still accepts.
   */
  options: ApprovalOption[]
  /** Called with the exact optionId the user chose. */
  onRespond: (optionId: string) => void
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
    <span aria-hidden="true" className="font-mono text-[10px] font-normal opacity-60">
      {children}
    </span>
  )
}

/**
 * Inline permission sheet for one pending approval, offering exactly the
 * choices the provider advertised. Focusable; the shortcuts `y`/`a`/`n` map
 * onto the first allow, persistent allow, and refusal when those exist.
 * The headline surfaces what would actually run; the full JSON collapses
 * under a "Raw" toggle.
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
  const choices = options.length > 0 ? options : LEGACY_CHOICES
  const keys = shortcutKeys(choices)
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const key = event.key.toUpperCase()
    const index = keys.indexOf(key)
    if (index === -1) return
    const choice = choices[index]
    if (choice === undefined) return
    event.preventDefault()
    onRespond(choice.optionId)
  }

  const headline = approvalHeadline(summaryJson)
  const displayName = formatApprovalToolName(toolName)

  return (
    <div
      data-approval-id={approvalId}
      role="group"
      aria-label={`Approval requested: ${toolName}`}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="px-3 py-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
    >
      <div className="flex items-start gap-2">
        <span aria-hidden="true" className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <p className="text-xs font-medium text-fg">Permission needed</p>
            <p className="min-w-0 truncate text-2xs text-fg-muted">{displayName}</p>
            {position !== undefined && total !== undefined && total > 1 ? (
              <span className="ml-auto shrink-0 text-2xs tabular-nums text-fg-subtle">
                {position}/{total}
              </span>
            ) : null}
          </div>

          {headline ? (
            <p className="mt-1 min-w-0 truncate font-mono text-xs text-fg" title={headline.detail}>
              <span className="mr-1.5 text-2xs uppercase tracking-[0.1em] text-fg-subtle">
                {headline.label}
              </span>
              {headline.detail}
            </p>
          ) : null}

          <details className="mt-1">
            <summary className="cursor-pointer select-none text-2xs text-fg-subtle transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring">
              Raw request
            </summary>
            <pre className="mt-1 max-h-24 overflow-auto font-mono text-2xs text-fg-muted">
              {prettySummary(summaryJson)}
            </pre>
          </details>

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {choices.map((choice, index) => {
              const shortcut = keys[index] ?? null
              const refusal =
                choice.kind === 'reject_once' || choice.kind === 'reject_always'
              return (
                <Button
                  key={choice.optionId}
                  variant={
                    refusal ? 'ghost' : choice.kind === 'allow_always' ? 'secondary' : 'primary'
                  }
                  size="sm"
                  title={shortcut === null ? choice.name : `${choice.name} (${shortcut})`}
                  className={refusal ? 'text-danger hover:bg-danger-subtle' : undefined}
                  onClick={() => onRespond(choice.optionId)}
                >
                  {choice.name}
                  {shortcut === null ? null : <ShortcutHint>{shortcut}</ShortcutHint>}
                </Button>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

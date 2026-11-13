import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Check, ChevronDown, GitPullRequest, Minus, Plus } from 'lucide-react'
import type { GitComparison, GitHistoryEntry } from '@ari/contracts/rpc'
import { Popover } from '@ari/ui/popover'
import { cx, sectionLabel } from '../../lib/recipes'

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring'
const trigger = `inline-flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-[13px] text-fg transition-colors hover:bg-fg/6 aria-expanded:bg-fg/9 disabled:pointer-events-none disabled:opacity-50 ${FOCUS}`
const item = `flex h-[30px] w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-[13px] text-fg transition-colors hover:bg-fg/6 focus-visible:bg-fg/6 focus-visible:outline-none disabled:pointer-events-none disabled:text-fg-subtle`
const meta = 'ml-auto shrink-0 pl-3 font-mono text-[11px] tabular-nums text-fg-subtle'

/** Arrow keys walk the enabled items; Escape is the popover's. */
function moveFocus(event: KeyboardEvent<HTMLElement>): void {
  const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End']
  if (!keys.includes(event.key)) return
  event.preventDefault()
  const items = [
    ...event.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])'),
  ]
  if (!items.length) return
  const at = items.indexOf(document.activeElement as HTMLElement)
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : (at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
  items[next]?.focus()
}

function MenuItem({
  checked,
  radio = true,
  icon,
  disabled,
  title,
  onSelect,
  children,
  detail,
}: {
  checked?: boolean
  radio?: boolean
  icon?: ReactNode
  disabled?: boolean
  title?: string
  onSelect: () => void
  children: ReactNode
  detail?: ReactNode
}) {
  return (
    <button
      type="button"
      role={radio ? 'menuitemradio' : 'menuitem'}
      aria-checked={radio ? Boolean(checked) : undefined}
      data-checked={checked ? '' : undefined}
      tabIndex={-1}
      disabled={disabled}
      title={title}
      onClick={onSelect}
      className={item}
    >
      <span className="flex w-3.5 shrink-0 justify-center text-fg-subtle" aria-hidden>
        {checked ? <Check size={14} className="text-fg" /> : icon}
      </span>
      <span className="min-w-0 truncate">{children}</span>
      {detail ? <span className={meta}>{detail}</span> : null}
    </button>
  )
}

function Totals({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <>
      {additions ? <span className="text-success">+{additions}</span> : null}
      {additions && deletions ? ' ' : null}
      {deletions ? <span className="text-danger">−{deletions}</span> : null}
    </>
  )
}

/** A popover menu that focuses its checked (or first) item on open. */
function Menu({
  open,
  onOpenChange,
  button,
  buttonLabel,
  buttonTitle,
  label,
  width = 'w-72',
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  button: ReactNode
  buttonLabel: string
  buttonTitle?: string
  label: string
  width?: string
  children: ReactNode
}) {
  const list = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => {
      const target =
        list.current?.querySelector<HTMLElement>('[data-checked]:not([disabled])') ??
        list.current?.querySelector<HTMLElement>('[role^="menuitem"]:not([disabled])')
      target?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [open])
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger
        aria-haspopup="menu"
        aria-label={buttonLabel}
        title={buttonTitle}
        className={trigger}
      >
        {button}
      </Popover.Trigger>
      <Popover.Content side="bottom" align="start" sideOffset={4} bare>
        <div
          ref={list}
          role="menu"
          aria-label={label}
          onKeyDown={moveFocus}
          className={cx(
            'ari-scroll max-h-[min(70vh,34rem)] overflow-y-auto rounded-[10px] border border-border-strong bg-surface-1 p-[5px] shadow-3',
            width,
          )}
        >
          {children}
        </div>
      </Popover.Content>
    </Popover>
  )
}

export interface ScopeTurn {
  turnId: string
  label: string
  stable: boolean
  error?: string
  /** "2m ago" once the session's history has been read. */
  when?: string
}

/** The header's scope picker: what to compare, which turn or commit, or pull requests. */
export function ScopeMenu({
  label,
  tooltip,
  comparison,
  requests,
  totals,
  sessionScoped,
  branchLabel,
  turns,
  commits,
  hostReason,
  requestsReason,
  bulk,
  onOpen,
  onComparison,
  onRequests,
}: {
  label: string
  tooltip?: string
  comparison: GitComparison
  requests: boolean
  /** Totals of the comparison on screen, the only one known without another read. */
  totals: { additions: number; deletions: number } | null
  sessionScoped: boolean
  branchLabel: string
  turns: ScopeTurn[]
  commits: GitHistoryEntry[]
  /** Why branch and commit comparisons are off (a remote host); null when on. */
  hostReason: string | null
  requestsReason: string | null
  bulk: {
    stage: (() => void) | null
    unstage: (() => void) | null
    reason: string | null
  } | null
  onOpen?: () => void
  onComparison: (comparison: GitComparison) => void
  onRequests: () => void
}) {
  const [open, setOpen] = useState(false)
  const current = (kind: GitComparison['kind']): boolean => !requests && comparison.kind === kind
  const pick = (next: GitComparison): void => {
    setOpen(false)
    onComparison(next)
  }
  const detail = (kind: GitComparison['kind']) =>
    current(kind) && totals ? <Totals {...totals} /> : null
  return (
    <Menu
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) onOpen?.()
      }}
      buttonLabel={`Review scope: ${label}`}
      buttonTitle={tooltip}
      label="Review scope"
      button={
        <>
          <span className="truncate">{label}</span>
          <ChevronDown size={14} aria-hidden className="shrink-0 text-fg-subtle" />
        </>
      }
    >
      <MenuItem
        checked={current('working-tree')}
        onSelect={() => pick({ kind: 'working-tree' })}
        detail={detail('working-tree')}
      >
        Working tree
      </MenuItem>
      <MenuItem
        checked={current('staged')}
        onSelect={() => pick({ kind: 'staged' })}
        detail={detail('staged')}
      >
        Staged
      </MenuItem>
      <MenuItem
        checked={current('unstaged')}
        onSelect={() => pick({ kind: 'unstaged' })}
        detail={detail('unstaged')}
      >
        Unstaged
      </MenuItem>
      <MenuItem
        checked={current('branch')}
        disabled={hostReason !== null}
        title={hostReason ?? undefined}
        onSelect={() => pick(comparison.kind === 'branch' ? comparison : { kind: 'branch' })}
        detail={hostReason ? 'unavailable' : detail('branch')}
      >
        {branchLabel}
      </MenuItem>
      {sessionScoped ? (
        <MenuItem
          checked={current('session')}
          onSelect={() => pick({ kind: 'session' })}
          detail={detail('session')}
        >
          This session
        </MenuItem>
      ) : null}
      {turns.length ? (
        <div role="group" aria-label="Turns">
          <p className={cx(sectionLabel, 'px-2 pb-1 pl-[30px] pt-2 text-[11px]')} aria-hidden>
            Turns
          </p>
          {turns.map((turn) => (
            <MenuItem
              key={turn.turnId}
              checked={!requests && comparison.kind === 'turn' && comparison.turnId === turn.turnId}
              disabled={!turn.stable}
              title={
                turn.stable ? undefined : (turn.error ?? 'This turn has no stable checkpoint.')
              }
              onSelect={() => pick({ kind: 'turn', turnId: turn.turnId })}
              detail={
                !turn.stable ? (
                  'unavailable'
                ) : comparison.kind === 'turn' && comparison.turnId === turn.turnId && totals ? (
                  <Totals {...totals} />
                ) : (
                  turn.when
                )
              }
            >
              {turn.label}
            </MenuItem>
          ))}
        </div>
      ) : null}
      {commits.length || comparison.kind === 'commit' ? (
        <div role="group" aria-label="Recent commits">
          <p className={cx(sectionLabel, 'px-2 pb-1 pl-[30px] pt-2 text-[11px]')} aria-hidden>
            Recent commits
          </p>
          {comparison.kind === 'commit' &&
          !commits.some((commit) => commit.oid === comparison.ref) ? (
            <MenuItem checked={!requests} onSelect={() => pick(comparison)}>
              Commit {comparison.ref.slice(0, 7)}
            </MenuItem>
          ) : null}
          {commits.map((commit) => (
            <MenuItem
              key={commit.oid}
              checked={!requests && comparison.kind === 'commit' && comparison.ref === commit.oid}
              disabled={hostReason !== null}
              title={hostReason ?? commit.subject}
              onSelect={() => pick({ kind: 'commit', ref: commit.oid })}
              detail={commit.oid.slice(0, 7)}
            >
              {commit.subject}
            </MenuItem>
          ))}
        </div>
      ) : null}
      <div className="mx-0.5 my-[5px] h-px bg-border" role="separator" />
      <MenuItem
        checked={requests}
        icon={<GitPullRequest size={14} />}
        disabled={requestsReason !== null}
        title={requestsReason ?? undefined}
        onSelect={() => {
          setOpen(false)
          onRequests()
        }}
      >
        Pull requests
      </MenuItem>
      {bulk && (bulk.stage || bulk.unstage) ? (
        <>
          <div className="mx-0.5 my-[5px] h-px bg-border" role="separator" />
          {bulk.stage ? (
            <MenuItem
              radio={false}
              icon={<Plus size={14} />}
              disabled={bulk.reason !== null}
              title={bulk.reason ?? undefined}
              onSelect={() => {
                setOpen(false)
                bulk.stage?.()
              }}
            >
              Stage all
            </MenuItem>
          ) : null}
          {bulk.unstage ? (
            <MenuItem
              radio={false}
              icon={<Minus size={14} />}
              disabled={bulk.reason !== null}
              title={bulk.reason ?? undefined}
              onSelect={() => {
                setOpen(false)
                bulk.unstage?.()
              }}
            >
              Unstage all
            </MenuItem>
          ) : null}
        </>
      ) : null}
    </Menu>
  )
}

/** Shown beside the scope while a branch is compared: which ref it is compared against. */
export function BasePicker({
  base,
  automatic,
  refs,
  onBase,
}: {
  base: string | undefined
  /** The ref the engine picks when none is chosen. */
  automatic: string
  refs: string[]
  onBase: (base: string | undefined) => void
}) {
  const [open, setOpen] = useState(false)
  const pick = (next: string | undefined): void => {
    setOpen(false)
    onBase(next)
  }
  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      buttonLabel={`Compare against ${base ?? automatic}`}
      label="Compare against"
      width="w-64"
      button={
        <>
          <span className="text-fg-subtle">vs</span>
          <span className="truncate">{base ?? automatic}</span>
          <ChevronDown size={14} aria-hidden className="shrink-0 text-fg-subtle" />
        </>
      }
    >
      <MenuItem checked={base === undefined} onSelect={() => pick(undefined)} detail="auto">
        {automatic}
      </MenuItem>
      {refs
        .filter((ref) => ref !== automatic || base === ref)
        .map((ref) => (
          <MenuItem key={ref} checked={base === ref} onSelect={() => pick(ref)}>
            {ref}
          </MenuItem>
        ))}
    </Menu>
  )
}

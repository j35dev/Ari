import { useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Check } from 'lucide-react'
import { createLogger } from '@ari/shared/logger'
import { Button } from '@ari/ui/button'
import { Input } from '@ari/ui/input'
import { Select } from '@ari/ui/select'
import { Switch } from '@ari/ui/switch'
import { SettingsPage } from './SettingsPage'
import { SettingsRow } from './SettingsRow'
import { useEngineSettings } from './useEngineSettings'
import { delegationSettingsSchema } from '@ari/contracts/agent-control'

const log = createLogger('settings:permissions')

const PERMISSION_MODES = [
  { value: 'ask', label: 'Ask', hint: 'Confirm every tool run before it executes.' },
  {
    value: 'allow-edits',
    label: 'Allow edits',
    hint: 'Auto-approve file edits; still confirm commands.',
  },
  { value: 'full', label: 'Full access', hint: 'Run every tool without confirmation.' },
] as const

const APPROVAL_OPTIONS = [
  { value: 'first-per-root', label: 'First request per root' },
  { value: 'always', label: 'Every request' },
  { value: 'never', label: 'No approval' },
] as const

const NUMBER_FIELD_CLASS =
  'w-20 [&_input]:text-right [&_input]:tabular-nums [&_input]:[appearance:textfield] [&_input::-webkit-inner-spin-button]:appearance-none [&_input::-webkit-outer-spin-button]:appearance-none'

export type PermissionMode = (typeof PERMISSION_MODES)[number]['value']

/** Permissions settings page: default permission mode + always-allow allowlist. */
export function PermissionsSettings() {
  const { settings, update } = useEngineSettings()
  const [draft, setDraft] = useState('')
  const modeRefs = useRef<(HTMLButtonElement | null)[]>([])
  const entries = settings?.permissions.allowlist ?? []
  const mode = settings?.sessions.defaultPermissionMode ?? 'ask'
  const delegation = settings?.delegation ?? delegationSettingsSchema.parse({})
  // Keeps one tab stop in the group if the stored mode is not one we render.
  const knownMode = PERMISSION_MODES.some((m) => m.value === mode)

  const persist = (patch: Parameters<typeof update>[0]) => {
    void update(patch).catch((error: unknown) => {
      log.warn('failed to persist permissions settings', { error })
    })
  }

  const addEntry = () => {
    const value = draft.trim()
    if (!value || entries.includes(value)) return
    persist({ permissions: { allowlist: [...entries, value] } })
    setDraft('')
  }

  const removeEntry = (index: number) => {
    persist({ permissions: { allowlist: entries.filter((_, i) => i !== index) } })
  }

  const selectMode = (next: PermissionMode) => {
    persist({ sessions: { defaultPermissionMode: next } })
  }

  /** Arrow keys move selection and focus together, per the ARIA radiogroup pattern. */
  const onModeKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight'
    const backward = event.key === 'ArrowUp' || event.key === 'ArrowLeft'
    if (!forward && !backward) return
    event.preventDefault()
    const count = PERMISSION_MODES.length
    const next = (index + (forward ? 1 : -1) + count) % count
    const target = PERMISSION_MODES[next]
    if (!target) return
    selectMode(target.value)
    modeRefs.current[next]?.focus()
  }

  return (
    <SettingsPage
      title="Permissions"
      description="How much agents may do without asking you first."
    >
      <section aria-labelledby="permissions-mode-heading" className="space-y-3">
        <h2 id="permissions-mode-heading" className="text-sm font-medium">
          Default permission mode
        </h2>
        <div role="radiogroup" aria-label="Default permission mode" className="grid gap-2">
          {PERMISSION_MODES.map((m, index) => {
            const selected = mode === m.value
            return (
              <button
                key={m.value}
                ref={(node) => {
                  modeRefs.current[index] = node
                }}
                type="button"
                role="radio"
                aria-checked={selected}
                tabIndex={selected || (!knownMode && index === 0) ? 0 : -1}
                onClick={() => selectMode(m.value)}
                onKeyDown={(event) => onModeKeyDown(event, index)}
                className={`flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring ${
                  selected
                    ? 'border-accent/60 bg-accent-subtle'
                    : 'border-border bg-glass-input hover:border-border-strong hover:bg-glass-hover'
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-fg">{m.label}</span>
                  <span className="block text-xs leading-relaxed text-fg-muted">{m.hint}</span>
                </span>
                {selected ? (
                  <Check size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
                ) : null}
              </button>
            )
          })}
        </div>
      </section>

      <section aria-labelledby="delegation-heading">
        <h2 id="delegation-heading" className="text-sm font-medium">
          Child session delegation
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-fg-muted">
          Agents may create ordinary child sessions. Isolated workers use separate Git worktrees;
          changes return only after explicit integration.
        </p>
        <div className="mt-3">
          <SettingsRow
            label="Enable delegation"
            hint="Let agents spawn child sessions from this workspace."
          >
            <Switch
              checked={delegation.enabled}
              onCheckedChange={(checked) => persist({ delegation: { enabled: checked } })}
              aria-label="Enable delegation"
            />
          </SettingsRow>
          <SettingsRow
            label="Shared workspaces"
            hint="Workers can edit parent files instead of using an isolated worktree."
          >
            <Switch
              checked={delegation.allowSharedWorkspace}
              onCheckedChange={(checked) =>
                persist({ delegation: { allowSharedWorkspace: checked } })
              }
              aria-label="Allow shared workspaces"
            />
          </SettingsRow>
          <SettingsRow
            label="Recursive delegation"
            hint="Allow child sessions to spawn children of their own."
          >
            <Switch
              checked={delegation.recursiveDelegation}
              onCheckedChange={(checked) =>
                persist({ delegation: { recursiveDelegation: checked } })
              }
              aria-label="Allow children to delegate"
            />
          </SettingsRow>
          {(
            [
              [
                'maxConcurrentChildren',
                'Concurrent children per root',
                'How many child sessions may run at once under one root.',
                32,
              ],
              [
                'maxChildrenPerSession',
                'Children per session',
                'Cap on children a single session can spawn.',
                100,
              ],
              [
                'maxDepth',
                'Maximum depth',
                'How many nested generations of children are allowed.',
                8,
              ],
            ] as const
          ).map(([key, label, hint, max]) => (
            <SettingsRow key={key} label={label} hint={hint}>
              <Input
                aria-label={label}
                type="number"
                min={1}
                max={max}
                value={delegation[key]}
                className={NUMBER_FIELD_CLASS}
                onChange={(event) => {
                  const value = Number(event.target.value)
                  if (Number.isInteger(value) && value >= 1 && value <= max)
                    persist({ delegation: { [key]: value } })
                }}
              />
            </SettingsRow>
          ))}
          <SettingsRow
            label="Delegation approval"
            hint="When Ari asks before a child session is created."
          >
            <Select
              aria-label="Delegation approval"
              value={delegation.approvalMode}
              className="w-56"
              options={[...APPROVAL_OPTIONS]}
              onValueChange={(value) =>
                persist({
                  delegation: {
                    approvalMode: delegationSettingsSchema.shape.approvalMode.parse(value),
                  },
                })
              }
            />
          </SettingsRow>
          <SettingsRow
            label="Default child workspace"
            hint="Isolated worktrees keep parent files unchanged until you integrate."
          >
            <Select
              aria-label="Default child workspace"
              value={delegation.defaultWorkspaceMode}
              className="w-56"
              options={[
                { value: 'isolated', label: 'Isolated Git worktree' },
                {
                  value: 'shared',
                  label: 'Shared workspace',
                  disabled: !delegation.allowSharedWorkspace,
                },
              ]}
              onValueChange={(value) =>
                persist({
                  delegation: {
                    defaultWorkspaceMode:
                      delegationSettingsSchema.shape.defaultWorkspaceMode.parse(value),
                  },
                })
              }
            />
          </SettingsRow>
        </div>
      </section>

      <section aria-labelledby="permissions-allowlist-heading" className="space-y-3">
        <h2 id="permissions-allowlist-heading" className="text-sm font-medium">
          Always-allow commands
        </h2>
        <p className="text-sm text-fg-muted">
          Exact commands listed here run without confirmation. Engine enforcement lands later.
        </p>
        <div className="flex gap-2">
          <Input
            aria-label="Command to always allow"
            placeholder="e.g. git status"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addEntry()
            }}
            className="flex-1"
          />
          <Button onClick={addEntry} disabled={draft.trim().length === 0}>
            Add
          </Button>
        </div>
        {entries.length === 0 ? (
          <p className="text-sm text-fg-subtle">Nothing is always-allowed yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {entries.map((entry, index) => (
              <li
                key={entry}
                className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface-1 px-3 py-2"
              >
                <code className="font-mono text-xs text-fg">{entry}</code>
                <Button
                  variant="danger"
                  size="sm"
                  aria-label={`Remove ${entry}`}
                  onClick={() => removeEntry(index)}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </SettingsPage>
  )
}

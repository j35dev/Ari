import { useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createLogger } from '@ari/shared/logger'
import { Button } from '@ari/ui/button'
import { Input } from '@ari/ui/input'
import { Select } from '@ari/ui/select'
import { Switch } from '@ari/ui/switch'
import { SettingsPage } from './SettingsPage'
import { SettingsRow } from './SettingsRow'
import {
  SETTINGS_CARD_CLASS,
  SETTINGS_HINT_CLASS,
  SETTINGS_LABEL_CLASS,
  SettingsSection,
} from './SettingsSection'
import { useEngineSettings } from './useEngineSettings'
import { delegationSettingsSchema } from '@ari/contracts/agent-control'
import { DEFAULT_PERMISSION_MODE } from '@ari/contracts/common'

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
  const mode = settings?.sessions.defaultPermissionMode ?? DEFAULT_PERMISSION_MODE
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

  const numberRows = [
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
    ['maxDepth', 'Maximum depth', 'How many nested generations of children are allowed.', 8],
  ] as const

  return (
    <SettingsPage
      title="Permissions"
      description="How much agents may do without asking you first."
    >
      <SettingsSection
        title="Default permission mode"
        headingId="permissions-mode-heading"
        description="New sessions start in this mode."
        bare
      >
        <div role="radiogroup" aria-label="Default permission mode" className={SETTINGS_CARD_CLASS}>
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
                className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-fg/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring"
              >
                <span
                  aria-hidden="true"
                  className={`flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors ${
                    selected ? 'border-fg bg-fg' : 'border-border-strong'
                  }`}
                >
                  {selected ? <span className="size-1.5 rounded-full bg-bg" /> : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`block ${SETTINGS_LABEL_CLASS}`}>{m.label}</span>
                  <span className={`mt-0.5 block ${SETTINGS_HINT_CLASS}`}>{m.hint}</span>
                </span>
              </button>
            )
          })}
        </div>
      </SettingsSection>

      <SettingsSection
        title="Child session delegation"
        headingId="delegation-heading"
        description="Agents may create ordinary child sessions. Isolated workers use separate Git worktrees; changes return only after explicit integration."
      >
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
            onCheckedChange={(checked) => persist({ delegation: { recursiveDelegation: checked } })}
            aria-label="Allow children to delegate"
          />
        </SettingsRow>
        <SettingsRow
          label="Report results to the parent"
          hint="When a child finishes, wake its idle parent with the result instead of leaving it to poll."
        >
          <Switch
            checked={delegation.autoDeliverResults}
            onCheckedChange={(checked) => persist({ delegation: { autoDeliverResults: checked } })}
            aria-label="Report child results to the parent"
          />
        </SettingsRow>
        <SettingsRow
          label="Stop children with their parent"
          hint="Stopping a session also stops the children it delegated to."
        >
          <Switch
            checked={delegation.cascadeStop}
            onCheckedChange={(checked) => persist({ delegation: { cascadeStop: checked } })}
            aria-label="Stop children with their parent"
          />
        </SettingsRow>
        <SettingsRow
          label="Run Ari's own commands without asking"
          hint="Skip the permission prompt for `ari` commands. Installing the Ari skill still asks because it changes your agent configuration."
        >
          <Switch
            checked={delegation.autoApproveCli}
            onCheckedChange={(checked) => persist({ delegation: { autoApproveCli: checked } })}
            aria-label="Run Ari's own commands without asking"
          />
        </SettingsRow>
        <SettingsRow
          label="Delegation approval"
          hint="When Ari asks before creating a child or project lead. No approval is the default."
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
      </SettingsSection>

      <SettingsSection
        title="Delegation limits"
        description="Caps that keep a delegation tree from running away."
      >
        {numberRows.map(([key, label, hint, max]) => (
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
          label="Tree token cap"
          hint="Pause child turns once the whole delegation tree reaches this many tokens. Empty is off."
        >
          <Input
            aria-label="Tree token cap"
            type="number"
            min={1}
            placeholder="Off"
            value={delegation.maxTreeTokens ?? ''}
            className={NUMBER_FIELD_CLASS}
            onChange={(event) => {
              const raw = event.target.value.trim()
              if (raw === '') {
                persist({ delegation: { maxTreeTokens: null } })
                return
              }
              const value = Number(raw)
              if (Number.isInteger(value) && value >= 1)
                persist({ delegation: { maxTreeTokens: value } })
            }}
          />
        </SettingsRow>
        <SettingsRow
          label="Tree cost cap"
          hint="Pause child turns once the delegation tree reaches this cost. Empty is off; unpriced providers are not counted."
        >
          <Input
            aria-label="Tree cost cap"
            type="number"
            min={0.01}
            step={0.01}
            placeholder="Off"
            value={delegation.maxTreeCostUsd ?? ''}
            className={NUMBER_FIELD_CLASS}
            onChange={(event) => {
              const raw = event.target.value.trim()
              if (raw === '') {
                persist({ delegation: { maxTreeCostUsd: null } })
                return
              }
              const value = Number(raw)
              if (Number.isFinite(value) && value > 0)
                persist({ delegation: { maxTreeCostUsd: value } })
            }}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="Always-allow commands"
        headingId="permissions-allowlist-heading"
        description="Exact commands listed here run without confirmation. Engine enforcement lands later."
      >
        <div className="flex gap-2 px-4 py-3.5">
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
          <p className={`px-4 py-3.5 ${SETTINGS_HINT_CLASS}`}>Nothing is always-allowed yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {entries.map((entry, index) => (
              <li key={entry} className="flex items-center justify-between gap-2 px-4 py-2.5">
                <code className="min-w-0 break-all font-mono text-[12.5px] text-fg-muted">
                  {entry}
                </code>
                <Button
                  variant="ghost"
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
      </SettingsSection>
    </SettingsPage>
  )
}

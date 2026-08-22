import { useState } from 'react'
import { createLogger } from '@ari/shared/logger'
import { Button } from '@ari/ui/button'
import { Input } from '@ari/ui/input'
import { SettingsPage } from './SettingsPage'
import { useEngineSettings } from './useEngineSettings'

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

export type PermissionMode = (typeof PERMISSION_MODES)[number]['value']

/** Permissions settings page: default permission mode + always-allow allowlist. */
export function PermissionsSettings() {
  const { settings, update } = useEngineSettings()
  const [draft, setDraft] = useState('')
  const entries = settings?.permissions.allowlist ?? []
  const mode = settings?.sessions.defaultPermissionMode ?? 'ask'

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

  return (
    <SettingsPage
      title="Permissions"
      description="How much agents may do without asking you first."
    >
      <section aria-labelledby="permissions-mode-heading" className="space-y-3">
        <h2 id="permissions-mode-heading" className="text-sm font-medium">
          Default permission mode
        </h2>
        <fieldset className="space-y-2">
          <legend className="sr-only">Default permission mode</legend>
          {PERMISSION_MODES.map((m) => (
            <label
              key={m.value}
              className="flex items-start gap-3 rounded-md border border-border bg-surface-1 p-3"
            >
              <input
                type="radio"
                name="default-permission-mode"
                value={m.value}
                checked={mode === m.value}
                onChange={() => selectMode(m.value)}
                className="mt-0.5 accent-accent"
              />
              <span>
                <span className="block text-sm text-fg">{m.label}</span>
                <span className="block text-xs text-fg-muted">{m.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
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

import { useEffect, useRef, useState } from 'react'
import { responseStyleSchema, type ResponseStyle } from '@ari/contracts/settings'
import { createLogger } from '@ari/shared/logger'
import { Select } from '@ari/ui/select'
import { responseStyles } from '../transcript/response-styles'
import { SettingsRow } from './SettingsRow'

const log = createLogger('settings:response-style')
const options = responseStyles.map(({ id, label }) => ({ value: id, label }))

/** Keep this choice small: changing a response layout does not require another theme picker. */
export function ResponseStyleSetting({
  value,
  onChange,
}: {
  value: ResponseStyle
  onChange: (value: ResponseStyle) => Promise<unknown>
}) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(false)
  const inFlight = useRef(false)
  const fieldRef = useRef<HTMLElement>(null)
  const restoreFocus = useRef(false)
  const restoreFrom = useRef<Element | null>(null)
  const selected = responseStyles.find((style) => style.id === value) ?? responseStyles[0]

  useEffect(() => {
    if (saving || !restoreFocus.current) return
    restoreFocus.current = false
    // Closing the select cannot refocus a disabled trigger during a save.
    // Restore it after saving, but never steal focus from a user who moved on.
    if (
      document.activeElement === document.body ||
      document.activeElement === restoreFrom.current
    ) {
      fieldRef.current
        ?.querySelector<HTMLButtonElement>('button[aria-label="Response style"]')
        ?.focus({ preventScroll: true })
    }
  }, [saving])

  const select = async (raw: string): Promise<void> => {
    const parsed = responseStyleSchema.safeParse(raw)
    if (!parsed.success || parsed.data === value || inFlight.current) return
    inFlight.current = true
    restoreFocus.current = true
    restoreFrom.current = document.activeElement
    setSaving(true)
    setError(false)
    try {
      // The engine broadcasts the saved value to all open sessions. Do not
      // pretend a rejected save succeeded by applying an optimistic preference.
      await onChange(parsed.data)
    } catch (cause) {
      setError(true)
      log.warn('failed to persist response style', { error: cause })
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }

  return (
    <section ref={fieldRef} aria-label="Response style" className="mb-4">
      <SettingsRow
        label="Response style"
        hint="Choose how responses and tool calls look. Applies to open desktop chats without restarting."
      >
        <Select
          aria-label="Response style"
          value={value}
          options={options}
          disabled={saving}
          onValueChange={(next) => void select(next)}
          className="min-w-40"
        />
      </SettingsRow>
      <p className="mt-2 text-xs leading-relaxed text-fg-muted">{selected.description}</p>
      {saving ? (
        <p role="status" className="mt-1 text-xs text-fg-subtle">
          Saving response style…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-1 text-xs text-danger">
          Could not save the response style. Your previous style is unchanged. Try again.
        </p>
      ) : null}
    </section>
  )
}

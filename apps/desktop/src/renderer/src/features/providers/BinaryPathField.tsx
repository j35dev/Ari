import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '@ari/ui/button'
import { Input } from '@ari/ui/input'
import { rpc } from '../../lib/rpc'
import {
  SETTINGS_CAPTION_CLASS,
  SETTINGS_HINT_CLASS,
  SETTINGS_LABEL_CLASS,
} from '../settings/SettingsSection'
import type { Detection } from './provider-status'

export interface BinaryPathFieldProps {
  /** Provider name, e.g. "Claude". */
  name: string
  /** The bare command, shown as the placeholder when nothing was found. */
  command: string
  /** The stored path; empty means search PATH. */
  value: string
  detection: Detection | undefined
  /** A change was saved and the detection shown is not for it yet. */
  checking: boolean
  /** The provider is off, so nothing is being run to judge the path. */
  off: boolean
  onCommit: (path: string) => void
}

const samePath = (a: string | null | undefined, b: string): boolean =>
  a != null && a.toLowerCase() === b.toLowerCase()

/**
 * Where a provider's CLI lives. Typing is buffered and saved on Enter or on
 * leaving the field, because every save makes Ari run the file to check it.
 * Other installs found on the machine are listed so choosing between two of
 * them is a click rather than a hunt through PATH.
 */
export function BinaryPathField({
  name,
  command,
  value,
  detection,
  checking,
  off,
  onCommit,
}: BinaryPathFieldProps) {
  const id = useId()
  const [draft, setDraft] = useState(value)
  const [browseError, setBrowseError] = useState(false)
  // What was last handed up, which runs ahead of `value` by a round trip:
  // Enter followed by leaving the field would otherwise save the path twice.
  const committed = useRef(value)
  useEffect(() => {
    committed.current = value
    setDraft(value)
  }, [value])

  const candidates = detection?.candidates ?? []
  const found = candidates[0] ?? null
  const custom = value.length > 0
  const rejected = !off && !checking && custom && detection?.installed === false
  const problem = off || checking ? undefined : detection?.pathProblem

  const commit = (next: string): void => {
    const trimmed = next.trim()
    setDraft(trimmed)
    if (trimmed === committed.current) return
    committed.current = trimmed
    onCommit(trimmed)
  }

  const browse = async (): Promise<void> => {
    setBrowseError(false)
    try {
      const start = custom ? value : found
      const picked = await rpc.invoke('dialog.pickFile', start ? { defaultPath: start } : {})
      if (picked.path !== null) commit(picked.path)
    } catch {
      setBrowseError(true)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div>
        <label htmlFor={id} className={SETTINGS_LABEL_CLASS}>
          Binary path
        </label>
        <p className={`mt-0.5 ${SETTINGS_HINT_CLASS}`}>
          The {name} executable Ari runs. Leave empty to use the one found on PATH.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          value={draft}
          placeholder={found ?? command}
          invalid={rejected}
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 font-mono"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => commit(draft)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit(draft)
            if (event.key === 'Escape') setDraft(value)
          }}
        />
        <Button size="sm" variant="secondary" onClick={() => void browse()}>
          Browse
        </Button>
        {custom && (
          <Button size="sm" variant="ghost" onClick={() => commit('')}>
            Reset
          </Button>
        )}
      </div>

      {browseError && (
        <p role="alert" className="text-[13px] leading-5 text-danger">
          Could not open the file picker.
        </p>
      )}
      {checking ? (
        <p className={SETTINGS_HINT_CLASS}>Checking…</p>
      ) : problem !== undefined ? (
        <p
          role="alert"
          className={`text-[13px] leading-5 ${rejected ? 'text-danger' : 'text-warning'}`}
        >
          {problem}
        </p>
      ) : custom ? (
        <p className={SETTINGS_HINT_CLASS}>
          {off
            ? 'Checked when you turn the provider on.'
            : 'Ari runs this file and does not search PATH.'}
        </p>
      ) : found !== null ? (
        <p className={SETTINGS_HINT_CLASS}>Found on PATH.</p>
      ) : (
        <p className={SETTINGS_HINT_CLASS}>
          Nothing named <code className="font-mono text-[12.5px]">{command}</code> is on PATH.
          Install it, or point this at the executable.
        </p>
      )}

      {(candidates.length > 1 || (custom && candidates.length > 0)) && (
        <div className="mt-2">
          <p className={SETTINGS_CAPTION_CLASS}>Found on this machine</p>
          {/* Hairline rows, no boxes: the pane's own edge is the structure. */}
          <ul className="mt-1 flex flex-col divide-y divide-border">
            {candidates.map((candidate, index) => {
              const inUse = custom ? samePath(value, candidate) : index === 0
              return (
                <li key={candidate} className="flex min-h-9 items-center gap-2 py-1">
                  <code
                    className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-fg-muted"
                    title={candidate}
                  >
                    {candidate}
                  </code>
                  {index === 0 && (
                    <span className="shrink-0 text-xs text-fg-subtle">first on PATH</span>
                  )}
                  {inUse ? (
                    <span className="shrink-0 px-2.5 text-[13px] font-medium text-fg">In use</span>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Use ${candidate}`}
                      onClick={() => commit(index === 0 ? '' : candidate)}
                    >
                      Use
                    </Button>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}

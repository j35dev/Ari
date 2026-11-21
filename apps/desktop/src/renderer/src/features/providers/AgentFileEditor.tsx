import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { ArrowLeft, ChevronRight } from 'lucide-react'
import type { DriverKind } from '@ari/contracts/common'
import { configProblem, type ConfigFormat } from '@ari/providers/config-validate'
import { cx, iconButton, outlineButton, primaryButton, quietButton } from '../../lib/recipes'
import { rpc } from '../../lib/rpc'
import { CodeSurface, languageLabel, type Caret } from '../files/CodeSurface'
import { useLeaveGuard } from '../settings/settings-leave-guard'
import { SETTINGS_HINT_CLASS } from '../settings/SettingsSection'
import { formatBytes, type ConfigFile, type InventoryRecord } from './agent-config-model'

/** What the editor view has open: one of the agent's config files, or a skill. */
export type EditorTarget =
  | { type: 'config'; file: ConfigFile }
  | { type: 'skill'; record: InventoryRecord & { sourcePath: string } }

/** How long "Saved" stays in the status bar. */
const SAVED_NOTICE_MS = 2000

const IS_MAC = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)

interface Loaded {
  text: string
  eol: '\n' | '\r\n'
  exists: boolean
  /** The read stopped short; saving would cut the file, so it is read-only. */
  truncated: boolean
}

export interface AgentFileEditorProps {
  kind: DriverKind
  agentLabel: string
  target: EditorTarget
  workspacePath: string | null
  /** Back to the tab the file was opened from. Asks first when there are edits. */
  onBack: () => void
  /** After a successful save, so the file list can show the new size. */
  onSaved?: () => void
}

/**
 * One agent file, edited in place of the tab content: breadcrumb, path,
 * Revert / Open folder / Save, then Ari's code surface with a status bar.
 * Config files save through `providers.writeConfig` (which refuses invalid
 * JSON); skills are read through `providers.readExtensionFile` and stay read
 * only, since nothing writes them.
 */
export function AgentFileEditor({
  kind,
  agentLabel,
  target,
  workspacePath,
  onBack,
  onSaved,
}: AgentFileEditorProps) {
  const label = target.type === 'config' ? target.file.label : 'SKILL.md'
  const title = target.type === 'config' ? target.file.label : target.record.name
  const path = target.type === 'config' ? target.file.path : target.record.sourcePath
  const format: ConfigFormat = target.type === 'config' ? target.file.format : 'markdown'
  const description =
    target.type === 'config'
      ? target.file.description
      : `${agentLabel} loads this skill itself. Ari shows it read only; use Open folder to edit SKILL.md in your own editor.`

  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [saved, setSaved] = useState('')
  const [draft, setDraft] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [caret, setCaret] = useState<Caret>({ line: 1, column: 1 })
  /** The navigation waiting on "Discard changes", while the bar asks. */
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null)
  const fieldRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    let cancelled = false
    const read =
      target.type === 'config'
        ? rpc.invoke('providers.readConfig', { kind, fileId: target.file.id })
        : rpc
            .invoke('providers.readExtensionFile', {
              kind,
              workspacePath,
              path: target.record.sourcePath,
            })
            .then((file) => ({ ...file, exists: true }))
    read
      .then((result) => {
        if (cancelled) return
        // The text field works in LF; the file's own endings come back on save.
        const crlf = result.content.includes('\r\n')
        const text = crlf ? result.content.replace(/\r\n/g, '\n') : result.content
        setLoaded({
          text,
          eol: crlf ? '\r\n' : '\n',
          exists: result.exists,
          truncated: result.truncated,
        })
        setSaved(text)
        setDraft(text)
      })
      .catch((caught: unknown) => {
        if (!cancelled) setLoadError(caught instanceof Error ? caught.message : String(caught))
      })
    return () => {
      cancelled = true
    }
  }, [kind, target, workspacePath])

  useEffect(() => {
    if (savedAt === null) return
    const timer = setTimeout(() => setSavedAt(null), SAVED_NOTICE_MS)
    return () => clearTimeout(timer)
  }, [savedAt])

  const readOnly = target.type === 'skill' || loaded === null || loaded.truncated
  const dirty = loaded !== null && draft !== saved
  const problem = useMemo(() => configProblem(format, draft), [format, draft])
  // Only JSON blocks the save: the main process refuses it too. The TOML lint
  // is advisory, so a false alarm can never lock someone out of their config.
  const blocked = problem !== null && format === 'json'
  const size = useMemo(() => new TextEncoder().encode(draft).length, [draft])

  const save = useCallback((): void => {
    if (target.type !== 'config' || readOnly || !dirty || saving || blocked || loaded === null)
      return
    const content = draft
    setSaving(true)
    setSaveError(null)
    void rpc
      .invoke('providers.writeConfig', {
        kind,
        fileId: target.file.id,
        content: loaded.eol === '\n' ? content : content.replace(/\n/g, loaded.eol),
      })
      .then((result) => {
        if (!result.ok) {
          setSaveError(result.error)
          return
        }
        setSaved(content)
        setLoaded((current) => (current === null ? current : { ...current, exists: true }))
        setSavedAt(Date.now())
        onSaved?.()
      })
      .catch((caught: unknown) => {
        setSaveError(caught instanceof Error ? caught.message : String(caught))
      })
      .finally(() => setSaving(false))
  }, [blocked, dirty, draft, kind, loaded, onSaved, readOnly, saving, target])

  const askBeforeLeaving = useCallback((proceed: () => void): boolean => {
    setPendingLeave(() => proceed)
    return true
  }, [])
  useLeaveGuard(dirty ? askBeforeLeaving : null)

  const back = (): void => {
    if (dirty) setPendingLeave(() => onBack)
    else onBack()
  }

  const reveal = (): void => {
    void rpc
      .invoke('providers.revealPath', { kind, workspacePath, path })
      .catch((caught: unknown) => {
        setSaveError(caught instanceof Error ? caught.message : String(caught))
      })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      save()
    }
  }

  const status = readOnly
    ? loaded?.truncated
      ? 'Too large to edit'
      : 'Read only'
    : saving
      ? 'Saving…'
      : savedAt !== null
        ? 'Saved'
        : dirty
          ? 'Edited'
          : loaded !== null && !loaded.exists
            ? 'Not created yet'
            : ''

  return (
    <section
      aria-label={`${readOnly ? 'View' : 'Edit'} ${title}`}
      onKeyDown={onKeyDown}
      className="min-w-0"
    >
      <nav aria-label="Breadcrumb" className="mb-3.5 flex min-w-0 items-center gap-1 text-[13px]">
        <button
          type="button"
          onClick={back}
          aria-label={`Back to ${agentLabel}`}
          title="Back"
          className={cx(iconButton, '-ml-1.5')}
        >
          <ArrowLeft size={15} strokeWidth={1.7} aria-hidden />
        </button>
        <button type="button" onClick={back} className={CRUMB_CLASS}>
          Agents
        </button>
        <ChevronRight size={13} aria-hidden className="shrink-0 text-fg-subtle" />
        <button type="button" onClick={back} className={CRUMB_CLASS}>
          {agentLabel}
        </button>
        <ChevronRight size={13} aria-hidden className="shrink-0 text-fg-subtle" />
        {target.type === 'skill' ? (
          <>
            <span className="min-w-0 truncate font-mono text-[12.5px] text-fg-subtle">
              {target.record.name}
            </span>
            <ChevronRight size={13} aria-hidden className="shrink-0 text-fg-subtle" />
          </>
        ) : null}
        <span
          aria-current="page"
          className="min-w-0 truncate font-mono text-[12.5px] font-medium text-fg"
        >
          {label}
        </span>
      </nav>

      <div className="mb-2.5 flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <code title={path} className="min-w-0 flex-1 truncate font-mono text-xs text-fg-subtle">
          {path}
        </code>
        <div className="flex shrink-0 items-center gap-1">
          {target.type === 'config' ? (
            <button
              type="button"
              className={quietButton}
              disabled={readOnly || !dirty || saving}
              onClick={() => {
                setDraft(saved)
                setSaveError(null)
                setPendingLeave(null)
              }}
            >
              Revert
            </button>
          ) : null}
          <button type="button" className={quietButton} onClick={reveal}>
            Open folder
          </button>
          {target.type === 'config' ? (
            <button
              type="button"
              className={cx(primaryButton, 'ml-1')}
              disabled={readOnly || !dirty || saving || blocked}
              aria-busy={saving || undefined}
              title={blocked ? `Fix the ${format.toUpperCase()} first` : undefined}
              onClick={save}
            >
              {saving ? 'Saving…' : 'Save'}
              <kbd aria-hidden className="font-mono text-[11px] font-normal opacity-60">
                {IS_MAC ? '⌘S' : 'Ctrl S'}
              </kbd>
            </button>
          ) : null}
        </div>
      </div>

      {pendingLeave !== null ? (
        <div
          role="alertdialog"
          aria-label="Unsaved changes"
          className="mb-2.5 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-1 px-3 py-2"
        >
          <span aria-hidden className="ari-status" data-status="attention" />
          <p className="min-w-0 flex-1 text-[13px] text-fg">Discard your changes to {label}?</p>
          <button
            type="button"
            className={quietButton}
            onClick={() => {
              setPendingLeave(null)
              fieldRef.current?.focus()
            }}
          >
            Keep editing
          </button>
          <button
            type="button"
            className={outlineButton}
            onClick={() => {
              const proceed = pendingLeave
              setPendingLeave(null)
              setDraft(saved)
              proceed()
            }}
          >
            Discard changes
          </button>
        </div>
      ) : null}

      {loaded?.truncated ? (
        <p role="status" className={`mb-2.5 ${SETTINGS_HINT_CLASS}`}>
          {target.type === 'config'
            ? 'This file is too large to edit in Ari. It shows the start only and will not save, so the rest is never cut off.'
            : 'Showing the start of this skill; the rest is cut off here.'}
        </p>
      ) : null}

      <div className="ari-theme-panel overflow-hidden rounded-xl border border-border-strong bg-surface-0">
        <div className="ari-scroll relative max-h-[max(280px,calc(88vh-300px))] min-h-[200px] overflow-auto">
          {loaded !== null ? (
            <CodeSurface
              value={draft}
              onChange={(next) => {
                setDraft(next)
                setSaveError(null)
              }}
              path={path}
              readOnly={readOnly}
              ariaLabel={`${label} contents`}
              onCaretChange={setCaret}
              fieldRef={fieldRef}
              gutterClassName="bg-surface-0"
            />
          ) : loadError !== null ? (
            <p role="alert" className="px-4 py-3 text-[13px] text-danger">
              {loadError}
            </p>
          ) : (
            <p className="px-4 py-3 text-[13px] text-fg-subtle">Opening {label}…</p>
          )}
        </div>
        {loaded !== null ? (
          <footer className="flex min-h-8 flex-wrap items-center gap-x-3.5 gap-y-1 border-t border-border px-3.5 py-1.5 text-xs text-fg-subtle">
            {format === 'json' || format === 'toml' ? (
              <Validity format={format} problem={problem} />
            ) : null}
            {status ? <span>{status}</span> : null}
            <span className="ml-auto shrink-0 tabular-nums">
              Ln {caret.line}, Col {caret.column} · {languageLabel(path)} · {formatBytes(size)}
            </span>
          </footer>
        ) : null}
      </div>

      {saveError !== null ? (
        <p role="alert" className="mt-2.5 text-[13px] leading-5 text-danger">
          {saveError}
        </p>
      ) : null}
      <p className={`mt-2.5 ${SETTINGS_HINT_CLASS}`}>{description}</p>
    </section>
  )
}

const CRUMB_CLASS =
  'shrink-0 rounded px-1 text-fg-subtle transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring'

function Validity({
  format,
  problem,
}: {
  format: 'json' | 'toml'
  problem: ReturnType<typeof configProblem>
}) {
  const name = format.toUpperCase()
  if (problem === null) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className="size-1.5 rounded-full bg-success" />
        Valid {name}
      </span>
    )
  }
  const where = problem.line !== undefined ? ` · Ln ${problem.line}` : ''
  return (
    <span
      role="status"
      title={problem.message}
      className={cx(
        'inline-flex min-w-0 max-w-full items-center gap-1.5',
        format === 'json' ? 'text-danger' : 'text-warning',
      )}
    >
      <span
        aria-hidden
        className={cx(
          'size-1.5 shrink-0 rounded-full',
          format === 'json' ? 'bg-danger' : 'bg-warning',
        )}
      />
      <span className="truncate">
        {format === 'json' ? 'Invalid JSON' : 'TOML problem'}
        {where}: {problem.message}
      </span>
    </span>
  )
}

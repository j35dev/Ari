import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, FileText } from 'lucide-react'
import { toolWireScope, useToolSessionClient } from '../terminal/tool-session-client'
import { cx, iconButton, outlineButton, primaryButton, quietButton } from '../../lib/recipes'
import { CodeSurface, languageLabel, type Caret } from './CodeSurface'
import type { FsTreeScope } from './FileExplorer'

/** How long "Saved" stays in the status line. */
const SAVED_NOTICE_MS = 2000

function splitPath(path: string): { dir: string; name: string } {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index < 0
    ? { dir: '', name: path }
    : { dir: path.slice(0, index + 1), name: path.slice(index + 1) }
}

interface FileEditorProps {
  /** Capability scope the file lives in (project or session workspace). */
  scope: FsTreeScope
  /** Workspace-relative path of the file being edited. */
  path: string
  /** Leaves the editor. Asks first when there are unsaved edits. */
  onClose: () => void
  /** Called after a successful save so listings can refresh. */
  onSaved?: () => void
  /** Host file writes are not exposed; keep the normal preview with a reason. */
  readOnlyReason?: string | null
}

/**
 * Text editor for files opened from the FileExplorer, shown in the explorer's
 * place. Loads via `fs.readTextFile` and saves through `fs.writeTextFile` —
 * both scoped to the file's project or session plus a relative path, so
 * absolute paths never cross IPC. Files over the edit cap or binary ones show
 * an error instead of an editable buffer. Line endings are kept as found.
 */
export function FileEditor({ scope, path, onClose, onSaved, readOnlyReason }: FileEditorProps) {
  const rpc = useToolSessionClient(scope.sessionId)
  const wireScope = useMemo(() => toolWireScope(rpc, scope), [rpc, scope])
  const editingReason =
    readOnlyReason ??
    (rpc.scope.kind === 'remote' || rpc.readOnly
      ? (rpc.capabilityReason('fs.writeTextFile') ?? 'File editing is unavailable on this machine.')
      : null)
  const readOnly = editingReason != null
  const generation = useRef(0)
  const [original, setOriginal] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [eol, setEol] = useState<'\n' | '\r\n'>('\n')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [confirmClose, setConfirmClose] = useState(false)
  const [caret, setCaret] = useState<Caret>({ line: 1, column: 1 })
  const fieldRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const epoch = ++generation.current
    let cancelled = false
    setOriginal(null)
    setDraft('')
    setError(null)
    setSaving(false)
    setConfirmClose(false)
    setCaret({ line: 1, column: 1 })
    void rpc
      .invoke('fs.readTextFile', { ...wireScope, path })
      .then((result) => {
        if (cancelled) return
        // A truncated read means the file is larger than we hold in memory;
        // saving would silently drop the tail, so editing is refused.
        if (result.truncated) {
          setError('This file is over the 512 KiB edit limit.')
          return
        }
        // The text field works in LF; the file's own endings come back on save.
        const crlf = result.content.includes('\r\n')
        const text = crlf ? result.content.replace(/\r\n/g, '\n') : result.content
        setEol(crlf ? '\r\n' : '\n')
        setOriginal(text)
        setDraft(text)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
      if (generation.current === epoch) generation.current += 1
    }
  }, [path, wireScope, rpc, rpc.authorizationEpoch, rpc.availability])

  useEffect(() => {
    if (savedAt === null) return
    const timer = setTimeout(() => setSavedAt(null), SAVED_NOTICE_MS)
    return () => clearTimeout(timer)
  }, [savedAt])

  const loaded = original !== null
  const dirty = loaded && draft !== original
  const lineCount = useMemo(() => draft.split('\n').length, [draft])
  const { dir, name } = splitPath(path)

  const save = useCallback((): void => {
    if (readOnly || !dirty || saving) return
    const content = draft
    // A reply that lands after the file or its machine changed is dropped.
    const epoch = generation.current
    setSaving(true)
    setError(null)
    void rpc
      .invoke('fs.writeTextFile', {
        ...wireScope,
        path,
        content: eol === '\n' ? content : content.replace(/\n/g, eol),
      })
      .then(() => {
        if (generation.current !== epoch) return
        setOriginal(content)
        setSavedAt(Date.now())
        onSaved?.()
      })
      .catch((cause: unknown) => {
        if (generation.current !== epoch) return
        setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (generation.current === epoch) setSaving(false)
      })
  }, [dirty, draft, eol, onSaved, path, readOnly, saving, wireScope, rpc])

  const requestClose = useCallback((): void => {
    if (dirty) setConfirmClose(true)
    else onClose()
  }, [dirty, onClose])

  return (
    <section
      aria-label={`${readOnly ? 'Preview' : 'Edit'} ${name}`}
      className="ari-file-editor flex h-full min-h-0 flex-col bg-bg"
    >
      <header className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border pl-1.5 pr-2">
        <button
          type="button"
          aria-label="Close file"
          title="Back to files (Esc)"
          onClick={requestClose}
          className={iconButton}
        >
          <ArrowLeft size={16} strokeWidth={1.7} aria-hidden />
        </button>
        <FileText size={14} aria-hidden className="shrink-0 text-fg-subtle" />
        <h2 className="flex min-w-0 flex-1 items-baseline text-[13px]" title={path}>
          {dir !== '' ? <span className="min-w-0 truncate text-fg-subtle">{dir}</span> : null}
          <span className="shrink-0 font-medium text-fg">{name}</span>
          {dirty ? (
            <span
              aria-hidden
              className="ml-2 size-1.5 shrink-0 self-center rounded-full bg-fg-muted"
            />
          ) : null}
        </h2>
        {dirty ? <span className="shrink-0 text-xs text-fg-subtle">Unsaved changes</span> : null}
        {/* Read only keeps Save in place, disabled, with the reason on hover. */}
        <button
          type="button"
          onClick={save}
          disabled={readOnly || !dirty || saving}
          aria-busy={saving || undefined}
          title={editingReason ?? 'Save (Ctrl+S)'}
          className={cx(primaryButton, 'ml-1 shrink-0')}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </header>

      {editingReason !== null ? (
        <p
          role="status"
          className="shrink-0 border-b border-border px-3 py-2 text-[13px] text-fg-muted"
        >
          {editingReason}
        </p>
      ) : null}

      {confirmClose ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface-1 px-3 py-2">
          <span aria-hidden className="ari-status" data-status="attention" />
          <p className="min-w-0 flex-1 text-[13px] text-fg">Discard your changes to {name}?</p>
          <button
            type="button"
            onClick={() => {
              setConfirmClose(false)
              fieldRef.current?.focus()
            }}
            className={quietButton}
          >
            Keep editing
          </button>
          <button type="button" onClick={onClose} className={outlineButton}>
            Discard changes
          </button>
        </div>
      ) : null}

      <div className="ari-scroll relative min-h-0 flex-1 overflow-auto">
        {loaded ? (
          <CodeSurface
            value={draft}
            onChange={(next) => {
              setDraft(next)
              if (confirmClose) setConfirmClose(false)
            }}
            path={path}
            readOnly={readOnly}
            onSave={save}
            onEscape={requestClose}
            onCaretChange={setCaret}
            fieldRef={fieldRef}
          />
        ) : error !== null ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
            <p role="alert" className="max-w-80 text-[13px] text-fg">
              {error}
            </p>
            <button type="button" onClick={onClose} className={outlineButton}>
              Back to files
            </button>
          </div>
        ) : (
          <p className="px-4 py-3 text-[13px] text-fg-subtle">Opening {name}…</p>
        )}
      </div>

      {loaded ? (
        <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-border px-3 text-xs text-fg-subtle">
          {error !== null ? (
            <p role="alert" className="min-w-0 flex-1 truncate text-danger">
              {error}
            </p>
          ) : (
            <span className="min-w-0 flex-1 truncate">
              {saving ? 'Saving…' : savedAt !== null ? 'Saved' : ''}
            </span>
          )}
          <span className="shrink-0 tabular-nums">
            Ln {caret.line}, Col {caret.column}
          </span>
          <span className="shrink-0 tabular-nums">
            {lineCount} {lineCount === 1 ? 'line' : 'lines'}
          </span>
          <span className="shrink-0">{eol === '\r\n' ? 'CRLF' : 'LF'}</span>
          <span className="shrink-0">{languageLabel(path)}</span>
        </footer>
      ) : null}
    </section>
  )
}

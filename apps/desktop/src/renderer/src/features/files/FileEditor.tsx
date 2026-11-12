import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, FileText } from 'lucide-react'
import { rpc } from '../../lib/rpc'
import { cx, iconButton, outlineButton, primaryButton, quietButton } from '../../lib/recipes'
import { DiffHighlightPool, type HighlightLine } from '../diffs/diff-highlight-pool'
import { languageForPath } from '../diffs/use-diff-highlight'
import type { FsTreeScope } from './FileExplorer'
import './file-editor.css'

const pool = new DiffHighlightPool()

/** Highlighting waits for a pause in typing, and skips files too big to keep up with. */
const HIGHLIGHT_DELAY_MS = 120
const HIGHLIGHT_MAX_LINES = 6000
const HIGHLIGHT_MAX_CHARS = 400_000
const HIGHLIGHT_MAX_LINE = 2000
/** How long "Saved" stays in the status line. */
const SAVED_NOTICE_MS = 2000

const LANGUAGE_NAMES: Record<string, string> = {
  typescript: 'TypeScript',
  tsx: 'TSX',
  javascript: 'JavaScript',
  jsx: 'JSX',
  json: 'JSON',
  jsonc: 'JSON',
  python: 'Python',
  rust: 'Rust',
  go: 'Go',
  css: 'CSS',
  scss: 'SCSS',
  less: 'Less',
  html: 'HTML',
  markdown: 'Markdown',
  yaml: 'YAML',
  bash: 'Shell',
  sql: 'SQL',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  java: 'Java',
  toml: 'TOML',
  dockerfile: 'Dockerfile',
  xml: 'XML',
  vue: 'Vue',
  svelte: 'Svelte',
  ruby: 'Ruby',
  php: 'PHP',
  swift: 'Swift',
  kotlin: 'Kotlin',
  lua: 'Lua',
  powershell: 'PowerShell',
  ini: 'INI',
}

function splitPath(path: string): { dir: string; name: string } {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index < 0
    ? { dir: '', name: path }
    : { dir: path.slice(0, index + 1), name: path.slice(index + 1) }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Line and column (both 1-based) of a caret offset. */
function caretPosition(text: string, offset: number): { line: number; column: number } {
  let line = 1
  let lineStart = 0
  for (let index = text.indexOf('\n'); index !== -1 && index < offset;) {
    line += 1
    lineStart = index + 1
    index = text.indexOf('\n', lineStart)
  }
  return { line, column: offset - lineStart + 1 }
}

/**
 * Inserts text at the caret through the browser's editing command, so it
 * lands on the undo stack like typing; falls back to rewriting the value.
 */
function insertAtCaret(
  field: HTMLTextAreaElement,
  text: string,
  setValue: (value: string) => void,
): void {
  field.focus()
  if (typeof document.execCommand === 'function' && document.execCommand('insertText', false, text))
    return
  const { selectionStart: start, selectionEnd: end, value } = field
  setValue(value.slice(0, start) + text + value.slice(end))
  requestAnimationFrame(() => field.setSelectionRange(start + text.length, start + text.length))
}

interface Highlight {
  /** The lines this markup was made from; a line that has changed since shows plain. */
  source: string[]
  html: Record<string, string>
}

/** Off-thread highlighting of the whole buffer, refreshed after each pause in typing. */
function useHighlight(lines: string[], lang: string | null): Highlight | null {
  const [highlight, setHighlight] = useState<Highlight | null>(null)
  useEffect(() => {
    if (lang === null || typeof Worker === 'undefined') return
    if (lines.length > HIGHLIGHT_MAX_LINES) return
    let chars = 0
    const request: HighlightLine[] = []
    for (const [index, text] of lines.entries()) {
      chars += text.length
      if (chars > HIGHLIGHT_MAX_CHARS) return
      request.push({
        key: String(index),
        side: 'new',
        text: text.length > HIGHLIGHT_MAX_LINE ? '' : text,
      })
    }
    let cancel: (() => void) | undefined
    let cancelled = false
    const timer = setTimeout(() => {
      const pending = pool.request(lang, request)
      cancel = pending.cancel
      void pending.promise.then((html) => {
        if (!cancelled && Object.keys(html).length > 0) setHighlight({ source: lines, html })
      })
    }, HIGHLIGHT_DELAY_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
      cancel?.()
    }
  }, [lines, lang])
  return highlight
}

const CodeLine = memo(function CodeLine({ html }: { html: string }) {
  return <div className="ari-code-line" dangerouslySetInnerHTML={{ __html: html }} />
})

interface FileEditorProps {
  /** Capability scope the file lives in (project or session workspace). */
  scope: FsTreeScope
  /** Workspace-relative path of the file being edited. */
  path: string
  /** Leaves the editor. Asks first when there are unsaved edits. */
  onClose: () => void
  /** Called after a successful save so listings can refresh. */
  onSaved?: () => void
}

/**
 * Text editor for files opened from the FileExplorer, shown in the explorer's
 * place. Loads via `fs.readTextFile` and saves through `fs.writeTextFile` —
 * both scoped to the file's project or session plus a relative path, so
 * absolute paths never cross IPC. Files over the edit cap or binary ones show
 * an error instead of an editable buffer. Line endings are kept as found.
 */
export function FileEditor({ scope, path, onClose, onSaved }: FileEditorProps) {
  const [original, setOriginal] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [eol, setEol] = useState<'\n' | '\r\n'>('\n')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [confirmClose, setConfirmClose] = useState(false)
  const [caret, setCaret] = useState({ line: 1, column: 1 })
  const [focused, setFocused] = useState(false)
  const fieldRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    let cancelled = false
    setOriginal(null)
    setDraft('')
    setError(null)
    setConfirmClose(false)
    setCaret({ line: 1, column: 1 })
    void rpc
      .invoke('fs.readTextFile', { ...scope, path })
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
    }
  }, [path, scope])

  useEffect(() => {
    if (savedAt === null) return
    const timer = setTimeout(() => setSavedAt(null), SAVED_NOTICE_MS)
    return () => clearTimeout(timer)
  }, [savedAt])

  const loaded = original !== null
  const dirty = loaded && draft !== original
  const lang = useMemo(() => languageForPath(path), [path])
  const lines = useMemo(() => draft.split('\n'), [draft])
  const highlight = useHighlight(lines, loaded ? lang : null)
  const { dir, name } = splitPath(path)

  const save = useCallback((): void => {
    if (!dirty || saving) return
    const content = draft
    setSaving(true)
    setError(null)
    void rpc
      .invoke('fs.writeTextFile', {
        ...scope,
        path,
        content: eol === '\n' ? content : content.replace(/\n/g, eol),
      })
      .then(() => {
        setOriginal(content)
        setSavedAt(Date.now())
        onSaved?.()
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        setSaving(false)
      })
  }, [dirty, draft, eol, onSaved, path, saving, scope])

  const requestClose = useCallback((): void => {
    if (dirty) setConfirmClose(true)
    else onClose()
  }, [dirty, onClose])

  const trackCaret = (): void => {
    const field = fieldRef.current
    if (field !== null) setCaret(caretPosition(field.value, field.selectionStart))
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    const field = event.currentTarget
    const mod = event.ctrlKey || event.metaKey
    if (mod && event.key.toLowerCase() === 's') {
      event.preventDefault()
      save()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      requestClose()
    } else if (event.key === 'Tab' && !mod && !event.altKey && !event.shiftKey) {
      event.preventDefault()
      insertAtCaret(field, '  ', setDraft)
    } else if (event.key === 'Enter' && !mod && !event.altKey && !event.shiftKey) {
      // Keep the current line's indentation on the new one.
      const before = field.value.slice(0, field.selectionStart)
      const indent = /^[ \t]*/.exec(before.slice(before.lastIndexOf('\n') + 1))?.[0] ?? ''
      if (indent.length === 0) return
      event.preventDefault()
      insertAtCaret(field, `\n${indent}`, setDraft)
    }
  }

  const gutterWidth = `calc(${String(Math.max(2, String(lines.length).length))}ch + 28px)`

  return (
    <section aria-label={`Edit ${name}`} className="flex h-full min-h-0 flex-col bg-bg">
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
        <button
          type="button"
          onClick={save}
          disabled={!dirty || saving}
          aria-busy={saving || undefined}
          title="Save (Ctrl+S)"
          className={cx(primaryButton, 'ml-1 shrink-0')}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </header>

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
          <div className="flex min-h-full w-max min-w-full">
            <div
              aria-hidden
              className="ari-code-gutter sticky left-0 z-pane-chrome shrink-0 bg-bg text-fg-subtle"
              style={{ minWidth: gutterWidth }}
            >
              {lines.map((_, index) => (
                <div
                  key={index}
                  className={cx(
                    'ari-code-line',
                    focused && index + 1 === caret.line ? 'text-fg-muted' : 'opacity-60',
                  )}
                >
                  {index + 1}
                </div>
              ))}
            </div>
            <div className="relative min-w-0 flex-1">
              {focused ? (
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 h-5 bg-fg/4"
                  style={{ top: 10 + (caret.line - 1) * 20 }}
                />
              ) : null}
              <pre aria-hidden className="ari-code-text ari-code-highlight relative text-fg">
                {lines.map((line, index) => (
                  <CodeLine
                    key={index}
                    html={
                      highlight !== null && highlight.source[index] === line
                        ? (highlight.html[String(index)] ?? escapeHtml(line))
                        : escapeHtml(line)
                    }
                  />
                ))}
              </pre>
              <textarea
                ref={fieldRef}
                aria-label="File contents"
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value)
                  trackCaret()
                  if (confirmClose) setConfirmClose(false)
                }}
                onKeyDown={onKeyDown}
                onSelect={trackCaret}
                onKeyUp={trackCaret}
                onClick={trackCaret}
                onFocus={() => {
                  setFocused(true)
                  trackCaret()
                }}
                onBlur={() => setFocused(false)}
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
                autoCorrect="off"
                wrap="off"
                className="ari-code-text ari-code-input absolute inset-0 h-full w-full resize-none overflow-hidden outline-none"
              />
            </div>
          </div>
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
            {lines.length} {lines.length === 1 ? 'line' : 'lines'}
          </span>
          <span className="shrink-0">{eol === '\r\n' ? 'CRLF' : 'LF'}</span>
          <span className="shrink-0">
            {lang === null ? 'Plain text' : (LANGUAGE_NAMES[lang] ?? lang)}
          </span>
        </footer>
      ) : null}
    </section>
  )
}

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { cx } from '../../lib/recipes'
import { DiffHighlightPool, type HighlightLine } from '../diffs/diff-highlight-pool'
import { languageForPath } from '../diffs/use-diff-highlight'
import './file-editor.css'

const pool = new DiffHighlightPool()

/** Highlighting waits for a pause in typing, and skips files too big to keep up with. */
const HIGHLIGHT_DELAY_MS = 120
const HIGHLIGHT_MAX_LINES = 6000
const HIGHLIGHT_MAX_CHARS = 400_000
const HIGHLIGHT_MAX_LINE = 2000

export const LANGUAGE_NAMES: Record<string, string> = {
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

/** Display name of the language a path highlights as. */
export function languageLabel(path: string): string {
  const lang = languageForPath(path)
  return lang === null ? 'Plain text' : (LANGUAGE_NAMES[lang] ?? lang)
}

export interface Caret {
  line: number
  column: number
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Line and column (both 1-based) of a caret offset. */
function caretPosition(text: string, offset: number): Caret {
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

export interface CodeSurfaceProps {
  value: string
  onChange: (next: string) => void
  /** Picks the highlighting language from the extension. */
  path: string
  readOnly?: boolean
  ariaLabel?: string
  /** Ctrl/Cmd+S inside the text. */
  onSave?: () => void
  /** Escape inside the text. Left alone when absent, so a dialog can close. */
  onEscape?: () => void
  onCaretChange?: (caret: Caret) => void
  fieldRef?: RefObject<HTMLTextAreaElement | null>
  /** Background of the sticky gutter; it must be opaque over scrolled text. */
  gutterClassName?: string
}

/**
 * The code text itself: a gutter of line numbers and a transparent textarea
 * laid over a Shiki-highlighted copy of the same text. The caller owns the
 * scroll container, so the gutter sticks to its left edge.
 */
export function CodeSurface({
  value,
  onChange,
  path,
  readOnly = false,
  ariaLabel = 'File contents',
  onSave,
  onEscape,
  onCaretChange,
  fieldRef: externalRef,
  gutterClassName = 'bg-bg',
}: CodeSurfaceProps) {
  const internalRef = useRef<HTMLTextAreaElement>(null)
  const fieldRef = externalRef ?? internalRef
  const [caret, setCaret] = useState<Caret>({ line: 1, column: 1 })
  const [focused, setFocused] = useState(false)
  const lang = useMemo(() => languageForPath(path), [path])
  const lines = useMemo(() => value.split('\n'), [value])
  const highlight = useHighlight(lines, lang)
  const caretListener = useRef(onCaretChange)
  caretListener.current = onCaretChange

  const trackCaret = (): void => {
    const field = fieldRef.current
    if (field === null) return
    const next = caretPosition(field.value, field.selectionStart)
    setCaret(next)
    caretListener.current?.(next)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    const field = event.currentTarget
    const mod = event.ctrlKey || event.metaKey
    if (mod && event.key.toLowerCase() === 's') {
      if (!onSave) return
      event.preventDefault()
      onSave()
    } else if (event.key === 'Escape') {
      if (!onEscape) return
      event.preventDefault()
      onEscape()
    } else if (readOnly) {
      return
    } else if (event.key === 'Tab' && !mod && !event.altKey && !event.shiftKey) {
      event.preventDefault()
      insertAtCaret(field, '  ', onChange)
    } else if (event.key === 'Enter' && !mod && !event.altKey && !event.shiftKey) {
      // Keep the current line's indentation on the new one.
      const before = field.value.slice(0, field.selectionStart)
      const indent = /^[ \t]*/.exec(before.slice(before.lastIndexOf('\n') + 1))?.[0] ?? ''
      if (indent.length === 0) return
      event.preventDefault()
      insertAtCaret(field, `\n${indent}`, onChange)
    }
  }

  const gutterWidth = `calc(${String(Math.max(2, String(lines.length).length))}ch + 28px)`

  return (
    <div className="flex min-h-full w-max min-w-full">
      <div
        aria-hidden
        className={cx(
          'ari-code-gutter sticky left-0 z-pane-chrome shrink-0 text-fg-subtle',
          gutterClassName,
        )}
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
          aria-label={ariaLabel}
          value={value}
          readOnly={readOnly}
          onChange={(event) => {
            if (readOnly) return
            onChange(event.target.value)
            trackCaret()
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
  )
}

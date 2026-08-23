import { useEffect, useId, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { FileText, LoaderCircle, Search } from 'lucide-react'
import { menuInVariants } from '@ari/ui/motion'
import { Kbd } from '@ari/ui/kbd'
import type { RpcResults } from '@ari/contracts/rpc'
import { rpc } from '../../lib/rpc'

export interface ContentSearchOverlayProps {
  /** Whether the overlay is currently shown. */
  open: boolean
  /** Called on Escape, backdrop click, or after copying a result. */
  onClose: () => void
  /** Project folder searched (path jail boundary); null disables searching. */
  root: string | null
}

type ContentMatch = RpcResults['search.content'][number]

/** Keystroke-to-RPC delay so fast typing fires one search, not ten. */
const SEARCH_DEBOUNCE_MS = 160

function basename(path: string): string {
  const last = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return last === -1 ? path : path.slice(last + 1)
}

/** Joins a jail-relative match path onto the search root, platform-aware. */
export function toAbsolutePath(root: string, relative: string): string {
  const endsWithSep = root.endsWith('/') || root.endsWith('\\')
  if (endsWithSep) return `${root}${relative}`
  const sep = root.includes('\\') ? '\\' : '/'
  return `${root}${sep}${relative}`
}

/**
 * Project-wide content search overlay (M18.4): palette-style dialog fed by
 * the `search.content` RPC. Arrow keys move the highlight, Enter copies the
 * highlighted hit as `absolute-path:line` (no file editor exists yet), and
 * Escape or the backdrop closes.
 */
export function ContentSearchOverlay({ open, onClose, root }: ContentSearchOverlayProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ContentMatch[]>([])
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const idBase = useId()

  // Fresh state every time the overlay opens; focus the input.
  useEffect(() => {
    if (open) {
      setQuery('')
      setResults([])
      setError(null)
      setActiveIndex(0)
      inputRef.current?.focus()
    }
  }, [open])

  // Debounced live search; stale responses are dropped via the cancelled flag.
  useEffect(() => {
    if (!open || root === null) return
    const trimmed = query.trim()
    if (trimmed.length === 0) {
      setResults([])
      setSearching(false)
      setError(null)
      return
    }
    let cancelled = false
    setSearching(true)
    const timer = setTimeout(() => {
      void rpc
        .invoke('search.content', { path: root, query: trimmed })
        .then((matches) => {
          if (cancelled) return
          setResults(matches)
          setActiveIndex(0)
          setError(null)
        })
        .catch((cause: unknown) => {
          if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
        })
        .finally(() => {
          if (!cancelled) setSearching(false)
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, query, root])

  // Keep the highlight valid as the result set changes per keystroke.
  useEffect(() => {
    setActiveIndex((index) => (index < results.length ? index : 0))
  }, [results.length])

  useEffect(() => {
    listRef.current?.children[activeIndex]?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex])

  const latest = useRef({ results, activeIndex, root, onClose })
  latest.current = { results, activeIndex, root, onClose }

  /** Copies the active hit as `absolute-path:line`; closes when done. */
  const copyActive = (): void => {
    const state = latest.current
    const hit = state.results[state.activeIndex]
    if (!hit || state.root === null) return
    void navigator.clipboard
      ?.writeText(`${toAbsolutePath(state.root, hit.path)}:${hit.line}`)
      .catch(() => undefined)
    state.onClose()
  }

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      const state = latest.current
      switch (event.key) {
        case 'ArrowDown': {
          if (state.results.length === 0) return
          event.preventDefault()
          event.stopPropagation()
          setActiveIndex((index) => (index + 1) % state.results.length)
          break
        }
        case 'ArrowUp': {
          if (state.results.length === 0) return
          event.preventDefault()
          event.stopPropagation()
          setActiveIndex((index) => (index - 1 + state.results.length) % state.results.length)
          break
        }
        case 'Enter': {
          if (state.results.length === 0) return
          event.preventDefault()
          event.stopPropagation()
          copyActive()
          break
        }
        case 'Escape': {
          event.stopPropagation()
          state.onClose()
          break
        }
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open])

  return (
    <AnimatePresence>
      {open ? (
        <div
          key="content-search"
          onClick={() => onClose()}
          className="fixed inset-0 z-50 flex justify-center"
          style={{ background: 'color-mix(in oklab, black 45%, transparent)' }}
        >
          <motion.div
            initial="hidden"
            animate="visible"
            exit="exit"
            variants={menuInVariants}
            role="dialog"
            aria-modal="true"
            aria-label="Project content search"
            onClick={(event) => event.stopPropagation()}
            className="mt-[12vh] flex h-fit w-[min(640px,92vw)] flex-col overflow-hidden rounded-lg border border-border ari-glass-overlay"
            style={{ boxShadow: 'var(--ari-shadow-3)' }}
          >
            <div className="flex h-12 items-center gap-2 border-b border-border px-4">
              <Search size={16} strokeWidth={1.8} className="shrink-0 text-fg-subtle" />
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={root === null ? 'Add a project first' : `Search in ${basename(root)}…`}
                aria-label="Search project files"
                spellCheck={false}
                disabled={root === null}
                className="h-full min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle"
              />
              {searching ? (
                <LoaderCircle size={14} className="shrink-0 animate-spin text-fg-subtle" aria-label="Searching" />
              ) : null}
            </div>
            <ul ref={listRef} role="listbox" aria-label="Search results" className="ari-scroll max-h-80 overflow-auto p-1">
              {error !== null ? (
                <li role="alert" className="px-2 py-1.5 font-mono text-xs text-danger">
                  {error}
                </li>
              ) : null}
              {results.map((hit, index) => {
                const active = index === activeIndex
                return (
                  <li
                    key={`${hit.path}:${hit.line}:${index}`}
                    id={`${idBase}-option-${index}`}
                    role="option"
                    aria-selected={active}
                    onMouseMove={() => setActiveIndex(index)}
                    onClick={() => copyActive()}
                    title={`Copy ${toAbsolutePath(root ?? '', hit.path)}:${hit.line}`}
                    className={[
                      'cursor-pointer select-none rounded-md px-2 py-1.5',
                      'focus-visible:outline-none',
                      active ? 'bg-surface-2' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    <div className="flex items-center gap-2">
                      <FileText size={13} strokeWidth={1.8} className="shrink-0 text-fg-subtle" aria-hidden="true" />
                      <span className="min-w-0 truncate font-mono text-xs text-fg-muted">{hit.path}</span>
                      <span className="ml-auto shrink-0 tabular-nums text-2xs text-fg-subtle">:{hit.line}</span>
                    </div>
                    <div className="truncate pl-[21px] text-xs text-fg">{hit.text}</div>
                  </li>
                )
              })}
              {query.trim().length > 0 && !searching && results.length === 0 && error === null ? (
                <li className="flex h-9 items-center px-2 text-sm text-fg-subtle">No matches</li>
              ) : null}
              {query.trim().length === 0 && root !== null ? (
                <li className="flex h-9 items-center px-2 text-sm text-fg-subtle">
                  Type to search across {basename(root)}
                </li>
              ) : null}
            </ul>
            <div className="flex h-8 items-center gap-3 border-t border-border px-4 text-2xs text-fg-subtle">
              {results.length > 0 ? <span>{results.length} hits</span> : <span />}
              <div className="flex-1" />
              <span className="flex items-center gap-1">
                <Kbd>↑↓</Kbd> navigate
              </span>
              <span className="flex items-center gap-1">
                <Kbd>↵</Kbd> copy path:line
              </span>
              <span className="flex items-center gap-1">
                <Kbd>esc</Kbd> close
              </span>
            </div>
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>
  )
}

import { useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import { Button } from '@ari/ui/button'
import { Input } from '@ari/ui/input'

const PAGE_SIZE = 9
const AUTO_ADVANCE_MS = 220

export interface QuestionPanelProps {
  /** Question text asked by the agent/provider. */
  prompt: string
  /** JSON string containing a string array of choices, or null for free text. */
  choicesJson: string | null
  /** Called with the chosen option or submitted free-text value. */
  onRespond: (value: string) => void
}

function parseChoices(json: string | null): string[] | null {
  if (json == null || json === '') return null
  try {
    const parsed: unknown = JSON.parse(json)
    if (!Array.isArray(parsed)) return null
    const strings = parsed.filter((choice): choice is string => typeof choice === 'string')
    return strings.length === parsed.length && strings.length > 0 ? strings : null
  } catch {
    return null
  }
}

/**
 * Composer-replacing surface for provider input requests. With choices it
 * renders a paged grid (keys `1`–`9` select on the visible page) and
 * auto-advances 220ms after a selection so the choice is briefly visible;
 * without choices it falls back to a free-text input.
 */
export function QuestionPanel({ prompt, choicesJson, onRespond }: QuestionPanelProps) {
  const choices = parseChoices(choicesJson)
  const [page, setPage] = useState(0)
  const [draft, setDraft] = useState('')
  const [chosen, setChosen] = useState<string | null>(null)

  const pageCount = choices ? Math.ceil(choices.length / PAGE_SIZE) : 1
  const visible = choices ? choices.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE) : []

  const choose = (value: string) => {
    if (chosen != null) return
    setChosen(value)
    window.setTimeout(() => onRespond(value), AUTO_ADVANCE_MS)
  }

  const submitText = () => {
    const value = draft.trim()
    if (value === '' || chosen != null) return
    setChosen(value)
    onRespond(value)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!choices || chosen != null) return
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
    const digit = '123456789'.indexOf(event.key)
    if (digit === -1) return
    const value = choices[page * PAGE_SIZE + digit]
    if (value === undefined) return
    event.preventDefault()
    choose(value)
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    submitText()
  }

  return (
    <section
      role="region"
      aria-label="Agent question"
      tabIndex={choices ? 0 : -1}
      onKeyDown={handleKeyDown}
      className="rounded-md border border-accent bg-surface-1 p-3 shadow-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
    >
      <p className="text-sm text-fg">{prompt}</p>
      {choices ? (
        <>
          <div className="mt-2 grid grid-cols-3 gap-2">
            {visible.map((choice, index) => (
              <button
                key={`${index}-${choice}`}
                type="button"
                disabled={chosen != null}
                aria-pressed={chosen === choice}
                onClick={() => choose(choice)}
                className={`flex items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:pointer-events-none disabled:opacity-60 ${
                  chosen === choice ? 'border-accent bg-accent-subtle' : 'border-border bg-surface-2 hover:bg-surface-3'
                }`}
              >
                <kbd className="shrink-0 rounded-sm border border-border bg-surface-1 px-1 font-mono text-2xs font-normal text-fg-muted">
                  {index + 1}
                </kbd>
                <span className="min-w-0 truncate text-fg">{choice}</span>
              </button>
            ))}
          </div>
          {pageCount > 1 ? (
            <div className="mt-2 flex items-center justify-end gap-2">
              <span className="mr-auto font-mono text-2xs text-fg-subtle">
                Page {page + 1}/{pageCount}
              </span>
              <Button variant="secondary" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                Prev
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={page >= pageCount - 1}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          ) : null}
        </>
      ) : (
        <form className="mt-2 flex items-center gap-2" onSubmit={handleSubmit}>
          <Input
            aria-label="Answer"
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                submitText()
              }
            }}
            className="flex-1"
          />
          <Button type="submit" variant="primary" size="md" disabled={draft.trim() === ''}>
            Submit
          </Button>
        </form>
      )}
    </section>
  )
}

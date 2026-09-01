import { useState } from 'react'
import type { FormEvent } from 'react'
import { FileText, X } from 'lucide-react'
import { Button } from '@ari/ui/button'
import { Textarea } from '@ari/ui/textarea'
import { MarkdownBlock } from '../transcript/MarkdownBlock'

export interface PlanReviewRailProps {
  prompt: string
  planContent: string
  onRespond: (value: string) => void
  onDismiss?: () => void
}

/**
 * Cursor-style plan review: a readable markdown rail to the right of the
 * transcript, with Approve / Request changes / Abandon pinned at the bottom.
 */
export function PlanReviewRail({ prompt, planContent, onRespond, onDismiss }: PlanReviewRailProps) {
  const [mode, setMode] = useState<'idle' | 'changes'>('idle')
  const [feedback, setFeedback] = useState('')
  const [chosen, setChosen] = useState<string | null>(null)

  const pick = (value: string) => {
    if (chosen != null) return
    setChosen(value)
    onRespond(value)
  }

  return (
    <aside
      role="complementary"
      aria-label="Plan review"
      className="flex w-[min(420px,42vw)] shrink-0 flex-col border-l border-border bg-surface-1"
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <FileText size={13} className="shrink-0 text-accent" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-fg">Plan</span>
        <span className="max-w-[50%] truncate text-2xs text-fg-subtle" title={prompt}>
          {prompt}
        </span>
        {onDismiss ? (
          <button
            type="button"
            aria-label="Close plan"
            onClick={onDismiss}
            className="flex h-6 w-6 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          >
            <X size={13} />
          </button>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {planContent.length > 0 ? (
          <MarkdownBlock text={planContent} />
        ) : (
          <p className="text-sm text-fg-muted">The agent did not attach a plan body.</p>
        )}
      </div>
      <footer className="shrink-0 border-t border-border p-3">
        {mode === 'changes' ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(event: FormEvent) => {
              event.preventDefault()
              const text = feedback.trim()
              pick(
                JSON.stringify({
                  outcome: 'cancelled',
                  ...(text.length > 0 ? { feedback: text } : {}),
                }),
              )
            }}
          >
            <Textarea
              aria-label="Requested changes"
              autoFocus
              value={feedback}
              onChange={(event) => setFeedback(event.target.value)}
              placeholder="What should change?"
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={() => setMode('idle')}>
                Back
              </Button>
              <Button type="submit" variant="primary" size="sm" disabled={chosen != null}>
                Send feedback
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-col gap-2">
            <Button variant="primary" size="md" disabled={chosen != null} onClick={() => pick('approved')}>
              Approve plan
            </Button>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                className="flex-1"
                disabled={chosen != null}
                onClick={() => setMode('changes')}
              >
                Request changes
              </Button>
              <Button variant="danger" size="sm" className="flex-1" disabled={chosen != null} onClick={() => pick('abandoned')}>
                Abandon
              </Button>
            </div>
          </div>
        )}
      </footer>
    </aside>
  )
}

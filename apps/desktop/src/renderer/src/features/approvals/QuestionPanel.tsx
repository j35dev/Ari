import { useEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import { Button } from '@ari/ui/button'
import { Input } from '@ari/ui/input'
import { Textarea } from '@ari/ui/textarea'
import { Checkbox } from '@ari/ui/checkbox'
import { encodeAnswers, parseQuestionPayload, type QuestionItem } from './questionnaire'

const AUTO_ADVANCE_MS = 180
const OTHER_LABEL = 'Other'

export interface QuestionPanelProps {
  /** Question text asked by the agent/provider. */
  prompt: string
  /** JSON string containing choices, a questionnaire, or a plan-approval. */
  choicesJson: string | null
  /** Called with the chosen option, submitted free-text, or encoded answers. */
  onRespond: (value: string) => void
  /**
   * Called when the user skips the question (Skip button or Esc). The host
   * answers with an empty value so the agent proceeds with its best judgment
   * instead of parking on the question forever. Absent hides the Skip button.
   */
  onCancel?: () => void
}

/**
 * One-question-at-a-time interview. Options are full-width rows with a
 * number key, label, and description — not a stacked multi-question grid.
 * Every choice list ends with Other so the user can type their own answer.
 */
export function QuestionPanel({ prompt, choicesJson, onRespond, onCancel }: QuestionPanelProps) {
  const payload = parseQuestionPayload(prompt, choicesJson)
  if (payload.kind === 'plan-approval') {
    return <PlanApproval prompt={payload.prompt} planContent={payload.planContent} onRespond={onRespond} />
  }
  if (payload.kind === 'questionnaire') {
    return <Interview questions={payload.questions} onRespond={onRespond} onCancel={onCancel} />
  }
  if (payload.kind === 'choices') {
    return (
      <Interview
        questions={[
          {
            id: 'choice',
            question: payload.prompt,
            options: payload.choices.map((label) => ({ id: label, label })),
            multiSelect: false,
          },
        ]}
        onRespond={(value) => {
          try {
            const parsed = JSON.parse(value) as { answers?: Record<string, string> }
            onRespond(parsed.answers?.['choice'] ?? value)
          } catch {
            onRespond(value)
          }
        }}
        onCancel={onCancel}
      />
    )
  }
  return <FreeText prompt={payload.prompt} onRespond={onRespond} onCancel={onCancel} />
}

function Interview({
  questions,
  onRespond,
  onCancel,
}: {
  questions: QuestionItem[]
  onRespond: (value: string) => void
  onCancel?: () => void
}) {
  const [index, setIndex] = useState(0)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [otherOpen, setOtherOpen] = useState(false)
  const [otherDraft, setOtherDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const question = questions[index]

  const clearAdvance = (): void => {
    if (advanceTimer.current !== null) {
      clearTimeout(advanceTimer.current)
      advanceTimer.current = null
    }
  }

  useEffect(
    () => () => {
      if (advanceTimer.current !== null) clearTimeout(advanceTimer.current)
    },
    [],
  )

  if (question === undefined) return null

  const total = questions.length
  const last = index === total - 1
  const chosen = answers[question.id] ?? null

  const restoreOther = (at: number, map: Record<string, string>): void => {
    const q = questions[at]
    const value = q === undefined ? undefined : map[q.id]
    const known =
      q !== undefined &&
      value !== undefined &&
      q.options.some((option) => option.label === value || option.id === value)
    if (value !== undefined && value.length > 0 && !known) {
      setOtherOpen(true)
      setOtherDraft(value)
      return
    }
    setOtherOpen(false)
    setOtherDraft('')
  }

  const goTo = (nextIndex: number, map: Record<string, string>): void => {
    clearAdvance()
    setIndex(nextIndex)
    restoreOther(nextIndex, map)
  }

  const finish = (next: Record<string, string>): void => {
    if (busy) return
    setBusy(true)
    onRespond(encodeAnswers(next))
  }

  const commit = (value: string, advance: boolean): void => {
    if (busy) return
    const next = { ...answers, [question.id]: value }
    setAnswers(next)
    setOtherOpen(false)
    if (!advance) return
    if (last) {
      finish(next)
      return
    }
    clearAdvance()
    advanceTimer.current = setTimeout(() => goTo(index + 1, next), AUTO_ADVANCE_MS)
  }

  const continueNext = (): void => {
    const value = otherOpen ? otherDraft.trim() : (chosen ?? '').trim()
    if (value === '' || busy) return
    const next = { ...answers, [question.id]: value }
    setAnswers(next)
    if (last) {
      finish(next)
      return
    }
    goTo(index + 1, next)
  }

  const toggleMulti = (label: string): void => {
    if (busy) return
    const selected = chosen === null || chosen === '' ? [] : chosen.split(', ')
    const next = selected.includes(label) ? selected.filter((s) => s !== label) : [...selected, label]
    setAnswers({ ...answers, [question.id]: next.join(', ') })
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (busy) return
    if (event.key === 'Escape') {
      // Focus inside the custom-answer box only closes the box (handled on
      // the textarea); anywhere else Esc skips the whole question.
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
      event.preventDefault()
      onCancel?.()
      return
    }
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
    if (event.key === 'Enter') {
      event.preventDefault()
      continueNext()
      return
    }
    const digit = '123456789'.indexOf(event.key)
    if (digit === -1) return
    if (digit === question.options.length) {
      event.preventDefault()
      setOtherOpen(true)
      return
    }
    const option = question.options[digit]
    if (option === undefined) return
    event.preventDefault()
    if (question.multiSelect) {
      toggleMulti(option.label)
      return
    }
    commit(option.label, true)
  }

  const canContinue = otherOpen ? otherDraft.trim() !== '' : (chosen ?? '').trim() !== ''

  return (
    <section
      role="region"
      aria-label="Agent question"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="rounded-lg border border-accent bg-surface-1 p-4 shadow-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
    >
      <div className="flex items-baseline justify-between gap-3">
        {total > 1 ? (
          <p className="font-mono text-2xs tabular-nums text-fg-subtle">
            Question {index + 1} of {total}
          </p>
        ) : (
          <span />
        )}
        {question.header ? (
          <p className="min-w-0 truncate text-2xs uppercase tracking-[0.12em] text-fg-subtle">{question.header}</p>
        ) : null}
      </div>
      <h2 className="mt-2 text-sm font-medium leading-snug text-fg" aria-live="polite">
        {question.question}
      </h2>
      <div className="mt-3 flex max-h-72 flex-col gap-1.5 overflow-y-auto">
        {question.multiSelect
          ? question.options.map((option) => {
              const selected = (chosen ?? '').split(', ').includes(option.label)
              return (
                <div
                  key={option.id}
                  className={`flex items-start gap-2.5 rounded-md border px-3 py-2.5 transition-colors ${
                    selected ? 'border-accent bg-accent-subtle' : 'border-border bg-surface-2 hover:bg-surface-3'
                  }`}
                >
                  <Checkbox
                    checked={selected}
                    disabled={busy}
                    onChange={() => toggleMulti(option.label)}
                  >
                    <span className="block font-medium">{option.label}</span>
                    {option.description ? (
                      <span className="mt-0.5 block text-xs font-normal leading-relaxed text-fg-muted">
                        {option.description}
                      </span>
                    ) : null}
                  </Checkbox>
                </div>
              )
            })
          : question.options.map((option, i) => {
              const selected = !otherOpen && (chosen === option.label || chosen === option.id)
              return (
                <button
                  key={option.id}
                  type="button"
                  disabled={busy}
                  aria-pressed={selected}
                  onClick={() => commit(option.label, true)}
                  className={`flex items-start gap-3 rounded-md border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:pointer-events-none disabled:opacity-60 ${
                    selected ? 'border-accent bg-accent-subtle' : 'border-border bg-surface-2 hover:bg-surface-3'
                  }`}
                >
                  <kbd className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-sm border border-border bg-surface-1 font-mono text-2xs text-fg-muted">
                    {i + 1}
                  </kbd>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-fg">{option.label}</span>
                    {option.description ? (
                      <span className="mt-0.5 block text-xs leading-relaxed text-fg-muted">{option.description}</span>
                    ) : null}
                  </span>
                </button>
              )
            })}
        <button
          type="button"
          disabled={busy}
          aria-pressed={otherOpen}
          aria-expanded={otherOpen}
          onClick={() => setOtherOpen((open) => !open)}
          className={`flex items-start gap-3 rounded-md border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:pointer-events-none disabled:opacity-60 ${
            otherOpen ? 'border-accent bg-accent-subtle' : 'border-border bg-surface-2 hover:bg-surface-3'
          }`}
        >
          <kbd className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-sm border border-border bg-surface-1 font-mono text-2xs text-fg-muted">
            {question.options.length + 1}
          </kbd>
          <span className="min-w-0">
            <span className="block text-sm font-medium text-fg">{OTHER_LABEL}</span>
            <span className="mt-0.5 block text-xs text-fg-muted">Describe your own answer</span>
          </span>
        </button>
        {otherOpen ? (
          <div className="rounded-md border border-accent bg-accent-subtle p-2.5">
            <label htmlFor="question-other-input" className="mb-1.5 block text-xs font-medium text-fg">
              Custom answer
            </label>
            <Textarea
              id="question-other-input"
              autoFocus
              autoGrow
              value={otherDraft}
              disabled={busy}
              onChange={(event) => setOtherDraft(event.target.value)}
              onKeyDown={(event) => {
                // Esc backs out of the custom box without skipping the question.
                if (event.key === 'Escape') {
                  event.stopPropagation()
                  setOtherOpen(false)
                }
              }}
              placeholder="Describe what you want instead…"
            />
            <p className="mt-1.5 text-2xs leading-relaxed text-fg-muted">
              Your text is sent as the answer when you press {last ? 'Submit' : 'Continue'}.
            </p>
          </div>
        ) : null}
      </div>
      <div className="mt-3 flex items-center gap-2">
        {onCancel ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={onCancel}
            title="Skip this question — the agent proceeds with its best judgment (Esc)"
          >
            Skip
          </Button>
        ) : null}
        <span className="flex-1" />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={index === 0 || busy}
          onClick={() => goTo(Math.max(0, index - 1), answers)}
        >
          Back
        </Button>
        <Button type="button" variant="primary" size="sm" disabled={busy || !canContinue} onClick={continueNext}>
          {last ? 'Submit' : 'Continue'}
        </Button>
      </div>
    </section>
  )
}

function PlanApproval({
  prompt,
  planContent,
  onRespond,
}: {
  prompt: string
  planContent: string
  onRespond: (value: string) => void
}) {
  const [mode, setMode] = useState<'idle' | 'changes'>('idle')
  const [feedback, setFeedback] = useState('')
  const [chosen, setChosen] = useState<string | null>(null)

  const pick = (value: string): void => {
    if (chosen != null) return
    setChosen(value)
    onRespond(value)
  }

  return (
    <section role="region" aria-label="Plan approval" className="rounded-lg border border-accent bg-surface-1 p-3">
      <p className="text-sm font-medium text-fg">{prompt}</p>
      <p className="mt-1 text-xs text-fg-muted">The full plan is in the side panel.</p>
      {planContent.length > 0 ? (
        <pre className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface-2 p-2 font-mono text-2xs text-fg-muted">
          {planContent.slice(0, 280)}
          {planContent.length > 280 ? '…' : ''}
        </pre>
      ) : null}
      {mode === 'changes' ? (
        <form
          className="mt-3 flex flex-col gap-2"
          onSubmit={(event: FormEvent) => {
            event.preventDefault()
            const text = feedback.trim()
            pick(JSON.stringify({ outcome: 'cancelled', ...(text.length > 0 ? { feedback: text } : {}) }))
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
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="primary" size="sm" disabled={chosen != null} onClick={() => pick('approved')}>
            Approve
          </Button>
          <Button variant="secondary" size="sm" disabled={chosen != null} onClick={() => setMode('changes')}>
            Request changes
          </Button>
          <Button variant="danger" size="sm" disabled={chosen != null} onClick={() => pick('abandoned')}>
            Abandon
          </Button>
        </div>
      )}
    </section>
  )
}

function FreeText({
  prompt,
  onRespond,
  onCancel,
}: {
  prompt: string
  onRespond: (value: string) => void
  onCancel?: () => void
}) {
  const [draft, setDraft] = useState('')
  const [chosen, setChosen] = useState<string | null>(null)
  const submit = (): void => {
    const value = draft.trim()
    if (value === '' || chosen != null) return
    setChosen(value)
    onRespond(value)
  }
  return (
    <section
      role="region"
      aria-label="Agent question"
      className="rounded-lg border border-accent bg-surface-1 p-4 shadow-2"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && chosen == null) {
          event.preventDefault()
          onCancel?.()
        }
      }}
    >
      <p className="text-sm font-medium text-fg">{prompt}</p>
      <form
        className="mt-3 flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <Input
          aria-label="Answer"
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              submit()
            }
          }}
          className="flex-1"
        />
        {onCancel ? (
          <Button
            type="button"
            variant="ghost"
            size="md"
            disabled={chosen != null}
            onClick={onCancel}
            title="Skip this question — the agent proceeds with its best judgment (Esc)"
          >
            Skip
          </Button>
        ) : null}
        <Button type="submit" variant="primary" size="md" disabled={draft.trim() === '' || chosen != null}>
          Submit
        </Button>
      </form>
    </section>
  )
}

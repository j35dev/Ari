import { useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import { Button } from '@ari/ui/button'
import { Input } from '@ari/ui/input'
import { Textarea } from '@ari/ui/textarea'
import { Checkbox } from '@ari/ui/checkbox'
import { encodeAnswers, parseQuestionPayload, type QuestionItem } from './questionnaire'

const PAGE_SIZE = 9
const AUTO_ADVANCE_MS = 220
const OTHER_LABEL = 'Other'

export interface QuestionPanelProps {
  /** Question text asked by the agent/provider. */
  prompt: string
  /** JSON string containing choices, a questionnaire, or a plan-approval. */
  choicesJson: string | null
  /** Called with the chosen option, submitted free-text, or encoded answers. */
  onRespond: (value: string) => void
}

/**
 * Composer-replacing surface for provider input requests. Follows the same
 * token language as ApprovalCard: surface-1 plate, accent border, numbered
 * option keys. Every multiple-choice question also offers Other so the user
 * can type an answer the agent did not list.
 */
export function QuestionPanel({ prompt, choicesJson, onRespond }: QuestionPanelProps) {
  const payload = parseQuestionPayload(prompt, choicesJson)
  if (payload.kind === 'plan-approval') {
    return <PlanApproval prompt={payload.prompt} planContent={payload.planContent} onRespond={onRespond} />
  }
  if (payload.kind === 'questionnaire') {
    return <QuestionnaireForm prompt={payload.prompt} questions={payload.questions} onRespond={onRespond} />
  }
  if (payload.kind === 'choices') {
    return <ChoiceGrid prompt={payload.prompt} choices={payload.choices} onRespond={onRespond} />
  }
  return <FreeText prompt={payload.prompt} onRespond={onRespond} />
}

function ChoiceGrid({
  prompt,
  choices,
  onRespond,
}: {
  prompt: string
  choices: string[]
  onRespond: (value: string) => void
}) {
  const [page, setPage] = useState(0)
  const [chosen, setChosen] = useState<string | null>(null)
  const [otherOpen, setOtherOpen] = useState(false)
  const [otherDraft, setOtherDraft] = useState('')
  const pageCount = Math.max(1, Math.ceil(choices.length / PAGE_SIZE))
  const visible = choices.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE)

  const choose = (value: string) => {
    if (chosen != null) return
    setChosen(value)
    window.setTimeout(() => onRespond(value), AUTO_ADVANCE_MS)
  }

  const submitOther = () => {
    const value = otherDraft.trim()
    if (value === '' || chosen != null) return
    setChosen(value)
    onRespond(value)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (chosen != null || otherOpen) return
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
    const digit = '123456789'.indexOf(event.key)
    if (digit === -1) return
    const value = choices[page * PAGE_SIZE + digit]
    if (value === undefined) return
    event.preventDefault()
    choose(value)
  }

  return (
    <section
      role="region"
      aria-label="Agent question"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="rounded-md border border-accent bg-surface-1 p-3 shadow-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
    >
      <p className="text-sm text-fg">{prompt}</p>
      <OptionButtons
        options={visible.map((label) => ({ id: label, label }))}
        chosen={chosen}
        onChoose={(id) => choose(id)}
      />
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
      <OtherField
        open={otherOpen}
        draft={otherDraft}
        disabled={chosen != null}
        onOpen={() => setOtherOpen(true)}
        onDraft={setOtherDraft}
        onSubmit={submitOther}
      />
    </section>
  )
}

function QuestionnaireForm({
  prompt,
  questions,
  onRespond,
}: {
  prompt: string
  questions: QuestionItem[]
  onRespond: (value: string) => void
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [otherOpen, setOtherOpen] = useState<Record<string, boolean>>({})
  const [otherDraft, setOtherDraft] = useState<Record<string, string>>({})
  const [submitted, setSubmitted] = useState(false)
  const single = questions.length === 1 && questions[0]?.multiSelect !== true

  const setAnswer = (id: string, value: string, auto = false) => {
    if (submitted) return
    const next = { ...answers, [id]: value }
    setAnswers(next)
    if (auto && single) {
      setSubmitted(true)
      window.setTimeout(() => onRespond(encodeAnswers(next)), AUTO_ADVANCE_MS)
    }
  }

  const toggleMulti = (question: QuestionItem, label: string) => {
    if (submitted) return
    const current = answers[question.id]
    const selected = current === undefined || current === '' ? [] : current.split(', ')
    const next = selected.includes(label) ? selected.filter((s) => s !== label) : [...selected, label]
    setAnswers({ ...answers, [question.id]: next.join(', ') })
  }

  const submit = () => {
    if (submitted) return
    const next = { ...answers }
    for (const question of questions) {
      if (otherOpen[question.id]) {
        const draft = (otherDraft[question.id] ?? '').trim()
        if (draft.length > 0) next[question.id] = draft
      }
    }
    if (questions.some((q) => (next[q.id] ?? '').trim() === '')) return
    setSubmitted(true)
    onRespond(encodeAnswers(next))
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!single || submitted) return
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
    const question = questions[0]
    if (question === undefined || otherOpen[question.id]) return
    const digit = '123456789'.indexOf(event.key)
    if (digit === -1) return
    const option = question.options[digit]
    if (option === undefined) return
    event.preventDefault()
    setAnswer(question.id, option.label, true)
  }

  return (
    <section
      role="region"
      aria-label="Agent question"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className="rounded-md border border-accent bg-surface-1 p-3 shadow-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
    >
      {questions.length > 1 ? <p className="text-sm font-medium text-fg">{prompt}</p> : null}
      <div className={questions.length > 1 ? 'mt-2 flex flex-col gap-3' : ''}>
        {questions.map((question) => {
          const chosen = answers[question.id] ?? null
          const isOther = otherOpen[question.id] === true
          return (
            <div key={question.id} className="flex flex-col gap-2">
              {question.header ? (
                <p className="text-2xs uppercase tracking-[0.12em] text-fg-subtle">{question.header}</p>
              ) : null}
              <p className="text-sm text-fg">{question.question}</p>
              {question.multiSelect ? (
                <div className="flex flex-col gap-1.5">
                  {question.options.map((option) => {
                    const selected = (chosen ?? '').split(', ').includes(option.label)
                    return (
                      <Checkbox
                        key={option.id}
                        checked={selected}
                        disabled={submitted}
                        onChange={() => toggleMulti(question, option.label)}
                      >
                        <span className="text-xs text-fg">{option.label}</span>
                        {option.description ? (
                          <span className="block text-2xs text-fg-muted">{option.description}</span>
                        ) : null}
                      </Checkbox>
                    )
                  })}
                </div>
              ) : (
                <OptionButtons
                  options={question.options}
                  chosen={isOther ? null : chosen}
                  onChoose={(id) => {
                    const option = question.options.find((o) => o.id === id)
                    if (option) setAnswer(question.id, option.label, true)
                  }}
                />
              )}
              <OtherField
                open={isOther}
                draft={otherDraft[question.id] ?? ''}
                disabled={submitted}
                onOpen={() => setOtherOpen({ ...otherOpen, [question.id]: true })}
                onDraft={(value) => setOtherDraft({ ...otherDraft, [question.id]: value })}
                onSubmit={() => {
                  const draft = (otherDraft[question.id] ?? '').trim()
                  if (draft.length === 0) return
                  setAnswer(question.id, draft, true)
                }}
              />
            </div>
          )
        })}
      </div>
      {!single || questions.some((q) => q.multiSelect) ? (
        <div className="mt-3 flex justify-end">
          <Button variant="primary" size="md" disabled={submitted} onClick={submit}>
            Submit
          </Button>
        </div>
      ) : null}
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

  const pick = (value: string) => {
    if (chosen != null) return
    setChosen(value)
    onRespond(value)
  }

  return (
    <section
      role="region"
      aria-label="Plan approval"
      className="rounded-md border border-accent bg-surface-1 p-3 shadow-2"
    >
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
        <p className="text-sm font-medium text-fg">{prompt}</p>
      </div>
      {planContent.length > 0 ? (
        <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface-2 p-2 font-mono text-2xs leading-relaxed text-fg-muted">
          {planContent}
        </pre>
      ) : (
        <p className="mt-2 text-xs text-fg-muted">The agent did not attach a plan body.</p>
      )}
      {mode === 'changes' ? (
        <form
          className="mt-3 flex flex-col gap-2"
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

function FreeText({ prompt, onRespond }: { prompt: string; onRespond: (value: string) => void }) {
  const [draft, setDraft] = useState('')
  const [chosen, setChosen] = useState<string | null>(null)
  const submit = () => {
    const value = draft.trim()
    if (value === '' || chosen != null) return
    setChosen(value)
    onRespond(value)
  }
  return (
    <section
      role="region"
      aria-label="Agent question"
      className="rounded-md border border-accent bg-surface-1 p-3 shadow-2"
    >
      <p className="text-sm text-fg">{prompt}</p>
      <form
        className="mt-2 flex items-center gap-2"
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
        <Button type="submit" variant="primary" size="md" disabled={draft.trim() === ''}>
          Submit
        </Button>
      </form>
    </section>
  )
}

function OptionButtons({
  options,
  chosen,
  onChoose,
}: {
  options: { id: string; label: string; description?: string }[]
  chosen: string | null
  onChoose: (id: string) => void
}) {
  return (
    <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
      {options.map((option, index) => {
        const selected = chosen === option.label || chosen === option.id
        return (
          <button
            key={option.id}
            type="button"
            disabled={chosen != null}
            aria-pressed={selected}
            onClick={() => onChoose(option.id)}
            className={`flex items-start gap-2 rounded-md border px-2 py-1.5 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:pointer-events-none disabled:opacity-60 ${
              selected ? 'border-accent bg-accent-subtle' : 'border-border bg-surface-2 hover:bg-surface-3'
            }`}
          >
            <kbd className="mt-0.5 shrink-0 rounded-sm border border-border bg-surface-1 px-1 font-mono text-2xs font-normal text-fg-muted">
              {index + 1}
            </kbd>
            <span className="min-w-0">
              <span className="block truncate text-fg">{option.label}</span>
              {option.description ? (
                <span className="mt-0.5 block text-2xs text-fg-muted">{option.description}</span>
              ) : null}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function OtherField({
  open,
  draft,
  disabled,
  onOpen,
  onDraft,
  onSubmit,
}: {
  open: boolean
  draft: string
  disabled: boolean
  onOpen: () => void
  onDraft: (value: string) => void
  onSubmit: () => void
}) {
  if (!open) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={onOpen}
        className="mt-2 text-xs text-fg-muted underline-offset-2 transition-colors hover:text-fg hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:pointer-events-none disabled:opacity-60"
      >
        {OTHER_LABEL}…
      </button>
    )
  }
  return (
    <form
      className="mt-2 flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <Input
        aria-label={OTHER_LABEL}
        autoFocus
        value={draft}
        disabled={disabled}
        onChange={(event) => onDraft(event.target.value)}
        placeholder="Describe your own answer"
        className="flex-1"
      />
      <Button type="submit" variant="primary" size="sm" disabled={disabled || draft.trim() === ''}>
        Submit
      </Button>
    </form>
  )
}

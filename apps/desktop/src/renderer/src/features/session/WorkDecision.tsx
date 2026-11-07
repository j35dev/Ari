import { useState } from 'react'
import type { OrchestrationRequest } from '@ari/contracts/orchestration'
import { ApprovalCard } from '../approvals/ApprovalCard'
import { QuestionPanel } from '../approvals/QuestionPanel'
import { invokeWork, workActionKey, workButton } from './work-actions'

export function WorkDecision({
  sessionId,
  request,
  onChanged,
}: {
  sessionId: string
  request: OrchestrationRequest
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [answered, setAnswered] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<{ value: string; key: string } | null>(null)
  const answer = async (value: string) => {
    if (busy || answered) return
    const key = receipt?.value === value ? receipt.key : workActionKey()
    setReceipt({ value, key })
    setBusy(true)
    setError(null)
    try {
      const result = await invokeWork('orchestration.answer', {
        sessionId,
        idempotencyKey: key,
        childSessionId: request.childSessionId,
        requestId: request.requestId,
        kind: request.kind,
        value,
      })
      if (!result.answered)
        throw new Error(
          'The request could not be answered. Refresh the task to check its current state.',
        )
      setAnswered(true)
      onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not answer the request.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section
      aria-label={`${request.title}: ${request.kind}`}
      className="border-b border-border px-3 py-3"
    >
      <p className="mb-2 text-2xs text-fg-subtle">
        {request.title} ·{' '}
        {request.owner === 'lead' ? 'Question for the lead' : 'Needs your decision'}
      </p>
      {answered ? (
        <p role="status" className="text-xs text-success">
          Answer sent
        </p>
      ) : request.actionable ? (
        <fieldset disabled={busy} aria-busy={busy} className="min-w-0">
          {request.kind === 'approval' ? (
            <ApprovalCard
              approvalId={request.requestId}
              toolName={request.toolName ?? 'Agent action'}
              summaryJson={request.summaryJson ?? request.prompt}
              options={request.options}
              onRespond={(value) =>
                void answer('optionId' in value ? value.optionId : value.decision)
              }
            />
          ) : (
            <QuestionPanel
              prompt={request.prompt}
              choicesJson={request.choicesJson}
              onRespond={(value) => void answer(value)}
              onCancel={() => void answer('')}
            />
          )}
        </fieldset>
      ) : (
        <>
          <p className="text-xs leading-relaxed text-fg">{request.prompt}</p>
          <p className="mt-2 text-xs text-fg-muted">
            {request.unavailableReason ??
              'This request is unavailable. Open the conversation to check the provider connection.'}
          </p>
        </>
      )}
      {error ? (
        <div className="mt-2">
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
          {receipt && request.actionable ? (
            <button
              type="button"
              className={`${workButton} mt-1`}
              disabled={busy}
              onClick={() => void answer(receipt.value)}
            >
              Retry answer
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

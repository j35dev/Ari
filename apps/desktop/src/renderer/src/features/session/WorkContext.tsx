import { useEffect, useRef, useState } from 'react'
import type { ContextPackage, OrchestrationTask } from '@ari/contracts/orchestration'
import { rpc } from '../../lib/rpc'
import { invokeWork, workActionKey, workButton, workInput } from './work-actions'

interface MessageOption {
  id: string
  label: string
}

/** Context is explicitly selected, bounded, and previewed before it is used. */
export function WorkContext({
  sessionId,
  tasks,
  purpose = 'assignment',
  onPrepared,
}: {
  sessionId: string
  tasks: readonly OrchestrationTask[]
  purpose?: ContextPackage['purpose']
  onPrepared: (context: ContextPackage | null) => void
}) {
  const [messages, setMessages] = useState<MessageOption[]>([])
  const [messageIds, setMessageIds] = useState<string[]>([])
  const [resultIds, setResultIds] = useState<string[]>([])
  const [files, setFiles] = useState('')
  const [maxChars, setMaxChars] = useState(24000)
  const [preview, setPreview] = useState<ContextPackage | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  useEffect(() => {
    let cancelled = false
    void rpc
      .invoke('session.load', { sessionId })
      .then((model) => {
        const rows =
          (
            model as {
              messages?: { id: string; role: string; parts: { type: string; text?: string }[] }[]
            }
          ).messages ?? []
        if (!cancelled)
          setMessages(
            rows
              .filter((row) => row.role === 'user' || row.role === 'assistant')
              .slice(-30)
              .map((row) => ({
                id: row.id,
                label: `${row.role === 'user' ? 'You' : 'Agent'}: ${row.parts
                  .filter((part) => part.type === 'text')
                  .map((part) => part.text ?? '')
                  .join(' ')
                  .slice(0, 160)}`,
              }))
              .filter((row) => row.label.length > 8),
          )
      })
      .catch(() => {
        if (!cancelled)
          setError(
            'Messages could not be loaded. Files and accepted results can still be selected.',
          )
      })
    return () => {
      cancelled = true
      generation.current += 1
    }
  }, [sessionId])
  const invalidate = () => {
    generation.current += 1
    setPreview(null)
    onPrepared(null)
  }
  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((value) => value !== id) : [...list, id]
  const accepted = tasks.flatMap((task) =>
    task.results
      .filter((result) => result.reviewState === 'accepted' || result.reviewState === 'integrated')
      .map((result) => ({ ...result, title: task.title })),
  )
  return (
    <details className="text-xs text-fg-muted">
      <summary className="cursor-pointer py-2">
        Context package{preview ? ` · ${preview.chars.toLocaleString()} characters` : ' · Optional'}
      </summary>
      <div className="space-y-3 pb-3">
        <p className="text-2xs leading-relaxed text-fg-subtle">
          Select the information this attempt should receive. A portable package includes selected
          text and source references; provider history is not copied automatically.
        </p>
        {messages.length ? (
          <fieldset>
            <legend className="mb-1 text-2xs">Recent conversation messages</legend>
            <div className="max-h-40 space-y-2 overflow-y-auto">
              {messages.map((message) => (
                <label key={message.id} className="flex items-start gap-2 text-2xs">
                  <input
                    type="checkbox"
                    checked={messageIds.includes(message.id)}
                    onChange={() => {
                      setMessageIds(toggle(messageIds, message.id))
                      invalidate()
                    }}
                    className="mt-0.5"
                  />
                  <span className="break-words">{message.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
        <label className="block">
          Workspace files, one path per line
          <textarea
            rows={2}
            value={files}
            onChange={(event) => {
              setFiles(event.target.value)
              invalidate()
            }}
            className={`${workInput} mt-1 font-mono`}
            placeholder="src/api.ts"
          />
        </label>
        {accepted.length ? (
          <fieldset>
            <legend className="mb-1">Accepted results</legend>
            {accepted.map((result) => (
              <label key={result.resultId} className="flex items-start gap-2 py-1 text-2xs">
                <input
                  type="checkbox"
                  checked={resultIds.includes(result.resultId)}
                  onChange={() => {
                    setResultIds(toggle(resultIds, result.resultId))
                    invalidate()
                  }}
                />
                <span>
                  {result.title} · Version {result.version}
                </span>
              </label>
            ))}
          </fieldset>
        ) : null}
        <label className="block">
          Character limit
          <input
            type="number"
            min={1}
            max={64000}
            value={maxChars}
            onChange={(event) => {
              setMaxChars(Number(event.target.value))
              invalidate()
            }}
            className={`${workInput} mt-1`}
          />
        </label>
        <button
          type="button"
          className={workButton}
          disabled={
            busy ||
            (!files.trim() && !messageIds.length && !resultIds.length) ||
            maxChars < 1 ||
            maxChars > 64000
          }
          onClick={() => {
            const request = ++generation.current
            setBusy(true)
            setError(null)
            void invokeWork('orchestration.context', {
              sessionId,
              idempotencyKey: workActionKey(),
              messageIds,
              resultIds,
              files: files
                .split(/\r?\n/)
                .map((path) => path.trim())
                .filter(Boolean),
              maxChars,
              purpose,
            })
              .then((context) => {
                if (request !== generation.current) return
                setPreview(context)
                onPrepared(context)
              })
              .catch((cause) => {
                if (request === generation.current)
                  setError(cause instanceof Error ? cause.message : 'Could not prepare context.')
              })
              .finally(() => setBusy(false))
          }}
        >
          {busy ? 'Preparing…' : 'Build and preview context'}
        </button>
        {preview ? (
          <div className="rounded border border-border bg-surface-1 p-2">
            <p className="text-2xs">
              {preview.chars.toLocaleString()} / {preview.maxChars.toLocaleString()} characters ·{' '}
              {preview.items.length} sources
            </p>
            {preview.items.some((item) => item.truncated) ? (
              <p className="mt-1 text-2xs text-warning">
                Some selected content was truncated to fit the limit.
              </p>
            ) : null}
            <div className="mt-2 max-h-56 space-y-3 overflow-auto">
              {preview.items.map((item, index) => (
                <div key={index}>
                  <p className="break-all text-2xs font-medium">
                    {item.kind} · {item.sourceId}
                    {item.truncated ? ' · Truncated' : ''}
                  </p>
                  <pre className="mt-1 whitespace-pre-wrap break-words text-2xs">
                    {item.content}
                  </pre>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </details>
  )
}

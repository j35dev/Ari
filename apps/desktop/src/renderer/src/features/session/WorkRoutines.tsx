import { useRef, useState } from 'react'
import type { ScheduledRoutine } from '@ari/contracts/agent-control'
import { invokeWork, workActionKey, workButton, workInput } from './work-actions'

/** Uses the same durable scheduled prompts as the CLI. Nothing runs until scheduled. */
export function WorkRoutines({
  sessionId,
  titleOf,
}: {
  sessionId: string
  titleOf: (id: string) => string | undefined
}) {
  const [rows, setRows] = useState<ScheduledRoutine[]>([])
  const [prompt, setPrompt] = useState('')
  const [delayMinutes, setDelayMinutes] = useState(30)
  const [everyMinutes, setEveryMinutes] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef<{ fingerprint: string; key: string; at: number } | null>(null)
  const removalKeys = useRef(new Map<string, string>())
  const load = async () => {
    const result = await invokeWork('orchestration.routine.list', { sessionId, recursive: true })
    setRows(result.routines)
  }
  const run = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await action()
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update scheduled prompts.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <details
      className="border-t border-border px-4 py-3 text-2xs text-fg-subtle"
      onToggle={(event) => {
        if (event.currentTarget.open)
          void load().catch((cause) =>
            setError(cause instanceof Error ? cause.message : 'Could not load scheduled prompts.'),
          )
      }}
    >
      <summary className="cursor-pointer">Scheduled prompts</summary>
      <ul className="mt-3 space-y-3">
        {rows.map((row) => (
          <li key={row.id} className="text-xs leading-relaxed text-fg-muted">
            <p className="whitespace-pre-wrap">{row.prompt}</p>
            <p className="mt-1 text-2xs text-fg-subtle">
              {titleOf(row.sessionId) ??
                (row.sessionId === sessionId ? 'This conversation' : 'Worker conversation')}{' '}
              · {new Date(row.at).toLocaleString()}
              {row.everyMs ? ` · Every ${Math.round(row.everyMs / 60000)} minutes` : ' · Once'}
            </p>
            <button
              type="button"
              className={`${workButton} mt-1`}
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const key = removalKeys.current.get(row.id) ?? workActionKey()
                  removalKeys.current.set(row.id, key)
                  await invokeWork('orchestration.routine.remove', {
                    sessionId,
                    routineId: row.id,
                    idempotencyKey: key,
                  })
                })
              }
            >
              Remove scheduled prompt
            </button>
          </li>
        ))}
      </ul>
      {!rows.length && !error ? <p className="mt-2">No scheduled prompts.</p> : null}
      <form
        className="mt-3 space-y-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (!prompt.trim() || delayMinutes < 1 || (everyMinutes > 0 && everyMinutes < 5)) return
          const fingerprint = JSON.stringify([prompt.trim(), delayMinutes, everyMinutes])
          if (pending.current?.fingerprint !== fingerprint)
            pending.current = {
              fingerprint,
              key: workActionKey(),
              at: Date.now() + delayMinutes * 60000,
            }
          const receipt = pending.current
          void run(async () => {
            await invokeWork('orchestration.routine.add', {
              sessionId,
              prompt: prompt.trim(),
              at: receipt.at,
              everyMs: everyMinutes ? everyMinutes * 60000 : null,
              idempotencyKey: receipt.key,
            })
            setPrompt('')
            pending.current = null
          })
        }}
      >
        <label className="block text-xs text-fg-muted">
          Prompt
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            required
            rows={3}
            maxLength={64000}
            className={`${workInput} mt-1`}
            placeholder="Check CI and report failed checks…"
          />
        </label>
        <p className="text-2xs leading-relaxed">
          The prompt runs in this conversation without anyone present. Include the information the
          agent needs.
        </p>
        <label className="block text-xs text-fg-muted">
          Start in minutes
          <input
            type="number"
            min={1}
            value={delayMinutes}
            onChange={(event) => setDelayMinutes(Number(event.target.value))}
            className={`${workInput} mt-1`}
          />
        </label>
        <label className="block text-xs text-fg-muted">
          Repeat every minutes · 0 for once
          <input
            type="number"
            min={0}
            value={everyMinutes}
            onChange={(event) => setEveryMinutes(Number(event.target.value))}
            className={`${workInput} mt-1`}
          />
        </label>
        {everyMinutes > 0 && everyMinutes < 5 ? (
          <p className="text-xs text-warning">Repeats must be at least five minutes apart.</p>
        ) : null}
        <button
          type="submit"
          className={workButton}
          disabled={
            busy || !prompt.trim() || delayMinutes < 1 || (everyMinutes > 0 && everyMinutes < 5)
          }
        >
          {busy ? 'Scheduling…' : 'Schedule prompt'}
        </button>
      </form>
      {error ? (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </details>
  )
}

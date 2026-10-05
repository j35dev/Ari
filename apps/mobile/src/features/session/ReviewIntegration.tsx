import { useState, type ReactNode } from 'react'
import type { RemoteIntegrationPreview } from '@ari/contracts/remote'
import { GitMerge } from 'lucide-react'
import { BottomSheet } from '../../components/ui'
import { useApp } from '../../lib/app-state'
import { RemoteError } from '../../lib/gateway-client'
import {
  readIntegration,
  writeIntegration,
  type ReviewedIntegration,
} from '../../lib/integration-review'

/** Integrate only the child and parent snapshots the user explicitly reviewed. */
export function ReviewIntegration({
  sessionId,
  onChanged,
}: {
  sessionId: string
  onChanged: () => Promise<void>
}): ReactNode {
  const app = useApp()
  const deviceId = app.session?.deviceId ?? null
  const [restored] = useState(() => readIntegration(app.origin, deviceId, sessionId))
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [reviewed, setReviewed] = useState<ReviewedIntegration | null>(restored)
  const [failure, setFailure] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<string | null>(null)
  const [uncertain, setUncertain] = useState(restored !== null)
  const supported =
    app.session?.supports('changes.preview') === true && app.session.supports('changes.integrate')
  if (!supported) return null

  async function review(): Promise<void> {
    if (app.session === null || busy) return
    setOpen(true)
    setBusy(true)
    setFailure(null)
    setReceipt(null)
    setReviewed(null)
    try {
      const result = await app.session.query<{
        preview: RemoteIntegrationPreview | null
        error: string | null
      } | null>('changes.preview', { sessionId })
      if (result === null || result.preview === null)
        throw new Error(result?.error ?? 'Integration is unavailable for this workspace.')
      setReviewed({ preview: result.preview, key: crypto.randomUUID() })
      setUncertain(false)
    } catch (error) {
      setFailure(messageOf(error))
    } finally {
      setBusy(false)
    }
  }
  async function integrate(): Promise<void> {
    if (app.session === null || reviewed === null || busy) return
    if (!writeIntegration(app.origin, deviceId, sessionId, reviewed)) {
      setFailure(
        'This browser cannot preserve the integration receipt. Free browser storage before integrating. No changes were sent.',
      )
      return
    }
    setBusy(true)
    setFailure(null)
    try {
      const outcome = (await app.session.send(
        {
          op: 'changes.integrate',
          sessionId,
          snapshotCommit: reviewed.preview.snapshotCommit,
          expectedParentSnapshot: reviewed.preview.expectedParentSnapshot,
        },
        reviewed.key,
      )) as { result?: { status: string; files?: string[] }; status?: string; files?: string[] }
      const result = outcome.result ?? outcome
      if (result.status === 'conflict') {
        setFailure(
          `These files need conflict resolution on your computer: ${result.files?.join(', ') ?? 'review the parent workspace'}. No changes were applied.`,
        )
        setReviewed(null)
        writeIntegration(app.origin, deviceId, sessionId, null)
      } else if (result.status === 'integrated' || result.status === 'already_integrated') {
        setReceipt(
          result.status === 'already_integrated'
            ? 'This snapshot was already integrated.'
            : 'Changes integrated into the parent workspace.',
        )
        setReviewed(null)
        writeIntegration(app.origin, deviceId, sessionId, null)
        await onChanged().catch((error: unknown) =>
          setFailure(`Integrated, but refresh failed: ${messageOf(error)}`),
        )
      } else
        throw new Error('The computer did not confirm integration. Retry checks the same request.')
      setUncertain(false)
    } catch (error) {
      setFailure(messageOf(error))
      if (error instanceof RemoteError && !['unreachable', 'internal_error'].includes(error.code)) {
        setReviewed(null)
        setUncertain(false)
        writeIntegration(app.origin, deviceId, sessionId, null)
      } else setUncertain(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <button
        type="button"
        disabled={busy || app.connection !== 'connected'}
        className="secondary-button mb-4 w-full gap-2"
        onClick={() => {
          if (reviewed !== null && uncertain) setOpen(true)
          else void review()
        }}
      >
        <GitMerge size={16} />
        {uncertain ? 'Continue integration review' : 'Review integration'}
      </button>
      {open && (
        <BottomSheet
          title="Integrate changes"
          onClose={() => {
            if (!busy) setOpen(false)
          }}
        >
          <p className="py-3 text-sm leading-relaxed text-fg-muted">
            Apply this fork’s changes to its parent workspace. Both sessions must be idle. Ari
            checks both snapshots again before applying.
          </p>
          {busy && (
            <p role="status" className="py-3 text-sm text-fg-muted">
              {reviewed === null ? 'Preparing a fresh preview…' : 'Waiting for your computer…'}
            </p>
          )}
          {reviewed !== null && (
            <>
              <dl className="rounded-xl border border-border bg-surface-1 px-3 text-xs">
                <div className="flex justify-between gap-3 py-3">
                  <dt className="text-fg-muted">Child snapshot</dt>
                  <dd className="font-mono">{reviewed.preview.snapshotCommit.slice(0, 12)}</dd>
                </div>
                <div className="flex justify-between gap-3 border-t border-border py-3">
                  <dt className="text-fg-muted">Parent snapshot</dt>
                  <dd className="font-mono">
                    {reviewed.preview.expectedParentSnapshot.slice(0, 12)}
                  </dd>
                </div>
              </dl>
              <ol className="my-3 divide-y divide-border">
                {reviewed.preview.files.map((file) => (
                  <li key={file.path} className="py-3">
                    <span className="block break-words font-mono text-xs">{file.path}</span>
                    <span className="mt-1 block text-xs text-fg-muted">
                      {file.status} ·{' '}
                      {file.binary ? 'Binary' : `+${file.additions} −${file.deletions}`}
                    </span>
                  </li>
                ))}
              </ol>
              {reviewed.preview.files.length === 0 && (
                <p className="py-3 text-sm text-fg-muted">No changes to integrate.</p>
              )}
              <button
                type="button"
                className="primary-button mb-3 w-full"
                disabled={
                  busy || reviewed.preview.files.length === 0 || app.connection !== 'connected'
                }
                onClick={() => void integrate()}
              >
                {uncertain ? 'Retry same integration' : 'Integrate reviewed changes'}
              </button>
            </>
          )}
          {failure !== null && (
            <p role="alert" className="error-banner mb-3">
              {failure}
            </p>
          )}
          {receipt !== null && (
            <p role="status" className="mb-3 text-sm text-success">
              {receipt}
            </p>
          )}
          {reviewed === null && !busy && receipt === null && (
            <button
              type="button"
              className="secondary-button mb-3 w-full"
              onClick={() => void review()}
            >
              Refresh preview
            </button>
          )}
        </BottomSheet>
      )}
    </>
  )
}
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'The computer could not complete integration.'
}

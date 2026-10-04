import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowUp, ChevronDown, ImagePlus, LoaderCircle, Square, X } from 'lucide-react'
import type { AttachmentRef } from '@ari/contracts/attachments'
import { useApp } from '../../lib/app-state'
import {
  readDraft,
  writeDraft,
  readPending,
  writePending,
  type PendingSubmission,
} from '../../lib/draft'
import { RemoteError } from '../../lib/gateway-client'
import { WorkingIndicator } from './WorkingIndicator'

/** One draft and one receipt key per submission, retained through an uncertain response. */
export function Composer({
  sessionId,
  status,
  modelLabel,
  disabled,
  modelDisabled = false,
  onDetails,
  onSent,
  onError,
}: {
  sessionId: string
  status: string
  modelLabel: string | null
  disabled: boolean
  modelDisabled?: boolean
  onDetails: () => void
  onSent: () => Promise<void>
  onError: (error: string) => void
}): ReactNode {
  const app = useApp()
  const deviceId = app.session?.deviceId ?? null
  const [restored] = useState(() => readPending(app.origin, deviceId, sessionId))
  const [text, setText] = useState(
    () => restored?.text ?? readDraft(app.origin, sessionId, deviceId),
  )
  const [attachments, setAttachments] = useState<AttachmentRef[]>([])
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [receipt, setReceipt] = useState<string | null>(
    restored === null ? null : 'Unconfirmed submission restored. Retry checks the same receipt.',
  )
  const [pending, setPending] = useState<PendingSubmission | null>(restored)
  const area = useRef<HTMLTextAreaElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const running = status === 'running'
  useEffect(() => {
    writeDraft(app.origin, sessionId, text, deviceId)
  }, [app.origin, deviceId, sessionId, text])
  useEffect(() => {
    if (area.current !== null) {
      area.current.style.height = 'auto'
      area.current.style.height = `${Math.min(160, area.current.scrollHeight)}px`
    }
  }, [text])
  async function submit(mode: 'send' | 'queue' | 'steer'): Promise<void> {
    const session = app.session
    if (
      session === null ||
      busy ||
      uploading ||
      disabled ||
      (pending === null && !text.trim() && attachments.length === 0)
    )
      return
    const command = pending ?? {
      key: crypto.randomUUID(),
      text: text.trim(),
      mode,
      attachmentIds: attachments.map((item) => item.id),
    }
    if (!writePending(app.origin, deviceId, sessionId, command)) {
      onError(
        'This browser cannot preserve a submission receipt. Free browser storage before sending. Your draft has not been sent.',
      )
      return
    }
    setBusy(true)
    setPending(command)
    setReceipt(null)
    try {
      await session.send(
        {
          op:
            command.mode === 'queue'
              ? 'session.queue'
              : command.mode === 'steer'
                ? 'session.steer'
                : 'session.prompt',
          sessionId,
          text: command.text,
          ...(command.attachmentIds.length === 0 ? {} : { attachmentIds: command.attachmentIds }),
        },
        command.key,
      )
      setText('')
      setAttachments([])
      setPending(null)
      writePending(app.origin, deviceId, sessionId, null)
      setReceipt(command.mode === 'queue' ? 'Queued on your computer' : 'Accepted by your computer')
      await onSent().catch((error: unknown) =>
        onError(
          error instanceof Error
            ? `Accepted, but the conversation could not refresh: ${error.message}`
            : 'Accepted. Refresh the conversation to see the update.',
        ),
      )
    } catch (error) {
      onError(
        error instanceof Error
          ? error.message
          : 'The response was lost. Retry to check the same submission.',
      )
      if (
        error instanceof RemoteError &&
        !['unreachable', 'internal_error', 'conflict'].includes(error.code)
      ) {
        setPending(null)
        writePending(app.origin, deviceId, sessionId, null)
        setReceipt('Not accepted. Your draft is still here.')
      } else setReceipt('Response uncertain. Retry checks this submission using the same receipt.')
    } finally {
      setBusy(false)
    }
  }
  async function upload(file: File): Promise<void> {
    if (app.session === null) return
    if (file.size > 1024 * 1024) {
      onError('Choose an image smaller than 1 MB.')
      return
    }
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type)) {
      onError('Choose a PNG, JPEG, GIF, or WebP image.')
      return
    }
    setUploading(true)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      let binary = ''
      for (const byte of bytes) binary += String.fromCharCode(byte)
      const outcome = await app.session.send({
        op: 'attachments.stage',
        sessionId,
        files: [{ name: file.name, mimeType: file.type, dataBase64: btoa(binary) }],
      })
      const envelope = outcome as {
        result?: { attachments?: AttachmentRef[] }
        attachments?: AttachmentRef[]
      }
      const staged = envelope.result?.attachments ?? envelope.attachments
      if (staged === undefined) throw new Error('The computer did not confirm this attachment.')
      setAttachments((current) => [...current, ...staged].slice(0, 4))
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Could not upload this image.')
    } finally {
      setUploading(false)
      if (input.current !== null) input.current.value = ''
    }
  }
  const canSend =
    !disabled &&
    !busy &&
    !uploading &&
    (pending !== null || text.trim().length > 0 || attachments.length > 0)
  const stopInstead =
    running &&
    pending === null &&
    !text.trim() &&
    attachments.length === 0 &&
    app.session?.supports('session.interrupt') === true
  function stop(): void {
    setBusy(true)
    void app.session
      ?.send({ op: 'session.interrupt', sessionId })
      .then(onSent)
      .catch((error: unknown) =>
        onError(error instanceof Error ? error.message : 'Could not interrupt.'),
      )
      .finally(() => setBusy(false))
  }
  return (
    <div className="mobile-composer shrink-0 bg-bg px-4 pt-2">
      {!disabled && (running || busy) && <WorkingIndicator sending={!running} />}
      <form
        className="rounded-2xl border border-border bg-surface-1 p-2"
        onSubmit={(event) => {
          event.preventDefault()
          void submit(running ? 'queue' : 'send')
        }}
      >
        <textarea
          ref={area}
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={1}
          disabled={busy || pending !== null}
          placeholder="What should we work on?"
          aria-label="Message the agent"
          className="max-h-40 min-h-11 w-full resize-none bg-transparent px-2 py-2.5 text-base leading-relaxed outline-none placeholder:text-fg-subtle"
        />
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-2 pb-2">
            {attachments.map((item) => (
              <span
                key={item.id}
                className="flex min-h-11 max-w-full items-center gap-2 rounded-lg border border-border px-2 text-xs"
              >
                <span className="truncate">{item.name}</span>
                <button
                  type="button"
                  className="flex size-8 items-center justify-center"
                  aria-label={`Remove ${item.name}`}
                  disabled={busy || pending !== null}
                  onClick={() =>
                    setAttachments((current) => current.filter((entry) => entry.id !== item.id))
                  }
                >
                  <X size={13} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          {app.session?.supports('attachments.stage') && (
            <>
              <input
                ref={input}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                className="hidden"
                aria-label="Attach image"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file !== undefined) void upload(file)
                }}
              />
              <button
                type="button"
                className="icon-button text-fg-muted"
                aria-label="Choose an image"
                disabled={uploading || busy || pending !== null || attachments.length >= 4}
                onClick={() => input.current?.click()}
              >
                {uploading ? (
                  <LoaderCircle size={17} className="animate-spin" />
                ) : (
                  <ImagePlus size={18} />
                )}
              </button>
            </>
          )}
          <button
            type="button"
            className="flex min-h-11 min-w-0 flex-1 items-center gap-1.5 px-1 text-xs text-fg-muted disabled:opacity-50"
            onClick={onDetails}
            aria-label="Choose model"
            disabled={modelDisabled || busy || pending !== null}
          >
            <span className="truncate">{modelLabel ?? 'Connecting…'}</span>
            <ChevronDown size={13} className="shrink-0" />
          </button>
          {running && app.session?.supports('session.steer') && (
            <button
              type="button"
              className="min-h-11 px-2 text-xs text-fg-muted"
              disabled={!canSend || attachments.length > 0 || pending !== null}
              onClick={() => void submit('steer')}
            >
              Steer
            </button>
          )}
          <button
            type={stopInstead ? 'button' : 'submit'}
            className="icon-button bg-accent text-fg-on-accent"
            disabled={stopInstead ? disabled || busy || uploading : !canSend}
            onClick={stopInstead ? stop : undefined}
            aria-label={
              stopInstead
                ? 'Stop'
                : pending !== null
                  ? 'Retry same submission'
                  : running
                    ? 'Queue message'
                    : 'Send message'
            }
          >
            {busy ? (
              <LoaderCircle size={18} className="animate-spin" />
            ) : stopInstead ? (
              <Square size={14} fill="currentColor" />
            ) : (
              <ArrowUp size={20} />
            )}
          </button>
        </div>
      </form>
      {receipt !== null && (
        <p role="status" className="mt-2 text-center text-[11px] text-fg-muted">
          {receipt}
        </p>
      )}
      {pending !== null && pending.attachmentIds.length > 0 && (
        <p className="mt-1 text-center text-[11px] text-fg-subtle">
          Retry includes {pending.attachmentIds.length} staged images from this submission.
        </p>
      )}
    </div>
  )
}

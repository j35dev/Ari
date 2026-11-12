import { useState } from 'react'
import type { ChangeRequest, ChangeRequestAction } from '@ari/contracts/rpc'
import { Button } from '@ari/ui/button'
import { Dialog } from '@ari/ui/dialog'
import { Select } from '@ari/ui/select'
import { cx, sectionLabel } from '../../lib/recipes'

export function RequestActions({
  request,
  run,
  disabled,
}: {
  request: ChangeRequest
  run: (action: ChangeRequestAction) => Promise<{ ok: boolean; message: string }>
  disabled: boolean
}) {
  const [text, setText] = useState('')
  const [kind, setKind] = useState<'comment' | 'approve' | 'request-changes'>('comment')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null)
  const [confirm, setConfirm] = useState<'merge' | 'close' | null>(null)
  const [method, setMethod] = useState<'merge' | 'squash' | 'rebase'>('squash')
  const perform = async (action: ChangeRequestAction): Promise<void> => {
    if (busy || disabled) return
    setBusy(true)
    setNotice(null)
    setConfirm(null)
    try {
      const result = await run(action)
      setNotice(result)
      if (result.ok && ['comment', 'approve', 'request-changes'].includes(action.kind)) setText('')
    } catch {
      setNotice({
        ok: false,
        message: 'The action result could not be confirmed. Refresh before retrying.',
      })
    } finally {
      setBusy(false)
    }
  }
  const options = [
    ...(request.capabilities.comments ? [{ value: 'comment', label: 'Comment' }] : []),
    ...request.capabilities.review
      .filter((value) => value !== 'comment')
      .map((value) => ({ value, label: value === 'approve' ? 'Approve' : 'Request changes' })),
  ]
  const selectedKind = options.some((option) => option.value === kind) ? kind : options[0]?.value
  const mergeMethod = request.capabilities.merge.includes(method)
    ? method
    : request.capabilities.merge[0]
  const submit = (): void => {
    if (selectedKind === 'approve') void perform({ kind: 'approve', text })
    else if (text.trim() && selectedKind === 'comment') void perform({ kind: 'comment', text })
    else if (text.trim() && selectedKind === 'request-changes')
      void perform({ kind: 'request-changes', text })
  }
  return (
    <div className="mt-6">
      {options.length ? (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <h3 className={cx(sectionLabel, 'mb-2')}>Your review</h3>
          <textarea
            aria-label="Review comment"
            rows={4}
            maxLength={8000}
            disabled={busy || disabled}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Leave a comment or describe your review…"
            className="w-full resize-y rounded-md border border-border bg-surface-1 px-3 py-2 text-[13px] leading-relaxed text-fg transition-colors placeholder:text-fg-subtle hover:border-border-strong focus-visible:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:opacity-50"
          />
          <div className="mt-2 flex items-center gap-2">
            <div className="w-40 shrink-0">
              <Select
                aria-label="Review action"
                value={selectedKind ?? 'comment'}
                options={options}
                onValueChange={(value) => setKind(value as typeof kind)}
                disabled={busy || disabled}
                className="w-full"
              />
            </div>
            <div className="flex-1" />
            <Button
              type="submit"
              size="sm"
              variant="primary"
              className="shrink-0 whitespace-nowrap"
              disabled={busy || disabled || (selectedKind !== 'approve' && !text.trim())}
            >
              {busy
                ? 'Submitting…'
                : selectedKind === 'approve'
                  ? 'Approve'
                  : selectedKind === 'request-changes'
                    ? 'Request changes'
                    : 'Post comment'}
            </Button>
          </div>
        </form>
      ) : null}
      {notice ? (
        <p
          role={notice.ok ? 'status' : 'alert'}
          className={`mt-3 text-[13px] ${notice.ok ? 'text-fg-muted' : 'text-danger'}`}
        >
          {notice.message}
        </p>
      ) : null}
      <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-border pt-4">
        {request.capabilities.close ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || disabled}
            onClick={() => setConfirm('close')}
          >
            Close request
          </Button>
        ) : null}
        <div className="flex-1" />
        {request.draft && request.capabilities.draft ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || disabled}
            onClick={() => void perform({ kind: 'ready' })}
          >
            Mark ready for review
          </Button>
        ) : request.capabilities.merge.length ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || disabled || !request.headOid}
            onClick={() => setConfirm('merge')}
          >
            Merge…
          </Button>
        ) : null}
      </div>
      <Dialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <Dialog.Content>
          <Dialog.Title>
            {confirm === 'merge' ? `Merge #${request.number}` : `Close #${request.number}`}
          </Dialog.Title>
          <Dialog.Description>
            {confirm === 'merge'
              ? `Merge ${request.head} into ${request.base}. The host checks permissions, conflicts and branch protection.`
              : `Close “${request.title}” without merging its changes.`}
          </Dialog.Description>
          {confirm === 'merge' ? (
            <div className="mt-3">
              <Select
                aria-label="Merge method"
                value={mergeMethod ?? 'merge'}
                options={request.capabilities.merge.map((value) => ({
                  value,
                  label:
                    value === 'squash'
                      ? 'Squash and merge'
                      : value === 'rebase'
                        ? 'Rebase and merge'
                        : 'Create a merge commit',
                }))}
                onValueChange={(value) => setMethod(value as typeof method)}
                className="w-full"
              />
              <p className="mt-2 font-mono text-xs text-fg-subtle">
                Reviewed head · {request.headOid?.slice(0, 12)}
              </p>
            </div>
          ) : null}
          <div className="mt-4 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant={confirm === 'close' ? 'danger' : 'primary'}
              onClick={() => {
                if (confirm === 'merge' && request.headOid && mergeMethod)
                  void perform({ kind: 'merge', method: mergeMethod, headOid: request.headOid })
                else if (confirm === 'close') void perform({ kind: 'close' })
              }}
            >
              {confirm === 'merge' ? 'Merge request' : 'Close request'}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog>
    </div>
  )
}

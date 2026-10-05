import { useEffect, useState, type ReactNode } from 'react'
import { UserPlus, Check, Copy } from 'lucide-react'
import { BottomSheet } from '../../components/ui'
import { connectRequest, type ConnectAccount } from '../../lib/connect'

interface Overview {
  members: { id: string; email: string; status: string }[]
  invitations: { id: string; email: string; status: string; expiresAt: string }[]
  disabled: boolean
}

/** Owner-only private-beta controls. The service independently enforces every authorization. */
export function OwnerAccess(): ReactNode {
  const [account, setAccount] = useState<ConnectAccount | null>(null)
  const [open, setOpen] = useState(false)
  const [overview, setOverview] = useState<Overview | null>(null)
  const [email, setEmail] = useState('')
  const [loginUrl, setLoginUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{
    id: string
    email: string
    status: 'suspended' | 'active'
  } | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    void connectRequest<ConnectAccount>('/me', { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setAccount(value)
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) console.warn('Could not check owner access', error)
      })
    return () => controller.abort()
  }, [])
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    void connectRequest<Overview>('/admin/overview', { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setOverview(value)
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setFailure(error instanceof Error ? error.message : 'Could not load members.')
      })
    return () => controller.abort()
  }, [open])
  async function invite(): Promise<void> {
    if (account === null || busy) return
    setBusy(true)
    setFailure(null)
    try {
      const result = await connectRequest<{ loginUrl: string }>('/admin/invitations', {
        csrfToken: account.csrfToken,
        body: { email: email.trim() },
      })
      setLoginUrl(result.loginUrl)
      setCopied(false)
      setEmail('')
      setOverview(await connectRequest<Overview>('/admin/overview'))
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Could not approve this email.')
    } finally {
      setBusy(false)
    }
  }
  async function update(): Promise<void> {
    if (account === null || confirm === null || busy) return
    setBusy(true)
    setFailure(null)
    try {
      await connectRequest(`/admin/members/${encodeURIComponent(confirm.id)}/status`, {
        csrfToken: account.csrfToken,
        body: { status: confirm.status },
      })
      setOverview(await connectRequest<Overview>('/admin/overview'))
      setConfirm(null)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Could not update this member.')
    } finally {
      setBusy(false)
    }
  }
  async function revokeInvitation(id: string): Promise<void> {
    if (account === null || busy) return
    setBusy(true)
    try {
      await connectRequest(`/admin/invitations/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        csrfToken: account.csrfToken,
      })
      setOverview(await connectRequest<Overview>('/admin/overview'))
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Could not revoke this invitation.')
    } finally {
      setBusy(false)
    }
  }
  if (account?.isOwner !== true) return null
  return (
    <>
      <h2 className="section-label mt-6">Private beta</h2>
      <button
        type="button"
        className="secondary-button w-full justify-start"
        onClick={() => setOpen(true)}
      >
        <UserPlus size={16} />
        Manage approved people
      </button>
      {open && (
        <BottomSheet
          title="Approved people"
          onClose={() => {
            setOpen(false)
            setConfirm(null)
          }}
        >
          <p className="mb-4 text-xs leading-relaxed text-fg-muted">
            Approve an exact email address. Each person signs in and pairs their own computers and
            phones.
          </p>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault()
              void invite()
            }}
          >
            <label className="block text-xs text-fg-muted">
              Email address
              <input
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoCapitalize="none"
                className="mt-2 min-h-12 w-full rounded-xl border border-border bg-surface-1 px-3 text-fg"
              />
            </label>
            <button
              type="submit"
              className="primary-button w-full"
              disabled={busy || !email.trim()}
            >
              {busy ? 'Updating…' : 'Approve email'}
            </button>
          </form>
          {loginUrl !== null && (
            <div className="mt-4 rounded-xl border border-border bg-surface-1 p-3">
              <p className="text-xs text-fg-muted">
                Email approved. Share the sign-in link yourself.
              </p>
              <button
                type="button"
                className="mt-2 flex min-h-11 items-center gap-2 break-all text-xs"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(loginUrl)
                    .then(() => setCopied(true))
                    .catch(() => setFailure('Clipboard access is unavailable.'))
                }}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? 'Copied' : loginUrl}
              </button>
            </div>
          )}
          {failure !== null && (
            <p role="alert" className="error-banner">
              {failure}
            </p>
          )}
          {overview !== null && (
            <>
              <h3 className="section-label mt-5">Members</h3>
              <ul className="divide-y divide-border">
                {overview.members.map((member) => (
                  <li
                    key={member.id}
                    className="flex min-h-16 items-center justify-between gap-3 py-2"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm">{member.email}</span>
                      <span className="mt-1 block text-xs text-fg-subtle">{member.status}</span>
                    </span>
                    {member.id !== account.member.id && member.status !== 'revoked' && (
                      <button
                        type="button"
                        className="min-h-11 text-xs text-fg-muted"
                        disabled={busy}
                        onClick={() =>
                          setConfirm({
                            id: member.id,
                            email: member.email,
                            status: member.status === 'active' ? 'suspended' : 'active',
                          })
                        }
                      >
                        {member.status === 'active' ? 'Suspend' : 'Restore'}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {confirm !== null && (
                <div className="my-3 rounded-xl border border-border bg-surface-1 p-3">
                  <p className="text-xs leading-relaxed">
                    {confirm.status === 'suspended' ? 'Suspend' : 'Restore'} {confirm.email}?{' '}
                    {confirm.status === 'suspended' &&
                      'New leases stop immediately; existing managed access expires within two minutes.'}
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      className="secondary-button flex-1"
                      onClick={() => setConfirm(null)}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="primary-button flex-1"
                      disabled={busy}
                      onClick={() => void update()}
                    >
                      Confirm
                    </button>
                  </div>
                </div>
              )}
              <h3 className="section-label mt-5">Pending invitations</h3>
              <ul className="divide-y divide-border">
                {overview.invitations
                  .filter((invitation) => invitation.status === 'pending')
                  .map((invitation) => (
                    <li
                      key={invitation.id}
                      className="flex min-h-14 items-center justify-between gap-3"
                    >
                      <span className="min-w-0 truncate text-sm">{invitation.email}</span>
                      <button
                        type="button"
                        className="min-h-11 text-xs text-danger"
                        disabled={busy}
                        onClick={() => void revokeInvitation(invitation.id)}
                      >
                        Revoke
                      </button>
                    </li>
                  ))}
              </ul>
            </>
          )}
        </BottomSheet>
      )}
    </>
  )
}

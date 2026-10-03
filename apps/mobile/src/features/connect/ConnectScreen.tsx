import { useEffect, useState, type ReactNode } from 'react'
import { ArrowRight, Laptop, LogOut, RefreshCw, ShieldCheck } from 'lucide-react'
import { useApp } from '../../lib/app-state'
import { connectRequest, type ConnectAccount, type ConnectComputer } from '../../lib/connect'
import { EmptyState } from '../../components/EmptyState'

/** Invite-only account entry and computer selection, on the broker's own origin. */
export function ConnectScreen(): ReactNode {
  const app = useApp()
  const [account, setAccount] = useState<ConnectAccount | null>(null)
  const [computers, setComputers] = useState<ConnectComputer[]>([])
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const requested = new URL(location.href).searchParams.get('computer')
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setFailure(null)
    void (async () => {
      try {
        const nextAccount = await connectRequest<ConnectAccount>('/me', {
          signal: controller.signal,
        })
        const result = await connectRequest<{ computers: ConnectComputer[] }>('/computers', {
          signal: controller.signal,
        })
        if (!controller.signal.aborted) {
          setAccount(nextAccount)
          setComputers(result.computers)
        }
      } catch (error) {
        if (!controller.signal.aborted)
          setFailure(error instanceof Error ? error.message : 'Could not reach Ari Connect.')
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    })()
    return () => controller.abort()
  }, [revision])
  async function logout(): Promise<void> {
    if (account === null) return
    try {
      await connectRequest('/auth/logout', { csrfToken: account.csrfToken, body: {} })
      setAccount(null)
      setComputers([])
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Could not sign out.')
    }
  }
  function choose(computer: ConnectComputer): void {
    try {
      if (computer.hostname === null || !/^[a-z0-9.-]+$/i.test(computer.hostname))
        throw new Error('This computer is not ready yet.')
      app.chooseComputer(computer.computerId, `https://${computer.hostname}`)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Could not select this computer.')
    }
  }
  return (
    <div className="mobile-shell overflow-y-auto px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(1.5rem,env(safe-area-inset-top))]">
      <header className="flex items-center justify-between">
        <span className="text-2xl font-semibold tracking-[-0.06em]">
          ari<span className="text-accent">.</span>
        </span>
        <span className="rounded-full border border-border px-3 py-1.5 text-[11px] text-fg-muted">
          Connect · Private beta
        </span>
      </header>
      <div className="mb-6 mt-12">
        <h1 className="max-w-xs text-[32px] font-semibold leading-[1.12] tracking-[-0.055em]">
          Your workspace,
          <br />
          wherever you are.
        </h1>
        <p className="mt-4 max-w-sm text-sm leading-relaxed text-fg-muted">
          Ari runs on your computer. Take the conversation, the changes, and the controls with you.
        </p>
      </div>
      {loading && (
        <p role="status" className="py-5 text-sm text-fg-muted">
          Checking your account…
        </p>
      )}
      {!loading && account === null && (
        <>
          <a
            href={`/auth/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`}
            className="primary-button w-full"
          >
            Sign in to Ari Connect
            <ArrowRight size={17} />
          </a>
          <p className="mt-3 text-xs leading-relaxed text-fg-subtle">
            Access is by invitation. Sign in with the exact email approved for your Ari account.
          </p>
        </>
      )}
      {!loading && account !== null && (
        <>
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="truncate text-xs text-fg-subtle">{account.email}</p>
            <button
              type="button"
              aria-label="Refresh computers"
              className="icon-button"
              onClick={() => setRevision((value) => value + 1)}
            >
              <RefreshCw size={16} />
            </button>
          </div>
          {computers.length === 0 && (
            <EmptyState
              title="Connect your first computer"
              detail="Open Ari on your computer, go to Settings → Mobile access, and choose Ari Connect. Approve the computer using this account."
            />
          )}
          <ul className="divide-y divide-border">
            {[...computers]
              .sort(
                (a, b) => Number(b.computerId === requested) - Number(a.computerId === requested),
              )
              .map((computer) => (
                <li key={computer.computerId}>
                  <button
                    type="button"
                    className="flex min-h-24 w-full items-center gap-3 py-3 text-left disabled:opacity-50"
                    disabled={
                      computer.hostname === null || !['ready', 'offline'].includes(computer.state)
                    }
                    onClick={() => choose(computer)}
                  >
                    <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-border bg-surface-1">
                      <Laptop size={21} className="text-fg-muted" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-medium">
                        {computer.name}
                      </span>
                      <span className="mt-1 flex items-center gap-1.5 text-xs text-fg-subtle">
                        <span
                          className={`size-1.5 rounded-full ${computer.state === 'ready' ? 'bg-success' : 'bg-warning'}`}
                        />
                        {computer.state === 'ready'
                          ? 'Ready to connect'
                          : computer.state === 'offline'
                            ? 'Offline · try connecting'
                            : 'Finishing setup'}
                        {computer.computerId === requested && ' · Pairing link'}
                      </span>
                    </span>
                    <ArrowRight size={16} className="text-fg-subtle" />
                  </button>
                </li>
              ))}
          </ul>
          <button
            type="button"
            className="mt-5 flex min-h-11 items-center gap-2 text-xs text-fg-muted"
            onClick={() => void logout()}
          >
            <LogOut size={14} />
            Sign out
          </button>
        </>
      )}
      {failure !== null && (
        <p role="alert" className="error-banner">
          {failure}
        </p>
      )}
      <div className="mt-auto flex items-start gap-2 border-t border-border pt-5 text-[11px] leading-relaxed text-fg-subtle">
        <ShieldCheck size={16} className="shrink-0" />
        <p>
          Every phone needs approval on your computer. Your account alone never grants access to a
          project.
        </p>
      </div>
    </div>
  )
}

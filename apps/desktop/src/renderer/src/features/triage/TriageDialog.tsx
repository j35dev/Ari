import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowRight,
  ArrowUpRight,
  Bug,
  Check,
  ChevronRight,
  FileText,
  GitPullRequest,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  X,
} from 'lucide-react'
import { Dialog } from '@ari/ui/dialog'
import type { ProjectAgent } from '@ari/contracts/project'
import {
  TRIAGE_REPOSITORY,
  type TriageCase,
  type TriageDraft,
  type TriageMatch,
  type TriageSnapshot,
} from '@ari/contracts/triage'
import { rpc } from '../../lib/rpc'
import { ModelSelector } from '../composer/ModelSelector'
import { EffortSelect } from './EffortSelect'
import { SessionView } from '../session/SessionView'
import './triage.css'

type Tab = 'investigate' | 'issue' | 'fix'
export interface TriageWorkspaceProps {
  defaults: ProjectAgent
  initialDescription?: string
  onClose: () => void
  onOpenSession: (id: string) => void
  /** Preview and component tests can supply a conversation surface. The app uses SessionView. */
  renderConversation?: (id: string, agent: ProjectAgent) => ReactNode
}

export function TriageDialog({
  open,
  onOpenChange,
  ...props
}: Omit<TriageWorkspaceProps, 'onClose'> & {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Dialog.Content
        size="lg"
        aria-label="Ari Triage"
        aria-labelledby={undefined}
        aria-describedby={undefined}
        className="triage-dialog"
      >
        {open ? <TriageWorkspace {...props} onClose={() => onOpenChange(false)} /> : null}
      </Dialog.Content>
    </Dialog>
  )
}

export function TriageWorkspace({
  defaults,
  initialDescription = '',
  onClose,
  onOpenSession,
  renderConversation,
}: TriageWorkspaceProps) {
  const [cases, setCases] = useState<TriageCase[]>([])
  const [snapshot, setSnapshot] = useState<TriageSnapshot | null>(null)
  const [description, setDescription] = useState(initialDescription)
  const [agent, setAgent] = useState(defaults)
  const [includeLogs, setIncludeLogs] = useState(true)
  const [tab, setTab] = useState<Tab>('investigate')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<TriageDraft>({ title: '', body: '' })
  const [dirty, setDirty] = useState(false)
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<TriageMatch[] | null>(null)
  const [review, setReview] = useState<Awaited<ReturnType<typeof readDiff>> | null>(null)
  const [identity, setIdentity] = useState<{ account: string | null; error: string | null }>({
    account: null,
    error: null,
  })
  const selected = useRef<string | null>(null)
  const currentDraft = useRef(draft)
  currentDraft.current = draft
  const item = snapshot?.case
  const context = snapshot?.context
  useEffect(() => {
    if (!item || tab === 'investigate') return
    let alive = true
    rpc
      .invoke('triage.account')
      .then((next) => {
        if (alive) setIdentity(next)
      })
      .catch((e) => {
        if (alive) setIdentity({ account: null, error: message(e) })
      })
    return () => {
      alive = false
    }
  }, [item?.id, tab])

  useEffect(() => {
    let alive = true
    rpc
      .invoke('triage.list')
      .then((items) => {
        if (alive) setCases(items)
      })
      .catch((e) => {
        if (alive) setError(message(e))
      })
    return () => {
      alive = false
    }
  }, [])
  function update(next: TriageCase): void {
    if (selected.current !== next.id) return
    setSnapshot((previous) => (previous ? { ...previous, case: next } : previous))
    setCases((previous) => [next, ...previous.filter((p) => p.id !== next.id)])
  }
  async function run(label: string, action: () => Promise<void>): Promise<void> {
    setBusy(label)
    setError(null)
    try {
      await action()
    } catch (e) {
      setError(message(e))
      const id = selected.current
      if (id) {
        try {
          const fresh = await rpc.invoke('triage.get', { id })
          update(fresh.case)
        } catch {
          /* preserve the original action error */
        }
      }
    } finally {
      setBusy(null)
    }
  }
  function choose(next: TriageSnapshot): void {
    selected.current = next.case.id
    setSnapshot(next)
    setDescription(next.case.description)
    setAgent(next.case.agent ?? defaults)
    setIncludeLogs(next.case.includeLogs ?? true)
    setDraft(next.case.issueDraft)
    setDirty(false)
    setTab('investigate')
    setMatches(null)
    setReview(null)
    setQuery(next.case.description.split('\n')[0]!.slice(0, 180))
    setCases((previous) => [next.case, ...previous.filter((p) => p.id !== next.case.id)])
  }
  function changeTab(next: Tab): void {
    if (dirty && item && tab !== 'investigate') {
      const id = item.id
      void rpc
        .invoke('triage.saveDraft', { id, kind: tab === 'fix' ? 'pr' : 'issue', draft })
        .then(update)
        .catch((e) => setError(message(e)))
    }
    setTab(next)
    setDirty(false)
    if (item) setDraft(next === 'fix' ? item.prDraft : item.issueDraft)
    setAgent(
      next === 'fix' ? (item?.fixAgent ?? item?.agent ?? defaults) : (item?.agent ?? defaults),
    )
    setError(null)
  }
  // Drafts survive closing or switching cases. Responses from an older edit never replace newer text.
  useEffect(() => {
    if (!dirty || !item || tab === 'investigate') return
    const id = item.id,
      savedDraft = draft,
      kind = tab === 'fix' ? 'pr' : 'issue'
    const timer = window.setTimeout(() => {
      rpc
        .invoke('triage.saveDraft', { id, kind, draft: savedDraft })
        .then((next) => {
          if (selected.current !== id || currentDraft.current !== savedDraft) return
          update(next)
          setDraft(kind === 'pr' ? next.prDraft : next.issueDraft)
          setDirty(false)
        })
        .catch((e) => {
          if (selected.current === id) setError(message(e))
        })
    }, 350)
    return () => window.clearTimeout(timer)
  }, [draft, dirty, item?.id, tab])

  async function begin(mode: 'investigate' | 'fix'): Promise<void> {
    if (!item) return
    const next = await rpc.invoke('triage.start', { id: item.id, mode, agent, includeLogs })
    if (selected.current !== item.id) return
    setSnapshot(next)
    update(next.case)
    if (mode === 'fix') {
      setTab('fix')
      setDraft(next.case.prDraft)
    }
  }
  async function loadDraft(): Promise<void> {
    if (!item) return
    const kind = tab === 'fix' ? 'pr' : 'issue'
    const next = await rpc.invoke('triage.refreshDraft', { id: item.id, kind })
    update(next)
    setDraft(kind === 'pr' ? next.prDraft : next.issueDraft)
    setDirty(false)
  }
  const chatId = tab === 'fix' ? item?.fixSessionId : item?.investigationSessionId
  const conversation = (id: string) =>
    renderConversation ? (
      renderConversation(id, agent)
    ) : (
      <SessionView
        sessionId={id}
        defaults={agent}
        onDefaultsChange={setAgent}
        onOpenSession={onOpenSession}
      />
    )
  const actionDisabled = busy !== null
  const retryAgent = (mode: 'investigate' | 'fix') => (
    <details className="triage-retry-agent">
      <summary>Try another agent</summary>
      <div>
        <ModelSelector
          driverKind={agent.driverKind}
          modelId={agent.modelId}
          disabled={actionDisabled}
          onChange={(pick) => setAgent((previous) => ({ ...previous, ...pick, effort: null }))}
        />
        <button
          className="triage-secondary"
          disabled={actionDisabled}
          onClick={() => {
            void run('Starting another agent', () => begin(mode))
          }}
        >
          Start with selected agent
        </button>
      </div>
    </details>
  )
  const pendingDraft = useRef<{ id: string; kind: 'issue' | 'pr'; draft: TriageDraft } | null>(null)
  pendingDraft.current =
    dirty && item && tab !== 'investigate'
      ? { id: item.id, kind: tab === 'fix' ? 'pr' : 'issue', draft }
      : null
  useEffect(
    () => () => {
      const pending = pendingDraft.current
      if (pending?.draft.title.trim())
        void rpc.invoke('triage.saveDraft', pending).catch(() => undefined)
    },
    [],
  )

  return (
    <div className="triage-workspace">
      <aside className="triage-sidebar">
        <div className="triage-brand">
          <Bug size={19} />
          <span>Ari Triage</span>
        </div>
        <button
          className="triage-new"
          disabled={actionDisabled}
          onClick={() => {
            const pending = pendingDraft.current
            if (pending?.draft.title.trim())
              void rpc.invoke('triage.saveDraft', pending).catch((e) => setError(message(e)))
            selected.current = null
            setSnapshot(null)
            setDescription('')
            setTab('investigate')
            setMatches(null)
            setError(null)
            setReview(null)
          }}
        >
          <Plus size={15} /> New investigation
        </button>
        <div className="triage-kicker">
          RECENT CASES <span>{cases.length}</span>
        </div>
        <div className="triage-case-list">
          {cases.length ? (
            cases.map((c) => (
              <button
                key={c.id}
                disabled={actionDisabled}
                className={`triage-case ${item?.id === c.id ? 'is-selected' : ''}`}
                onClick={() => {
                  void run('Opening case', async () => {
                    const pending = pendingDraft.current
                    if (pending?.draft.title.trim()) await rpc.invoke('triage.saveDraft', pending)
                    choose(await rpc.invoke('triage.get', { id: c.id }))
                  })
                }}
              >
                <span className="triage-case-title">{c.description.split('\n')[0]}</span>
                <span className="triage-case-meta">
                  {c.pr
                    ? `PR #${c.pr.number}`
                    : c.issue
                      ? `Issue #${c.issue.number}`
                      : c.fixSessionId
                        ? 'Fix in progress'
                        : c.investigationSessionId
                          ? 'Investigation'
                          : 'Ready to investigate'}
                  <span>
                    {new Date(c.updatedAt).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </span>
                </span>
              </button>
            ))
          ) : (
            <p className="triage-empty-cases">
              Your investigations will stay here, ready to pick up again.
            </p>
          )}
        </div>
        <div className="triage-sidebar-footer">
          <ShieldCheck size={15} />
          <span>
            Uses your own agent.
            <br />
            You review what gets shared.
          </span>
        </div>
      </aside>
      <main className="triage-main">
        <header className="triage-topbar">
          <span>
            Support <ChevronRight size={13} /> <span>Ari</span>
          </span>
          <div>
            <span className="triage-machine">{context?.machine ?? 'This machine'}</span>
            <button className="triage-icon" aria-label="Close triage" onClick={onClose}>
              <X size={17} />
            </button>
          </div>
        </header>
        {error ? (
          <div className="triage-error" role="alert">
            {error}
            <button aria-label="Dismiss triage error" onClick={() => setError(null)}>
              <X size={14} />
            </button>
          </div>
        ) : null}
        {!item ? (
          <div className="triage-intro">
            <div className="triage-eyebrow">
              <span /> ARI SUPPORT
            </div>
            <h1>
              Let’s find out
              <br />
              what went wrong.
            </h1>
            <p className="triage-lead">
              Describe the issue. Your agent can investigate it,
              <br className="triage-desktop-break" /> help write a bug report, or prepare a fix.
            </p>
            <label className="triage-label" htmlFor="triage-description">
              What happened?
            </label>
            <textarea
              id="triage-description"
              className="triage-description"
              maxLength={16_000}
              placeholder="For example: Ari stops responding when I switch back to a running session…"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            <div className="triage-intro-actions">
              <button
                className="triage-primary"
                disabled={!description.trim() || actionDisabled}
                onClick={() => {
                  void run('Preparing context', async () =>
                    choose(await rpc.invoke('triage.prepare', { description })),
                  )
                }}
              >
                {busy ? (
                  <LoaderCircle size={15} className="triage-spin" />
                ) : (
                  <ArrowRight size={15} />
                )}{' '}
                Prepare investigation
              </button>
              <span>A few details are enough to start.</span>
            </div>
            <div className="triage-intro-foot">
              <div>
                <Search size={17} />
                <span>
                  <strong>Find the cause</strong>Check relevant diagnostics and Ari source.
                </span>
              </div>
              <div>
                <FileText size={17} />
                <span>
                  <strong>Report or resolve</strong>Review an issue or a fix before publishing.
                </span>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="triage-case-heading">
              <div>
                <div className="triage-eyebrow">
                  ARI TRIAGE <span className="triage-version">v{context?.appVersion}</span>
                </div>
                <h2>{item.description.split('\n')[0]}</h2>
              </div>
              <button
                className="triage-text"
                onClick={() => {
                  const blob = new Blob(
                    [
                      JSON.stringify(
                        snapshot
                          ? {
                              ...snapshot,
                              context: {
                                ...snapshot.context,
                                logs: includeLogs ? snapshot.context.logs : '',
                              },
                            }
                          : null,
                        null,
                        2,
                      ),
                    ],
                    {
                      type: 'application/json',
                    },
                  )
                  const url = URL.createObjectURL(blob)
                  const anchor = document.createElement('a')
                  anchor.href = url
                  anchor.download = 'ari-triage.json'
                  anchor.click()
                  URL.revokeObjectURL(url)
                }}
              >
                Export case <ArrowUpRight size={13} />
              </button>
            </div>
            <nav className="triage-tabs" aria-label="Triage stages">
              {(
                [
                  { id: 'investigate', label: 'Investigate', icon: Search },
                  { id: 'issue', label: 'Issue draft', icon: FileText },
                  { id: 'fix', label: 'Fix & PR', icon: GitPullRequest },
                ] as const
              ).map((t) => (
                <button
                  key={t.id}
                  disabled={actionDisabled}
                  className={tab === t.id ? 'is-active' : ''}
                  aria-current={tab === t.id ? 'page' : undefined}
                  onClick={() => changeTab(t.id)}
                >
                  <t.icon size={15} />
                  {t.label}
                </button>
              ))}
            </nav>
            {tab === 'investigate' ? (
              chatId ? (
                <div className="triage-conversation">
                  {item.sourceError ? (
                    <div className="triage-notice">Source unavailable: {item.sourceError}</div>
                  ) : item.source?.match === 'approximate' ? (
                    <div className="triage-notice">
                      Source is from current main. Your installed build could not be matched
                      exactly.
                    </div>
                  ) : null}
                  {conversation(chatId)}
                  {retryAgent('investigate')}
                </div>
              ) : (
                <div className="triage-setup">
                  <div className="triage-setup-copy">
                    <h3>Ready for your agent.</h3>
                    <p>
                      Review the context below, choose an agent, and start. Ari prepares its source
                      in a separate workspace.
                    </p>
                  </div>
                  <div className="triage-facts">
                    <div>
                      <span>Ari version</span>
                      <strong>{context?.appVersion}</strong>
                    </div>
                    <div>
                      <span>Operating system</span>
                      <strong>
                        {context?.platform} · {context?.arch}
                      </strong>
                    </div>
                    <div>
                      <span>Agent diagnostics</span>
                      <strong>{context?.providers.length ?? 0} providers</strong>
                    </div>
                  </div>
                  <label className="triage-log-toggle">
                    <input
                      type="checkbox"
                      checked={includeLogs}
                      onChange={(e) => setIncludeLogs(e.target.checked)}
                    />
                    <span>
                      Include recent diagnostic messages
                      <small>
                        Warning and error messages only. Credentials and home paths are removed.
                      </small>
                    </span>
                  </label>
                  {includeLogs ? (
                    <details className="triage-log-preview">
                      <summary>Preview diagnostic messages</summary>
                      <pre>
                        {context?.logs || 'No recent warning or error messages were recorded.'}
                      </pre>
                    </details>
                  ) : null}
                  <div className="triage-privacy">
                    <ShieldCheck size={15} />
                    <p>
                      Project files, prompts, credentials, and terminal transcripts are excluded.
                      Your selected provider receives this approved context.
                    </p>
                  </div>
                  <div className="triage-agent-row">
                    <ModelSelector
                      driverKind={agent.driverKind}
                      modelId={agent.modelId}
                      disabled={actionDisabled}
                      onChange={(pick) =>
                        setAgent((previous) => ({ ...previous, ...pick, effort: null }))
                      }
                    />
                    <select
                      aria-label="Triage permissions"
                      value={agent.permissionMode}
                      onChange={(e) =>
                        setAgent((previous) => ({
                          ...previous,
                          permissionMode: e.target.value as ProjectAgent['permissionMode'],
                        }))
                      }
                    >
                      <option value="ask">Ask before changes</option>
                      <option value="allow-edits">Allow edits</option>
                      <option value="full">Full access</option>
                    </select>
                    <EffortSelect
                      agent={agent}
                      onChange={(effort) => setAgent((previous) => ({ ...previous, effort }))}
                      disabled={actionDisabled}
                    />
                    <button
                      className="triage-primary"
                      disabled={actionDisabled}
                      onClick={() => {
                        void run('Preparing source and starting agent', () => begin('investigate'))
                      }}
                    >
                      {busy ? (
                        <LoaderCircle size={15} className="triage-spin" />
                      ) : (
                        <ArrowRight size={15} />
                      )}
                      {busy ?? 'Start investigation'}
                    </button>
                  </div>
                </div>
              )
            ) : tab === 'fix' && !item.fixSessionId ? (
              <div className="triage-fix-intro">
                <div className="triage-fix-icon">
                  <GitPullRequest size={28} />
                </div>
                <h3>Turn the finding into a fix.</h3>
                <p>
                  Your agent works in a clean Ari checkout. It reproduces the issue, makes a focused
                  change, and adds regression coverage.
                </p>
                <div className="triage-fix-steps">
                  <span>
                    <Check size={14} /> Separate source checkout
                  </span>
                  <span>
                    <Check size={14} /> Verification before publishing
                  </span>
                  <span>
                    <Check size={14} /> Your GitHub account and fork
                  </span>
                </div>
                <ModelSelector
                  driverKind={agent.driverKind}
                  modelId={agent.modelId}
                  onChange={(pick) =>
                    setAgent((previous) => ({ ...previous, ...pick, effort: null }))
                  }
                />
                <button
                  className="triage-primary"
                  disabled={actionDisabled}
                  onClick={() => {
                    void run('Preparing fix checkout', () => begin('fix'))
                  }}
                >
                  {busy ? (
                    <LoaderCircle size={15} className="triage-spin" />
                  ) : (
                    <ArrowRight size={15} />
                  )}
                  {busy ?? 'Start fix session'}
                </button>
                <p className="triage-small">
                  A PR proposes a source change. Installing a fixed Ari build is a separate step.
                </p>
              </div>
            ) : (
              <div
                className={`triage-draft-layout${tab === 'fix' && chatId ? ' triage-with-fix' : ''}`}
              >
                {tab === 'fix' && chatId ? (
                  <div className="triage-fix-chat">
                    {conversation(chatId)}
                    {retryAgent('fix')}
                    <button className="triage-text" onClick={() => onOpenSession(chatId)}>
                      Open full session <ArrowUpRight size={13} />
                    </button>
                  </div>
                ) : null}
                <div className="triage-draft-panel">
                  <div className="triage-draft-toolbar">
                    <span>{tab === 'fix' ? 'PULL REQUEST DRAFT' : 'GITHUB ISSUE DRAFT'}</span>
                    <button
                      className="triage-text"
                      disabled={actionDisabled}
                      onClick={() => {
                        void run('Loading agent draft', loadDraft)
                      }}
                    >
                      <RefreshCw size={13} /> Load agent draft
                    </button>
                  </div>
                  <label className="triage-label" htmlFor="triage-draft-title">
                    Title
                  </label>
                  <input
                    id="triage-draft-title"
                    className="triage-draft-title"
                    maxLength={240}
                    value={draft.title}
                    onChange={(e) => {
                      setDraft((previous) => ({ ...previous, title: e.target.value }))
                      setDirty(true)
                    }}
                  />
                  <label className="triage-label" htmlFor="triage-draft-body">
                    Description <span>Markdown</span>
                  </label>
                  <textarea
                    id="triage-draft-body"
                    className="triage-draft-body"
                    maxLength={60_000}
                    value={draft.body}
                    onChange={(e) => {
                      setDraft((previous) => ({ ...previous, body: e.target.value }))
                      setDirty(true)
                    }}
                  />
                  <div className="triage-save-state">
                    {dirty ? 'Saving draft…' : 'Draft saved locally'}
                    <span>Review what will be public.</span>
                  </div>
                  {tab === 'issue' ? (
                    <div className="triage-known">
                      <div className="triage-search-row">
                        <input
                          aria-label="Search known Ari issues"
                          value={query}
                          onChange={(e) => setQuery(e.target.value)}
                          placeholder="Search existing issues and PRs"
                          maxLength={300}
                        />
                        <button
                          className="triage-icon"
                          aria-label="Search GitHub"
                          disabled={!query.trim() || actionDisabled}
                          onClick={() => {
                            void run('Searching known issues', async () =>
                              setMatches(await rpc.invoke('triage.search', { id: item.id, query })),
                            )
                          }}
                        >
                          <Search size={15} />
                        </button>
                      </div>
                      {matches !== null ? (
                        matches.length ? (
                          <ul>
                            {matches.map((m) => (
                              <li key={m.url}>
                                <a href={m.url} target="_blank" rel="noreferrer">
                                  <span>
                                    {m.kind === 'pr' ? 'PR' : 'Issue'} #{m.number} · {m.state}
                                  </span>
                                  {m.title}
                                  <ArrowUpRight size={12} />
                                </a>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p>No matches found for this search.</p>
                        )
                      ) : (
                        <p>Check for an existing report before creating a new one.</p>
                      )}
                    </div>
                  ) : (
                    <div className="triage-review">
                      <div className="triage-review-actions">
                        <button
                          className="triage-secondary"
                          disabled={actionDisabled}
                          onClick={() => {
                            void run('Reviewing changes', async () =>
                              setReview(await readDiff(item.id)),
                            )
                          }}
                        >
                          Review diff
                        </button>
                        <button
                          className="triage-secondary"
                          disabled={actionDisabled}
                          onClick={() => {
                            void run('Running pnpm verify', async () => {
                              update(await rpc.invoke('triage.verify', { id: item.id }))
                              setReview(await readDiff(item.id))
                            })
                          }}
                        >
                          {busy === 'Running pnpm verify' ? (
                            <LoaderCircle size={13} className="triage-spin" />
                          ) : (
                            <ShieldCheck size={13} />
                          )}{' '}
                          Run verification
                        </button>
                      </div>
                      {item.verification ? (
                        <details>
                          <summary className={item.verification.passed ? 'triage-passed' : ''}>
                            {item.verification.passed
                              ? 'Verification passed'
                              : 'Verification needs attention'}
                          </summary>
                          <pre>{item.verification.output}</pre>
                        </details>
                      ) : (
                        <p>Wait for the agent to finish, then verify and review the changes.</p>
                      )}
                      {review ? (
                        <details open>
                          <summary>
                            {review.branch} ·{' '}
                            {review.verificationCurrent
                              ? 'verified changes'
                              : 'verification required'}
                          </summary>
                          <pre className="triage-diff">{review.diff || 'No changes yet.'}</pre>
                        </details>
                      ) : null}
                    </div>
                  )}
                  {identity.error ? (
                    <p className="triage-small">{identity.error}</p>
                  ) : (
                    <p className="triage-small">
                      {identity.account
                        ? `Publishing as ${identity.account}${tab === 'fix' && identity.account !== 'j35dev' ? ` · fork ${identity.account}/Ari → ${TRIAGE_REPOSITORY}` : ''}`
                        : 'Checking GitHub account…'}
                    </p>
                  )}
                  {(tab === 'fix' ? item.prReceipt?.pending : item.issueReceipt?.pending) ? (
                    <button
                      className="triage-secondary"
                      disabled={actionDisabled}
                      onClick={() => {
                        void run('Checking publication', async () => {
                          const next = await rpc.invoke('triage.recover', { id: item.id })
                          update(next)
                          if (tab === 'fix' ? next.prReceipt?.pending : next.issueReceipt?.pending)
                            throw new Error(
                              'No completed publication was found yet. Your draft and branch are preserved; retry after the connection recovers.',
                            )
                        })
                      }}
                    >
                      Check publication
                    </button>
                  ) : null}
                  <div className="triage-publish">
                    <span>
                      <GitPullRequest size={14} /> {TRIAGE_REPOSITORY}
                    </span>
                    {(tab === 'fix' ? item.pr : item.issue) ? (
                      <a
                        className="triage-primary"
                        href={(tab === 'fix' ? item.pr : item.issue)!.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open {tab === 'fix' ? 'PR' : 'issue'} #
                        {(tab === 'fix' ? item.pr : item.issue)!.number}
                        <ArrowUpRight size={14} />
                      </a>
                    ) : (
                      <button
                        className="triage-primary"
                        disabled={
                          actionDisabled ||
                          !identity.account ||
                          !draft.title.trim() ||
                          (tab === 'fix' && (!review?.verificationCurrent || !review.diff))
                        }
                        onClick={() => {
                          void run(tab === 'fix' ? 'Publishing PR' : 'Publishing issue', async () =>
                            update(
                              tab === 'fix'
                                ? await rpc.invoke('triage.publishPr', {
                                    id: item.id,
                                    draft,
                                    revision: review?.revision,
                                    account: identity.account,
                                  })
                                : await rpc.invoke('triage.publishIssue', {
                                    id: item.id,
                                    draft,
                                    account: identity.account,
                                  }),
                            ),
                          )
                        }}
                      >
                        {busy?.startsWith('Publishing') ? (
                          <LoaderCircle size={14} className="triage-spin" />
                        ) : (
                          <ArrowUpRight size={14} />
                        )}{' '}
                        {tab === 'fix' ? 'Publish draft PR' : 'Create GitHub issue'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  )
}

function message(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'Triage could not complete this action. Your case has been preserved.'
}
function readDiff(id: string) {
  return rpc.invoke('triage.diff', { id })
}

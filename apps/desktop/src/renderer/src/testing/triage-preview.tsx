import { createRoot } from 'react-dom/client'
import { ThemeProvider } from '@ari/ui/theme-provider'
import { ToastProvider } from '@ari/ui/toast'
import '@ari/ui/fonts'
import '../styles/index.css'
import type { TriageCase, TriageSnapshot } from '@ari/contracts/triage'

// Standalone visual fixture. Production uses the typed Electron host; this page never makes external writes.
let current: TriageCase | null = null
const agent = {
  driverKind: 'codex' as const,
  modelId: 'gpt-6.2',
  effort: 'high',
  permissionMode: 'ask' as const,
}
const cases: TriageCase[] = []
function snapshot(): TriageSnapshot {
  if (!current) throw new Error('Prepare a preview case first.')
  return {
    case: current,
    context: {
      version: 1,
      appVersion: '0.3.22',
      buildCommit: null,
      profile: 'Ari',
      machine: 'Preview PC',
      platform: 'win32',
      arch: 'x64',
      osRelease: '11',
      nodeVersion: '22.13',
      electronVersion: '43',
      collectedAt: Date.now(),
      providers: [
        { kind: 'codex', version: 'preview', status: 'ready' },
        { kind: 'claude', version: 'preview', status: 'ready' },
      ],
      logs: '[Example diagnostic] The session pane did not respond after switching sessions.',
      exclusions: ['Credentials', 'Prompts', 'Project files'],
    },
  }
}
window.ari = {
  subscribe: () => () => undefined,
  invoke: async (method, raw) => {
    await new Promise<void>((resolve) =>
      window.setTimeout(resolve, method === 'triage.start' ? 450 : 50),
    )
    const params = (raw ?? {}) as Record<string, unknown>
    if (method === 'triage.list') return cases
    if (method === 'triage.prepare') {
      current = {
        version: 1,
        id: `triage_${Math.floor(Math.random() * 999999)
          .toString(16)
          .padStart(32, '0')}`,
        description: String(params.description),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        phase: 'ready',
        projectId: null,
        fixProjectId: null,
        investigationSessionId: null,
        fixSessionId: null,
        agent: null,
        fixAgent: null,
        includeLogs: null,
        source: null,
        sourceError: null,
        fixBase: null,
        fixBranch: null,
        issueDraft: {
          title: String(params.description).split('\n')[0]!.slice(0, 200),
          body: '## What happened\n\nThe session pane stopped responding after switching sessions.\n\n## Steps to reproduce\n\n1. Start an agent session.\n2. Switch to another session.\n3. Return to the first session.\n\n## Expected\n\nThe session remains responsive.\n\n## Actual\n\nThe pane stops responding.\n\n## Environment\n\n- Ari 0.3.22\n- Windows 11 x64\n\n_Example draft for this UI preview._',
        },
        prDraft: {
          title: 'fix: preserve session responsiveness',
          body: 'An example PR draft. The actual agent supplies its findings and verification results here.',
        },
        issue: null,
        pr: null,
        issueReceipt: null,
        prReceipt: null,
        verification: null,
      }
      cases.unshift(current)
      return snapshot()
    }
    if (method === 'triage.get') {
      current = cases.find((c) => c.id === params.id) ?? null
      return snapshot()
    }
    if (method === 'triage.account') return { account: 'preview-user', error: null }
    if (method === 'triage.start') {
      if (!current) throw new Error('No case selected')
      current =
        params.mode === 'fix'
          ? {
              ...current,
              fixSessionId: 'preview-fix',
              fixAgent: agent,
              fixBase: 'a'.repeat(40),
              fixBranch: 'ari-triage/preview',
              phase: 'fixing',
            }
          : {
              ...current,
              investigationSessionId: 'preview-investigation',
              agent,
              source: { revision: 'a'.repeat(40), match: 'approximate' },
              includeLogs: Boolean(params.includeLogs),
              phase: 'investigating',
            }
      return snapshot()
    }
    if (method === 'triage.saveDraft') {
      if (current)
        current = { ...current, [params.kind === 'pr' ? 'prDraft' : 'issueDraft']: params.draft }
      return current
    }
    if (method === 'triage.refreshDraft') return current
    if (method === 'triage.search') return []
    if (method === 'triage.diff')
      return {
        diff: '// Example preview only.\n- previous session state\n+ preserved session state',
        branch: 'ari-triage/preview',
        revision: 'a'.repeat(40),
        verificationCurrent: false,
      }
    if (method === 'triage.verify') {
      if (current)
        current = {
          ...current,
          verification: {
            revision: 'a'.repeat(40),
            at: Date.now(),
            passed: false,
            output:
              'This is a UI preview. No tests were executed. Verification runs against the actual checkout in the desktop app.',
          },
        }
      return current
    }
    if (method === 'triage.publishIssue' || method === 'triage.publishPr')
      throw new Error('Preview only. Nothing was created on GitHub.')
    if (method === 'providers.detect')
      return [
        {
          kind: 'codex',
          binaryPath: '/preview/codex',
          installed: true,
          enabled: true,
          authStatus: 'authenticated',
        },
      ]
    if (method === 'providers.models')
      return [
        {
          kind: 'codex',
          source: 'live',
          defaultModelId: 'gpt-6.2',
          models: [{ id: 'gpt-6.2', label: 'GPT-6.2', contextWindow: 400000 }],
        },
      ]
    if (method === 'providers.efforts')
      return {
        efforts: [
          { id: 'low', label: 'Low' },
          { id: 'medium', label: 'Medium' },
          { id: 'high', label: 'High' },
        ],
      }
    if (method === 'endpoints.list') return []
    return null
  },
}

const { TriageWorkspace } = await import('../features/triage/TriageDialog')
function ExampleConversation({ fix }: { fix: boolean }) {
  return (
    <div style={{ padding: '36px 35px', flex: 1, overflow: 'auto', fontSize: 13, lineHeight: 1.9 }}>
      <div
        style={{
          fontSize: 10,
          letterSpacing: '.1em',
          color: 'var(--ari-fg-subtle)',
          marginBottom: 18,
        }}
      >
        EXAMPLE CONVERSATION
      </div>
      <p style={{ color: 'var(--ari-fg-muted)', marginBottom: 24 }}>
        This fixture demonstrates where your agent’s investigation appears. In Ari, the real session
        streams here with its tool activity, approvals, and composer.
      </p>
      <h3 style={{ fontWeight: 500, marginBottom: 12 }}>
        {fix ? 'Preparing a focused fix' : 'Investigating the session switch'}
      </h3>
      <p>
        {fix
          ? 'The agent reproduces the issue in a separate source checkout and adds a regression test. Use the draft panel to inspect its PR description and run verification.'
          : 'The agent checks the approved diagnostics, maps the error to the affected source, and searches known issues. Findings distinguish confirmed causes from possibilities.'}
      </p>
      <div
        style={{
          borderTop: '1px solid var(--ari-border)',
          marginTop: 28,
          paddingTop: 18,
          color: 'var(--ari-fg-subtle)',
          fontSize: 12,
        }}
      >
        Next: review the {fix ? 'diff and verification' : 'Issue draft'}, or continue the
        conversation with more reproduction details.
      </div>
    </div>
  )
}
createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <ToastProvider>
      <div
        style={{
          height: '100dvh',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--ari-bg)',
          color: 'var(--ari-fg)',
        }}
      >
        <div
          style={{
            height: 42,
            padding: '0 28px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid var(--ari-border)',
            fontSize: 11,
            color: 'var(--ari-fg-subtle)',
          }}
        >
          <span>ARI TRIAGE · INTERACTIVE UI PREVIEW</span>
          <span>Example data · No GitHub writes</span>
        </div>
        <div
          style={{ flex: 1, minHeight: 0, padding: 22, display: 'flex', justifyContent: 'center' }}
        >
          <div
            style={{
              width: 'min(1180px, 100%)',
              border: '1px solid var(--ari-border)',
              borderRadius: 10,
              overflow: 'hidden',
            }}
          >
            <TriageWorkspace
              defaults={agent}
              onClose={() => location.reload()}
              onOpenSession={() => undefined}
              renderConversation={(id) => <ExampleConversation fix={id === 'preview-fix'} />}
            />
          </div>
        </div>
      </div>
    </ToastProvider>
  </ThemeProvider>,
)

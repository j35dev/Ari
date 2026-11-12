import { createRoot } from 'react-dom/client'
import '@ari/ui/fonts'
import { ThemeProvider } from '@ari/ui/theme-provider'
import { HomeScreen } from '../../src/features/home/HomeScreen'
import { SessionScreen } from '../../src/features/session/SessionScreen'
import { SettingsScreen } from '../../src/features/settings/SettingsScreen'
import { PairScreen } from '../../src/features/pair/PairScreen'
import { NewChatScreen } from '../../src/features/new/NewChatScreen'
import { ForkSheet } from '../../src/features/session/ForkSheet'
import { ReviewIntegration } from '../../src/features/session/ReviewIntegration'
import { Terminal } from '../../src/features/session/Terminal'
import { ForkRequestStore } from '../../src/features/session/fork-request'
import { writePending } from '../../src/lib/draft'
import { writeCreation } from '../../src/lib/new-session'
import { writeIntegration } from '../../src/lib/integration-review'
import { writeTerminalState } from '../../src/lib/terminal-state'
import { view, app } from './app-state'
import '../../src/styles/index.css'

const theme =
  new URLSearchParams(location.search).get('theme') === 'light' ? 'porcelain' : 'obsidian'
localStorage.setItem('ari.theme', JSON.stringify({ mode: theme, wallpaper: 'none' }))
document.documentElement.dataset.ariTheme = theme
sessionStorage.setItem(
  `ari.draft:${app.origin}:fixture-phone:review-session`,
  'Keep the draft on Studio while I switch computers.',
)
const noAction = () => {}
if (view === 'session-uncertain')
  writePending(app.origin, 'fixture-phone', 'review-session', {
    key: 'original-prompt-receipt',
    text: 'Run the mobile checks once on Studio.',
    mode: 'queue',
    attachmentIds: [],
  })
if (view === 'new-uncertain')
  writeCreation(app.origin, 'fixture-phone', {
    key: 'original-create-receipt',
    projectId: 'ari',
    driverKind: 'codex',
    modelId: '',
    effort: null,
    permissionMode: null,
    draft: 'Create this task once on Studio.',
  })
if (view === 'fork-uncertain')
  new ForkRequestStore(app.origin, 'fixture-phone', 'review-session').write({
    key: 'original-fork-receipt',
    title: 'Check phone recovery',
    driverKind: 'codex',
  })
if (view === 'integration-uncertain')
  writeIntegration(app.origin, 'fixture-phone', 'review-session', {
    key: 'original-integration-receipt',
    preview: {
      sessionId: 'review-session',
      parentSessionId: 'parent-session',
      snapshotCommit: 'a'.repeat(40),
      expectedParentSnapshot: 'b'.repeat(40),
      files: [
        {
          path: 'apps/mobile/src/lib/command-receipt.ts',
          status: 'modified',
          additions: 28,
          deletions: 0,
          binary: false,
        },
      ],
    },
  })
if (view === 'terminal-uncertain')
  writeTerminalState(app.origin, 'fixture-phone', 'review-session', {
    terminalId: null,
    creationKey: 'original-shell-receipt',
    closed: false,
  })
const content =
  view === 'settings' ? (
    <SettingsScreen onBack={noAction} />
  ) : view === 'new-uncertain' || view === 'new-empty' ? (
    <NewChatScreen onBack={noAction} onOpen={noAction} />
  ) : view === 'fork-uncertain' ? (
    <ForkSheet
      parent={{
        id: 'review-session',
        projectId: 'ari',
        title: 'Mobile recovery',
        driverKind: 'codex',
        modelId: null,
        permissionMode: 'ask',
        status: 'idle',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }}
      onClose={noAction}
      onForked={noAction}
    />
  ) : view === 'integration-uncertain' ? (
    <div className="p-4">
      <ReviewIntegration sessionId="review-session" onChanged={async () => {}} />
    </div>
  ) : view === 'terminal-uncertain' ? (
    <div className="h-full p-4">
      <Terminal sessionId="review-session" active />
    </div>
  ) : view === 'pair' ? (
    <PairScreen invitationId={null} onInvitation={noAction} />
  ) : ['session', 'session-uncertain', 'approval', 'files', 'changes', 'offline'].includes(view) ? (
    <SessionScreen
      sessionId={view === 'approval' ? 'review-approval' : 'review-session'}
      onBack={noAction}
      onForked={noAction}
    />
  ) : (
    <HomeScreen onOpen={noAction} onNewSession={noAction} onSettings={noAction} />
  )
createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <div className="mobile-shell">{content}</div>
  </ThemeProvider>,
)

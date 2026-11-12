import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeProvider } from '@ari/ui/theme-provider'
import { MotionProvider } from '@ari/ui/motion-provider'
import { ToastProvider } from '@ari/ui/toast'
import '@ari/ui/fonts'
import '../src/styles/index.css'
import '../src/features/transcript/transcript.css'
import { desktopMachineFixture, desktopSnapshotFixture, catalogFixture, localSnapshotFixture,
  projectCatalogFixture, resourcesFixture, versionFixture } from '../src/features/machines/fixtures.test-support'
import { MachinesProvider, useMachines } from '../src/features/machines/use-machines'
import { useMachineProjects } from '../src/features/machines/use-machine-projects'
import { ProjectDraftPane } from '../src/features/machines/ProjectDraftPane'
import { SessionView } from '../src/features/session/SessionView'
import { sessionViewKey } from '../src/features/session/session-client'
import { SettingsWorkspace } from '../src/features/settings/SettingsWorkspace'
import { SettingsDialog } from '../src/features/settings/SettingsDialog'
import { SessionsUnderProjects } from '../src/shell/Sidebar'
import { ScopedTitlebar } from '../src/shell/ScopedTitlebar'
import { settingsSchema } from '@ari/contracts/settings'
import { projectViewSchema } from '@ari/contracts/project'
import { remoteCommandEnvelopeSchema } from '@ari/contracts/remote'
import { scopeKey } from '../src/features/machines/remote-client'

const options = new URLSearchParams(location.search)
const view = options.get('view') ?? 'settings'
const themeId = options.get('theme') === 'light' ? 'porcelain' : 'obsidian'
localStorage.clear()
localStorage.setItem('ari.theme', JSON.stringify({ mode: themeId, wallpaper: 'none' }))
const scope = { kind: 'remote' as const, machineId: 'host-a', sessionId: 'sess_remote' }
if (view === 'receipt') {
  const command = remoteCommandEnvelopeSchema.parse({ op: 'session.prompt', sessionId: scope.sessionId,
    text: 'Continue the host task', clientCommandId: 'fixture-command', idempotencyKey: 'fixture-command' })
  localStorage.setItem(`ari.machines.receipt.v1:${scopeKey(scope.machineId, scope.sessionId)}`,
    JSON.stringify({ machineId: scope.machineId, scope: scope.sessionId, command }))
}
let machines = [
  { ...desktopMachineFixture(), name: 'Studio workstation', allowTerminal: true, effectiveRoute: 'https://host-a.example.ts.net' },
  { ...desktopMachineFixture('host-b'), name: 'Build computer' },
  { ...desktopMachineFixture('host-c'), name: 'Travel laptop', status: 'pairing' as const },
]
const snapshot = desktopSnapshotFixture()
snapshot.session.title = 'Resource gate and Machines UI'
snapshot.summary.title = snapshot.session.title
const fixtureTime = Date.UTC(2026, 10, 12, 12, 59)
snapshot.summary.updatedAt = fixtureTime
const diffText = 'diff --git a/scripts/run-heavy.ts b/scripts/run-heavy.ts\n--- a/scripts/run-heavy.ts\n+++ b/scripts/run-heavy.ts\n@@ -1 +1 @@\n-await runBuild()\n+await runHeavy("Build desktop", workspace)\n'
const text = 'The test runner now checks commit headroom before starting a build. The workspace and agent remain on Studio workstation.\n\n```ts\nawait runHeavy("Build desktop", workspace)\n```'
const events = [
  { type: 'user.message.added', seq: 0, at: fixtureTime - 30_000, sessionId: scope.sessionId, message: {
    id: 'user-1', sessionId: scope.sessionId, turnId: 'turn-1', role: 'user', createdAt: fixtureTime - 30_000,
    parts: [{ type: 'text', text: 'Make the desktop workspace work across my computers.' }] } },
  { type: 'turn.started', seq: 1, at: fixtureTime - 29_000, sessionId: scope.sessionId, turnId: 'turn-1' },
  { type: 'assistant.parts.appended', seq: 2, at: fixtureTime - 1000, sessionId: scope.sessionId, messageId: 'assistant-1', parts: [{ type: 'text', text }] },
  { type: 'turn.settled', seq: 3, at: fixtureTime, sessionId: scope.sessionId, turnId: 'turn-1', stopReason: 'completed', errorMessage: null },
]
const trace: string[] = []
const subscribers = new Map<string, Parameters<Window['ari']['subscribe']>[1]>()
const streams = new Map<string, { name: string; params: Record<string, unknown> }>()
const reply = (result: unknown) => ({ ok: true, result })
window.ari = {
  async invoke(method, raw) {
    // Preserve asynchronous IPC delivery while keeping this fixture offline.
    await Promise.resolve()
    trace.push(method)
    const params = raw as Record<string, unknown> | undefined
    if (method === 'machines.list') return machines
    if (method === 'machines.localSnapshot') return localSnapshotFixture()
    if (method === 'machines.preferences') return { autoEnabled: view === 'auto', hostTiers: { 'host-a': 'prefer' }, projectHosts: {} }
    if (method === 'machines.pairStatus') return { machineId: 'host-c', status: 'pairing', confirmationCode: 'K7MV-4AX9', expiresAt: Date.now() + 60_000, error: null }
    if (method === 'settings.get') return settingsSchema.parse({ version: 1 })
    if (method === 'speech.status') return { ready: false }
    if (method === 'stream.unsubscribe') { streams.delete(params!.id as string); return { subscribed: false } }
    if (method === 'stream.subscribe') {
      const id = params!.id as string
      streams.set(id, { name: params!.name as string, params: params!.params as Record<string, unknown> })
      if (params!.name === 'machines.events') setTimeout(() => {
        for (const frame of [
          { kind: 'start', replayMode: 'full', fromSeq: null, throughSeq: 3 },
          { kind: 'chunk', events },
          { kind: 'terminal', replayOutcome: 'complete', seq: 3, liveTurnId: null, reason: null },
        ]) subscribers.get(id)?.({ payload: { machineId: scope.machineId,
          message: { type: 'events.desktop.frame', sessionId: scope.sessionId, frame } } } as never)
      }, 50)
      return { subscribed: true }
    }
    if (method === 'machines.query') {
      const request = raw as { machineId: string; query: { op: string } }
      const op = request.query.op
      if (op === 'project.catalog') return reply(projectCatalogFixture())
      if (op === 'session.list') return reply([{ ...snapshot.summary, title: request.machineId === 'host-b' ? 'Improve the release pipeline' : snapshot.summary.title }])
      if (op === 'models.list') return reply(catalogFixture)
      if (op === 'host.resources') return reply(resourcesFixture())
      if (op === 'host.permissions') return reply({ deviceId: 'fixture-device', projectScope: { kind: 'all' }, allowTerminal: true, managedLeaseExpiresAt: null })
      if (op === 'host.version') return reply(versionFixture)
      if (op === 'session.desktop.get') return reply(snapshot)
      if (op === 'session.resume.get') return reply({ at: null })
      if (op === 'files.index') return reply({ paths: [], nextCursor: null, truncated: false })
      if (op === 'plan.get') return reply({ items: null })
      if (op === 'changes.turn' || op === 'changes.turnFile') return reply({ diffText })
      if (op === 'project.workspaces') return reply({ projectId: 'same-project', truncated: false, options: [
        { token: 'host-main', label: 'Current checkout · main', kind: 'checkout', branch: 'main', workspaceMode: 'shared' },
        { token: 'host-isolated', label: 'New isolated worktree', kind: 'worktree', branch: 'main', workspaceMode: 'isolated' },
      ] })
      if (op === 'command.status') return { ok: false, error: { code: 'not_found', message: 'The original outcome is still unknown.' } }
    }
    throw new Error(`Fixture refused RPC: ${method}`)
  },
  subscribe(id, callback) { subscribers.set(id, callback); return () => { subscribers.delete(id) } },
}
setTimeout(() => {
  machines = machines.map((machine) => machine.id === 'host-b' ? { ...machine, status: 'offline' } : machine)
  for (const [id, stream] of streams) if (stream.name === 'machines.updates')
    subscribers.get(id)?.({ payload: machines } as never)
}, 700)
Object.assign(window, { __ari: { state: () => ({ fixture: 'normal desktop Machines components', view, theme: themeId, trace }) } })

const localProject = projectViewSchema.parse({ id: 'same-project', name: 'Ari', path: 'D:/code/Ari', createdAt: 1, open: true, status: 'ok' })
const localSession = { ...snapshot.summary, id: 'sess_local', title: 'Finish the local scheduler', updatedAt: fixtureTime - 60_000 }
const defaults = { driverKind: 'codex' as const, modelId: 'gpt-6.1-sol', permissionMode: 'ask' as const, effort: 'high' }
function Fixture() {
  const navigation = useMachineProjects([localProject], [localSession])
  const metadata = useMachines()
  const [selection, setSelection] = useState(sessionViewKey(scope))
  const draft = view === 'draft' || view === 'auto' || view === 'picker'
  return <div className="flex h-screen flex-col bg-bg text-fg">
    <ScopedTitlebar scope={draft || view === 'settings' || view === 'permissions' ? null : scope} gitScope={null} minimal
      onReview={() => {}} onRequests={() => {}} />
    {view === 'settings' || view === 'permissions' ? <SettingsWorkspace section="machines" onBack={() => {}} /> :
      <div className="flex min-h-0 flex-1">
        <aside aria-label="Projects and sessions" className="w-72 shrink-0 overflow-auto border-r border-border bg-surface-1 p-3">
          <SessionsUnderProjects projects={navigation.sidebarProjects} sessions={navigation.sessions} activeSessionId={selection}
            hostOf={(id) => navigation.hosts.get(id)} onSelect={setSelection} onRename={() => {}} onDelete={() => {}}
            onTogglePin={() => {}} onToggleArchive={() => {}} />
        </aside>
        <main className="min-w-0 flex-1">
          {draft ? navigation.groups[0] && metadata.localModels && <ProjectDraftPane
            entry={{ id: 'fixture-draft', groupId: navigation.groups[0].id, group: navigation.groups[0], spaceId: 'fixture-space', paneId: 'fixture-pane' }}
            projects={[localProject]} defaults={defaults} createLocal={() => Promise.reject(new Error('Screenshot refuses mutations'))} onCreated={() => {}} onClose={() => {}} /> :
            <SessionView sessionId={scope.sessionId} scope={scope} defaults={defaults} onDefaultsChange={() => {}} />}
        </main>
      </div>}
    {/* Settings as the app shows it: a dialog over the workspace. */}
    {view === 'popup' && <SettingsDialog open onOpenChange={() => {}} section="machines" />}
  </div>
}
createRoot(document.getElementById('root')!).render(<ThemeProvider><MotionProvider reducedMotion><ToastProvider>
  <MachinesProvider><Fixture /></MachinesProvider>
</ToastProvider></MotionProvider></ThemeProvider>)

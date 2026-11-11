import { createRoot } from 'react-dom/client'
import { ThemeProvider } from '@ari/ui/theme-provider'
import { MotionProvider } from '@ari/ui/motion-provider'
import '@ari/ui/fonts'
import '../src/styles/index.css'
import '../src/features/transcript/transcript.css'
import {
  machineFixture,
  snapshotFixture,
  catalogFixture,
} from '../src/features/machines/fixtures.test-support'
import { MachinesProvider } from '../src/features/machines/use-machines'
import { SettingsWorkspace } from '../src/features/settings/SettingsWorkspace'
import { RemoteWorkspace } from '../src/features/machines/RemoteWorkspace'
import { settingsSchema } from '@ari/contracts/settings'

const options = new URLSearchParams(location.search)
const themeId = options.get('theme') === 'light' ? 'porcelain' : 'obsidian'
localStorage.setItem('ari.theme', JSON.stringify({ mode: themeId, wallpaper: 'none' }))
const machines = [
  { ...machineFixture(), name: 'Studio workstation', allowTerminal: true },
  { ...machineFixture('host-b'), name: 'Build computer', status: 'offline' as const, error: null },
  { ...machineFixture('host-c'), name: 'Travel laptop', status: 'pairing' as const },
  {
    ...machineFixture('host-d'),
    name: 'Archive computer',
    status: 'incompatible' as const,
    identity: { ...machineFixture().identity!, protocolVersion: 2 },
  },
]
const snapshot = snapshotFixture(
  'same-session',
  'The test runner now checks commit headroom before starting a build. The host keeps the workspace and provider credentials here.\n\n```ts\nawait runHeavy("Build desktop", workspace)\n```',
)
snapshot.session.title = 'Resource gate and Machines UI'
snapshot.summary.title = snapshot.session.title
snapshot.messages.unshift({
  id: 'user-1',
  sessionId: 'same-session',
  turnId: 'turn-1',
  role: 'user',
  createdAt: 1,
  parts: [{ type: 'text', text: 'Make the desktop workspace work across my computers.' }],
})
const trace: string[] = []
const reply = (result: unknown) => ({ ok: true, result })
window.ari = {
  async invoke(method: string, params?: unknown) {
    trace.push(method)
    if (method === 'machines.list') return machines
    if (method === 'machines.pairStatus')
      return {
        machineId: 'host-c',
        status: 'pairing',
        confirmationCode: 'K7MV-4AX9',
        expiresAt: 1_794_394_800_000,
        error: null,
      }
    if (method === 'stream.subscribe' || method === 'stream.unsubscribe')
      return { subscribed: true }
    if (method === 'settings.get') return settingsSchema.parse({ version: 1 })
    if (method === 'machines.query') {
      const request = params as { machineId: string; query: { op: string } }
      if (request.query.op === 'project.list')
        return reply([
          {
            id: 'same-project',
            name: request.machineId === 'host-a' ? 'Ari desktop' : 'Build infrastructure',
            sessionCount: 2,
          },
        ])
      if (request.query.op === 'session.list')
        return reply([
          snapshot.summary,
          { ...snapshot.summary, id: 'session-2', title: 'Improve the release pipeline' },
        ])
      if (request.query.op === 'session.get') return reply(snapshot)
      if (request.query.op === 'models.list') return reply(catalogFixture)
    }
    throw new Error(`Fixture refused RPC: ${method}`)
  },
  subscribe: () => () => undefined,
}
Object.assign(window, {
  __ari: {
    state: () => ({
      fixture: 'desktop-machines',
      view: options.get('view') ?? 'settings',
      theme: themeId,
      viewport: { width: innerWidth, height: innerHeight },
      trace,
    }),
  },
})
createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <MotionProvider reducedMotion>
      <MachinesProvider>
        <div className="flex h-screen flex-col bg-bg text-fg">
          <header className="flex h-[var(--ari-titlebar-height)] shrink-0 items-center border-b border-border px-5 text-xs font-semibold">
            Ari <span className="ml-3 font-normal text-fg-subtle">Machines fixture</span>
          </header>
          {options.get('view') === 'workspace' ? (
            <RemoteWorkspace
              target={{ machineId: 'host-a', sessionId: 'same-session' }}
              onSelect={() => undefined}
              onBack={() => undefined}
              onManage={() => undefined}
            />
          ) : (
            <SettingsWorkspace
              section="machines"
              onBack={() => undefined}
              onOpenMachine={() => undefined}
            />
          )}
        </div>
      </MachinesProvider>
    </MotionProvider>
  </ThemeProvider>,
)

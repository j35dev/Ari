import { machineViewSchema } from '@ari/contracts/machines'
import { remoteSessionResultSchema } from '@ari/contracts/remote'
import { machinesExtensionOperationSchema, machinesLocalSnapshotSchema, remoteDesktopSessionResultSchema } from '@ari/contracts/remote'

export const machineFixture = (id = 'host-a') =>
  machineViewSchema.parse({
    id,
    name: id === 'host-a' ? 'Studio computer' : 'Build computer',
    routes: [{ kind: 'tailscale', origin: `https://${id}.example.ts.net` }],
    status: 'connected',
    lastSeenAt: 1_790_000_000_000,
    error: null,
    allowTerminal: false,
    identity: {
      machineId: id,
      name: id,
      ariVersion: '0.3.13',
      protocolVersion: 1,
      capabilities: [
        'project.list',
        'session.list',
        'session.get',
        'session.create',
        'models.list',
        'session.prompt',
        'session.queue',
        'session.steer',
        'session.interrupt',
        'approval.respond',
        'input.respond',
        'events.subscribe',
        'command.status',
        'changes.files',
        'changes.diff',
        'files.list',
        'files.read',
        'attachments.stage',
        'attachments.read',
        'terminal.create',
        'terminal.read',
        'terminal.write',
        'terminal.kill',
        'terminal.resize',
        'session.update',
        'session.fork',
        'session.archive',
      ],
    },
  })

export const snapshotFixture = (sessionId = 'same-session', text = 'Hello from the host') =>
  remoteSessionResultSchema.parse({
    session: {
      id: sessionId,
      projectId: 'same-project',
      title: 'Remote task',
      driverKind: 'codex',
      modelId: 'gpt-6.1-sol',
      permissionMode: 'ask',
      status: 'idle',
      createdAt: 1,
      updatedAt: 2,
    },
    summary: {
      id: sessionId,
      projectId: 'same-project',
      title: 'Remote task',
      updatedAt: 2,
      messageCount: 1,
    },
    seq: 12,
    messages: [
      {
        id: 'message-1',
        sessionId,
        turnId: 'turn-1',
        role: 'assistant',
        parts: [{ type: 'text', text }],
        createdAt: 2,
      },
    ],
    pendingApprovals: [],
    pendingInputs: [],
    tasks: [],
    parent: null,
  })

export const catalogFixture = {
  defaults: {
    driverKind: 'codex',
    modelId: 'gpt-6.1-sol',
    permissionMode: 'ask',
    configuredDriverKind: 'codex',
  },
  providers: [
    {
      driverKind: 'codex',
      available: true,
      defaultModelId: 'gpt-6.1-sol',
      models: [
        { id: 'gpt-6.1-sol', label: 'GPT 6.1 Sol', efforts: [{ id: 'high', label: 'High' }] },
      ],
    },
  ],
}

export const desktopMachineFixture = (id = 'host-a') => ({ ...machineFixture(id), versionReady: true, permissionsReady: true,
  identity: { ...machineFixture(id).identity!, machinesExtensions: { version: 1 as const, operations: machinesExtensionOperationSchema.options.slice() } },
})
export const resourcesFixture = () => ({ status: 'available' as const, sampledAt: Date.now(), cpuUtilization: 0.2,
  cpuCount: 8, availableMemoryBytes: 4 * 1024 ** 3, totalMemoryBytes: 16 * 1024 ** 3, reason: null })
export const versionFixture = { ariVersion: '0.3.13', protocolVersion: 1, hostingMode: 'desktop' as const,
  update: { supported: false as const, reason: 'Updates run on the owning host.', availableVersion: null, stagedVersion: null,
    guidance: 'Open Settings > Updates on the host to update Ari.' } }
export const projectCatalogFixture = (id = 'same-project') => ({ projects: [{ id, name: 'Ari', sessionCount: 1,
  status: 'ok' as const, defaultAgent: { driverKind: 'codex' as const, modelId: 'gpt-6.1-sol', permissionMode: 'ask' as const, effort: 'high' },
  repositoryIdentity: { canonicalKey: 'github.com/j35dev/ari', displayName: 'j35dev/Ari', locator: { source: 'git-remote' as const, remoteName: 'origin' } },
}] })
export const localSnapshotFixture = () => machinesLocalSnapshotSchema.parse({ identity: { machineId: 'local-public', name: 'This PC' },
  catalog: projectCatalogFixture(), resources: resourcesFixture(), models: catalogFixture, version: versionFixture })
export const desktopSnapshotFixture = () => {
  const { messages: _messages, ...snapshot } = snapshotFixture('sess_remote')
  return remoteDesktopSessionResultSchema.parse({ ...snapshot, context: { hasMessages: true, hasTurns: true, hasProviderContext: true },
    lastTurn: null, liveTurnId: null, liveCapabilities: { approval: false, question: false, steer: false } })
}

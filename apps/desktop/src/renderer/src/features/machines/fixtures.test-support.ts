import { machineViewSchema } from '@ari/contracts/machines'
import { remoteSessionResultSchema } from '@ari/contracts/remote'

export const machineFixture = (id = 'host-a') => machineViewSchema.parse({
  id, name: id === 'host-a' ? 'Studio computer' : 'Build computer',
  routes: [{ kind: 'tailscale', origin: `https://${id}.example.ts.net` }],
  status: 'connected', lastSeenAt: 1_790_000_000_000, error: null, allowTerminal: false,
  identity: { machineId: id, name: id, ariVersion: '0.3.13', protocolVersion: 1,
    capabilities: ['project.list', 'session.list', 'session.get', 'session.create', 'models.list', 'session.prompt', 'session.queue', 'session.steer', 'session.interrupt', 'approval.respond', 'input.respond', 'events.subscribe', 'command.status', 'changes.files', 'changes.diff', 'files.list', 'files.read', 'attachments.stage', 'attachments.read', 'terminal.create', 'terminal.read', 'terminal.write', 'terminal.kill', 'terminal.resize', 'session.update', 'session.fork', 'session.archive'] },
})

export const snapshotFixture = (sessionId = 'same-session', text = 'Hello from the host') => remoteSessionResultSchema.parse({
  session: { id: sessionId, projectId: 'same-project', title: 'Remote task', driverKind: 'codex', modelId: 'gpt-6.1-sol', permissionMode: 'ask', status: 'idle', createdAt: 1, updatedAt: 2 },
  summary: { id: sessionId, projectId: 'same-project', title: 'Remote task', updatedAt: 2, messageCount: 1 }, seq: 12,
  messages: [{ id: 'message-1', sessionId, turnId: 'turn-1', role: 'assistant', parts: [{ type: 'text', text }], createdAt: 2 }],
  pendingApprovals: [], pendingInputs: [], tasks: [], parent: null,
})

export const catalogFixture = {
  defaults: { driverKind: 'codex', modelId: 'gpt-6.1-sol', permissionMode: 'ask', configuredDriverKind: 'codex' },
  providers: [{ driverKind: 'codex', available: true, defaultModelId: 'gpt-6.1-sol', models: [{ id: 'gpt-6.1-sol', label: 'GPT 6.1 Sol', efforts: [{ id: 'high', label: 'High' }] }] }],
}

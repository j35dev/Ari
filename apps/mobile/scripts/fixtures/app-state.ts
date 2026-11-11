// Capture-only adapter. No production entry imports this module.
const params = new URLSearchParams(location.search)
export const view = params.get('view') ?? 'home'
const now = Date.parse('2026-11-11T09:00:00Z')
Date.now = () => now
const approval = {
  approvalId: 'review-approval', toolName: 'Bash',
  summaryJson: JSON.stringify({ command: 'pnpm --filter @ari/mobile typecheck', description: 'Check the mobile workspace' }),
  options: [
    { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'always', name: 'Always allow this command in this workspace', kind: 'allow_always' },
    { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
  ],
}
const summaries = [
  { id: 'review-approval', projectId: 'ari', title: 'Review mobile access', status: 'waiting-approval', updatedAt: now - 60_000 },
  { id: 'review-session', projectId: 'ari', title: 'Make the phone workspace easier to use', status: 'running', updatedAt: now - 120_000 },
  { id: 'review-docs', projectId: 'docs', title: 'Update the setup guide', status: 'idle', pinned: true, updatedAt: now - 3600_000 },
  { id: 'review-files', projectId: 'ari', title: 'Check reconnect behavior', status: 'idle', updatedAt: now - 7200_000 },
]
const capabilities = ['project.list', 'session.list', 'session.get', 'attention.list', 'session.create', 'session.prompt', 'session.queue', 'session.steer', 'session.interrupt', 'session.update', 'approval.respond', 'input.respond', 'changes.files', 'changes.diff', 'files.list', 'files.read']
export const app = {
  origin: 'https://studio.my-tailnet.ts.net:8443', booted: true,
  connection: view === 'offline' ? 'unreachable' : 'connected',
  capabilities, projects: [{ id: 'ari', name: 'Ari' }, { id: 'docs', name: 'Documentation' }],
  sessions: view === 'empty' ? [] : summaries,
  catalog: { providers: [{ driverKind: 'codex', available: true, models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' }], efforts: [{ id: 'high', label: 'High', current: true }], modes: [] }] },
  error: view === 'error' ? 'The computer could not refresh sessions. Your draft is saved on this phone.' : null,
  refreshing: false, lastSyncedAt: now - 45_000, pairingCode: null, managedComputerId: null,
  computers: [
    { origin: 'https://studio.my-tailnet.ts.net:8443', name: 'Studio', lastConnectedAt: now - 45_000, status: 'connected' },
    { origin: 'https://travel.my-tailnet.ts.net', name: 'Travel laptop', lastConnectedAt: now - 86400_000, status: 'unreachable' },
  ],
  activeComputer: { origin: 'https://studio.my-tailnet.ts.net:8443', name: 'Studio', lastConnectedAt: now - 45_000, status: 'connected' },
  switchComputer: () => {}, addComputer: () => {}, renameComputer: () => {},
  refresh: async () => {}, reconnect: async () => {}, forget: async () => {}, pair: async () => {},
  rememberOrigin: () => {}, chooseComputer: () => {}, changeComputer: () => {},
  session: {
    deviceId: 'fixture-phone', usable: view !== 'offline', allowTerminal: false,
    supports: (op: string) => capabilities.includes(op),
    watch: () => () => {},
    query: async (op: string, args: { sessionId?: string } = {}) => {
      if (op === 'attention.list') return { items: view === 'empty' ? [] : [{ sessionId: 'review-approval', projectId: 'ari', title: 'Review mobile access', status: 'waiting-approval', pendingApprovals: [approval], pendingInputs: [], error: null, updatedAt: now - 60_000 }], nextCursor: null }
      if (op === 'changes.files') return { base: 'session-base', error: null, files: [{ path: 'apps/mobile/src/features/session/SessionScreen.tsx', hunks: [], isNew: false }, { path: 'apps/mobile/src/lib/computers.ts', hunks: [], isNew: true }] }
      if (op === 'files.list') return { path: '', entries: [{ path: 'src', name: 'src', kind: 'directory' }, { path: 'README.md', name: 'README.md', kind: 'file' }, { path: 'package.json', name: 'package.json', kind: 'file' }], error: null, nextCursor: null }
      if (op === 'session.get') {
        const summary = summaries.find((s) => s.id === args.sessionId) ?? summaries[1]
        return { summary, session: { ...summary, driverKind: 'codex', modelId: 'gpt-6.1-sol', effort: 'high', permissionMode: 'ask', createdAt: now - 600_000 }, seq: 2,
          messages: [
            { id: 'user-1', role: 'user', createdAt: now - 120_000, parts: [{ type: 'text', text: 'Keep the composer reachable and show which computer I am using.' }] },
            { id: 'assistant-1', role: 'assistant', createdAt: now - 115_000, parts: [{ type: 'text', text: 'I’m checking the phone layout and reconnect states. Each computer keeps its own draft and approvals.\n\nYou can review the changed files while the task runs on Studio.' }] },
          ], pendingApprovals: args.sessionId === 'review-approval' ? [approval] : [], pendingInputs: [], tasks: [] }
      }
      return []
    },
    send: async () => { throw new Error('Read-only local review fixture') },
  },
}
export const useApp = () => app

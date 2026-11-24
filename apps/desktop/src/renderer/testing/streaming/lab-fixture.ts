import type { Payload, ReplayEvent } from './model'

/** Authored UI fixture, not a claim about actual repository findings or runtime performance. */
const parts: Payload[] = []
const narrate = (itemId: string, text: string) => {
  const chunks = text.match(/.{1,34}(?:\s|$)|.{1,34}/g) ?? [text]
  for (const chunk of chunks) parts.push({ type: 'narration', itemId, text: chunk, mode: 'append' })
}
const start = (
  callId: string,
  name: string,
  category: 'read' | 'search' | 'command',
  args: Record<string, unknown>,
) =>
  parts.push({
    type: 'tool',
    callId,
    name,
    category,
    args: JSON.stringify(args),
    status: 'running',
  })
const finish = (callId: string, output: string, status: 'completed' | 'failed' = 'completed') =>
  parts.push({ type: 'tool', callId, output, status, outputMode: 'replace' })

narrate(
  'intro',
  'I’m tracing the sidebar’s update path. I’ll follow the navigation projection, check its subscribers, and run the focused tests.',
)
start('read-app', 'read', 'read', { path: 'apps/desktop/src/renderer/src/App.tsx', limit: 120 })
start('read-sidebar', 'read', 'read', {
  path: 'apps/desktop/src/renderer/src/shell/Sidebar.tsx',
  limit: 120,
})
parts.push({
  type: 'tool',
  callId: 'read-app',
  output: '// Synthetic excerpt\nconst navigation = useMachineProjects(projects, sessions)\n',
  outputMode: 'append',
})
finish(
  'read-app',
  '// Synthetic excerpt\nconst navigation = useMachineProjects(projects, sessions)\nreturn <Sidebar projects={navigation.sidebarProjects} />',
)
start('search-consumers', 'search', 'search', {
  pattern: 'sidebarProjects|setProjects',
  path: 'apps/desktop/src/renderer/src',
})
finish(
  'read-sidebar',
  '// Synthetic excerpt\nconst visible = projects.filter(project => project.open)',
)
finish(
  'search-consumers',
  'Fixture search results\nApp.tsx → navigation.sidebarProjects\nSidebar.tsx → projects\nuse-machine-projects.ts → project catalog projection',
)
narrate(
  'finding',
  'The sidebar reads the navigation projection, while App keeps a separate project list. I’m checking whether both paths receive the same update.',
)
start('read-projection', 'read', 'read', {
  path: 'apps/desktop/src/renderer/src/features/machines/use-machine-projects.ts',
  limit: 180,
})
finish(
  'read-projection',
  '// Synthetic excerpt for presentation review\nconst sidebarProjects = projectCatalog.map(toSidebarProject)',
)
start('test-projection', 'exec_command', 'command', {
  cmd: 'pnpm test -- use-machine-projects',
  workdir: 'Ari',
})
start('test-sidebar', 'exec_command', 'command', { cmd: 'pnpm test -- Sidebar', workdir: 'Ari' })
parts.push({
  type: 'tool',
  callId: 'test-projection',
  output: 'RUN use-machine-projects\n✓ catalog projection\n✓ local project updates\n',
  outputMode: 'append',
})
parts.push({
  type: 'tool',
  callId: 'test-sidebar',
  output: 'RUN Sidebar\n✓ project visibility\n✓ session selection\n',
  outputMode: 'append',
})
export const liveCheckpoint = parts.length
narrate(
  'checking',
  'The reads and search are complete. The two test commands are running in parallel; their results will determine which subscription needs attention.',
)
finish('test-sidebar', 'PASS Sidebar\n8 checks passed.\nexit 0')
finish(
  'test-projection',
  Array.from({ length: 132 }, (_, index) =>
    index === 125
      ? 'FAIL project update was not delivered to the navigation projection'
      : `fixture check ${String(index + 1).padStart(3, '0')} · PASS`,
  ).join('\n'),
  'failed',
)
parts.push({
  type: 'decision',
  id: 'rerun',
  kind: 'approval',
  text: 'Rerun the focused test command with the fixture’s workspace script?',
  command: 'pnpm test -- use-machine-projects',
  options: ['Allow once', 'Deny'],
})
export const attentionCheckpoint = parts.length
parts.push({ type: 'resolved', id: 'rerun', answer: 'Allow once' })
start('retry', 'exec_command', 'command', {
  cmd: 'pnpm test -- use-machine-projects',
  workdir: 'Ari',
})
parts.push({ type: 'connection', connected: false })
export const disconnectedCheckpoint = parts.length
parts.push({ type: 'connection', connected: true })
finish('retry', 'PASS use-machine-projects\n12 checks passed.\nexit 0')
narrate(
  'result',
  'The fixture investigation is complete. The navigation subscription is the review point, and the focused rerun passed. Every command and output is still available in the work log.',
)
parts.push({ type: 'settled', reason: 'completed' })

export const labScenario = {
  id: 'navigation-lab',
  label: 'Navigation investigation',
  harness: 'Provider-neutral fixture',
  provenance:
    'Authored streaming sequence with partial narration, parallel reads/commands, a long failure, a decision and reconnect. Findings and outputs are synthetic. All layouts consume this identical sequence.',
  events: parts.map((part, seq) => ({
    ...part,
    seq,
    turnId: 'navigation-review',
  })) as ReplayEvent[],
  checkpoint: liveCheckpoint,
}

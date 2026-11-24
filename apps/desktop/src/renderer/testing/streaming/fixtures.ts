import type { AgentEvent } from '@ari/contracts/agent-event'
import { mapPiLine } from '../../../../../../packages/providers/src/pi/mapper'
import { mapOpencodeLine } from '../../../../../../packages/providers/src/opencode/mapper'
import { mapCodexLine } from '../../../../../../packages/providers/src/codex/mapper'
import { mapGrokLine } from '../../../../../../packages/providers/src/grok/mapper'
import { mapHermesLine } from '../../../../../../packages/providers/src/hermes/mapper'
import { ClaudeMessageMapper } from '../../../../../../packages/providers/src/claude/mapper'
import { AcpUpdateFolder } from '../../../../../../packages/providers/src/acp/protocol'
import piRaw from '../../../../../../packages/providers/src/pi/__fixtures__/success-session.jsonl?raw'
import opencodeRaw from '../../../../../../packages/providers/src/opencode/__fixtures__/live-run.jsonl?raw'
import type { Category, Payload, ReplayEvent } from './model'

export interface Scenario {
  id: string
  label: string
  harness: string
  provenance: string
  events: ReplayEvent[]
  checkpoint: number
}
const stamp = (events: Payload[], turnId = 'review-turn'): ReplayEvent[] =>
  events.map((event, seq) => ({ ...event, seq, turnId }))
const category = (name: string): Category =>
  /^(read|Read|read_file)$/.test(name)
    ? 'read'
    : /^(search|Grep|grep|Glob)$/.test(name)
      ? 'search'
      : /^(bash|Bash|shell|command_execution|exec_command)$/.test(name)
        ? 'command'
        : /^(edit|Edit|Write|write_file)$/.test(name)
          ? 'edit'
          : 'other'
/** Existing parsers supply the baseline. Thought events never enter the fixture presentation. */
export function fromAgent(events: AgentEvent[]): ReplayEvent[] {
  const payloads: Payload[] = []
  let item = 0
  for (const event of events) {
    if (event.type === 'text-delta')
      payloads.push({
        type: 'narration',
        itemId: `message:${item}`,
        text: event.text,
        mode: 'append',
      })
    if (event.type === 'tool-started') {
      payloads.push({
        type: 'tool',
        callId: event.callId,
        name: event.name,
        category: category(event.name),
        args: event.argsJson,
      })
      item++
    }
    if (event.type === 'tool-completed')
      payloads.push({
        type: 'tool',
        callId: event.callId,
        output: event.resultJson,
        status: event.isError ? 'failed' : 'completed',
      })
    if (event.type === 'error') payloads.push({ type: 'diagnostic', text: event.message })
    if (event.type === 'done') payloads.push({ type: 'settled', reason: 'completed' })
  }
  return stamp(payloads)
}
const lines = (text: string) => text.split(/\r?\n/).filter(Boolean)
const narration =
  'I’m tracing how navigation.sidebarProjects relates to the App-level projects state. I’ll follow the state through the sidebar, check how updates reach the session view, and identify where the two can drift.'
const commands = [
  'rg -n sidebarProjects apps/desktop/src/renderer/src',
  'rg -n navigation.sidebarProjects apps/desktop/src/renderer/src/App.tsx',
  'rg -n useMachineProjects apps/desktop/src/renderer/src',
  'Get-Content apps/desktop/src/renderer/src/App.tsx',
  'Get-Content apps/desktop/src/renderer/src/shell/Sidebar.tsx',
  'rg -n setProjects apps/desktop/src/renderer/src',
  'rg -n project.updated packages/contracts/src',
  'Get-Content apps/desktop/src/renderer/src/features/machines/use-machine-projects.ts',
  'rg -n project.catalog apps/desktop/src/renderer/src',
  'rg -n sidebarProjects apps/desktop/src/renderer/src/features/machines',
  'rg -n navigation.sidebarProjects apps/desktop/src/renderer/src/App.tsx',
]
const reference: Payload[] = [
  { type: 'narration', itemId: 'intro', text: narration.slice(0, 71), mode: 'append' },
  { type: 'narration', itemId: 'intro', text: narration.slice(71), mode: 'append' },
]
commands.forEach((command, index) =>
  reference.push(
    {
      type: 'tool',
      callId: `command-${index + 1}`,
      name: 'exec_command',
      category: 'command',
      args: JSON.stringify({ cmd: command, workdir: 'Ari' }),
    },
    {
      type: 'tool',
      callId: `command-${index + 1}`,
      status: 'completed',
      output: `Fixture command ${index + 1} completed. Repository contents are intentionally omitted.`,
    },
  ),
)
reference.push(
  {
    type: 'narration',
    itemId: 'result',
    text: 'The navigation projection and App state have separate update paths. I’ve finished tracing their consumers; the next step is to verify their subscriptions.',
    mode: 'append',
  },
  { type: 'settled', reason: 'completed' },
)

/** Synthetic design stress fixture. Declared semantics, no inferred shell file-read counts. */
export function sharedSequence(harness: string): ReplayEvent[] {
  return stamp(
    [
      {
        type: 'narration',
        itemId: 'intro',
        mode: 'append',
        text: 'I’ll check the navigation projection and the sidebar subscriptions, then run the focused tests.',
      },
      {
        type: 'tool',
        callId: 'read-1',
        name: 'read',
        category: 'read',
        args: '{"path":"App.tsx"}',
        status: 'running',
      },
      {
        type: 'tool',
        callId: 'read-1',
        name: 'read',
        args: '{"path":"apps/desktop/src/renderer/src/App.tsx","limit":120}',
        version: 1,
      },
      {
        type: 'tool',
        callId: 'search-1',
        name: 'search',
        category: 'search',
        args: '{"pattern":"sidebarProjects","path":"apps/desktop/src/renderer/src"}',
        status: 'running',
      },
      {
        type: 'tool',
        callId: 'read-1',
        output:
          '1  // Synthetic file excerpt for this review\n2  const navigation = useMachineProjects(projects, sessions)\n',
        outputMode: 'append',
      },
      {
        type: 'tool',
        callId: 'read-1',
        output: '3  // The real repository file is not reproduced here.\n',
        outputMode: 'append',
      },
      { type: 'tool', callId: 'read-1', status: 'completed' },
      {
        type: 'tool',
        callId: 'search-1',
        output: 'App.tsx: navigation.sidebarProjects\nSidebar.tsx: projects.map(...)',
        status: 'completed',
      },
      {
        type: 'tool',
        callId: 'test-1',
        name: 'exec_command',
        category: 'command',
        args: '{"cmd":"pnpm test -- use-machine-projects"}',
        status: 'running',
      },
      {
        type: 'tool',
        callId: 'test-2',
        name: 'exec_command',
        category: 'command',
        args: '{"cmd":"pnpm test -- Sidebar"}',
        status: 'running',
      },
      {
        type: 'tool',
        callId: 'test-1',
        output: '\u001b[35mRUN\u001b[0m focused tests\nChecking 1/3\rChecking 2/3\rChecking 3/3\n',
        outputMode: 'append',
      },
      {
        type: 'narration',
        itemId: 'finding',
        mode: 'append',
        text: 'The file read and search are complete. Both test commands are still running in parallel.',
      },
      {
        type: 'tool',
        callId: 'test-2',
        status: 'completed',
        output: 'PASS Sidebar fixture · 8 checks',
      },
      {
        type: 'tool',
        callId: 'test-1',
        output: Array.from(
          { length: 180 },
          (_, i) =>
            `fixture test ${String(i + 1).padStart(3, '0')} · ${i === 176 ? 'FAIL expected one subscription, received two' : 'PASS'}`,
        ).join('\n'),
        outputMode: 'replace',
        status: 'failed',
        version: 2,
      },
      {
        type: 'tool',
        callId: 'test-1',
        output: 'stale partial snapshot',
        outputMode: 'replace',
        version: 1,
      },
      {
        type: 'decision',
        id: 'approval-1',
        kind: 'approval',
        text: 'Permission requested to rerun the focused check with a workspace script.',
        command: 'pnpm test -- use-machine-projects',
        options: ['Allow once', 'Deny'],
      },
      { type: 'resolved', id: 'approval-1', answer: 'Allow once' },
      {
        type: 'tool',
        callId: 'retry-1',
        name: 'exec_command',
        category: 'command',
        args: '{"cmd":"pnpm test -- use-machine-projects"}',
        status: 'running',
      },
      { type: 'connection', connected: false },
      { type: 'connection', connected: true },
      {
        type: 'tool',
        callId: 'retry-1',
        status: 'completed',
        output: 'PASS focused checks · 12 checks',
      },
      {
        type: 'decision',
        id: 'question-1',
        kind: 'question',
        text: 'Which navigation source should own the subscription?',
        options: ['Navigation projection', 'App state'],
      },
      { type: 'resolved', id: 'question-1', answer: 'Navigation projection' },
      {
        type: 'tool',
        callId: 'cancel-1',
        name: 'search',
        category: 'search',
        args: '{"pattern":"subscription"}',
        status: 'running',
      },
      { type: 'settled', reason: 'cancelled' },
    ],
    `${harness}:turn-1`,
  )
}

const acpScenario = (id: string, label: string): Scenario => {
  const folder = new AcpUpdateFolder(() => 0)
  const wire = [
    {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `I’ll inspect the navigation with ${label}.` },
    },
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'read-a',
      kind: 'read',
      title: 'Read App.tsx',
      status: 'pending',
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'read-a',
      rawInput: { path: 'App.tsx' },
      status: 'in_progress',
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'read-a',
      rawOutput: 'Synthetic excerpt · navigation.sidebarProjects',
      status: 'completed',
    },
    {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'The read is complete.' },
    },
  ]
  const events = fromAgent(wire.flatMap((update) => folder.fold({ sessionId: 'fixture', update })))
  return {
    id,
    label,
    harness: label,
    provenance:
      'Synthetic ACP updates through production AcpUpdateFolder; shared stress fixture adds proposed lifecycle/output semantics.',
    events: events.concat(
      sharedSequence(id).map((event, i) => ({ ...event, seq: events.length + i })),
    ),
    checkpoint: events.length + 16,
  }
}
const syntheticClaude = new ClaudeMessageMapper()
// Deliberately partial synthetic wire shapes; the production mapper reads these fields defensively.
const mapClaudeFixture = (native: unknown) =>
  syntheticClaude.map(native as Parameters<ClaudeMessageMapper['map']>[0])
const claudeEvents = fromAgent([
  ...mapClaudeFixture({
    type: 'stream_event',
    event: { type: 'message_start', message: { id: 'fixture-message' } },
  }),
  ...mapClaudeFixture({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'I’ll read the navigation entry.' },
    },
  }),
  ...mapClaudeFixture({
    type: 'assistant',
    message: {
      id: 'fixture-message',
      content: [
        { type: 'text', text: 'I’ll read the navigation entry.' },
        { type: 'tool_use', id: 'claude-read', name: 'Read', input: { file_path: 'App.tsx' } },
      ],
    },
  }),
  ...mapClaudeFixture({
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'claude-read',
          content: 'Synthetic excerpt for review.',
        },
      ],
    },
  }),
])
const augment = (
  id: string,
  label: string,
  provenance: string,
  events: ReplayEvent[],
): Scenario => ({
  id,
  label,
  harness: label,
  provenance,
  events: events.concat(
    sharedSequence(id).map((event, i) => ({ ...event, seq: events.length + i })),
  ),
  checkpoint: events.length + 16,
})
export const scenarios: Scenario[] = [
  {
    id: 'reference',
    label: 'Reference · 11 command rows',
    harness: 'Provider-neutral',
    provenance:
      'Reconstruction from the supplied 1592×897 screenshot description. Synthetic narration/commands; not a live capture. Before and after use the identical 26-event sequence.',
    events: stamp(reference),
    checkpoint: 24,
  },
  {
    id: 'stress',
    label: 'Shared · parallel / errors / decisions',
    harness: 'All harnesses',
    provenance:
      'Synthetic design fixture exercising the proposed contract; no provider capability claims.',
    events: sharedSequence('shared'),
    checkpoint: 16,
  },
  augment(
    'pi-cli',
    'Pi · JSON CLI',
    'Repository success-session.jsonl (documented as synthesized) through mapPiLine. message_update is currently ignored. Followed by a separate synthetic stress turn.',
    fromAgent(lines(piRaw).flatMap(mapPiLine)),
  ),
  acpScenario('pi-acp', 'Pi · ACP'),
  augment(
    'opencode-cli',
    'OpenCode · JSON CLI',
    'Recorded repository live-run.jsonl (hello only) plus synthesized tool_use states through mapOpencodeLine. The running-state completion is shown faithfully in Current source; the added stress turn demonstrates the proposal.',
    fromAgent([
      ...lines(opencodeRaw).flatMap(mapOpencodeLine),
      ...mapOpencodeLine(
        JSON.stringify({
          type: 'tool_use',
          part: {
            type: 'tool',
            tool: 'bash',
            callID: 'oc-tool',
            state: {
              status: 'running',
              input: { command: 'rg -n sidebarProjects App.tsx' },
              output: 'Partial fixture output',
            },
          },
        }),
      ),
    ]),
  ),
  acpScenario('opencode-acp', 'OpenCode · ACP'),
  augment(
    'claude-sdk',
    'Claude · SDK',
    'Synthetic message/delta/finalized fallback through production ClaudeMessageMapper (SDK and CLI share this mapper). No live provider invoked.',
    claudeEvents,
  ),
  augment(
    'claude-cli',
    'Claude · stream-json CLI',
    'Synthetic wire data through ClaudeMessageMapper; shared by SDK and CLI.',
    claudeEvents,
  ),
  acpScenario('claude-acp', 'Claude · ACP'),
  acpScenario('codex-acp', 'Codex · ACP'),
  augment(
    'codex-appserver',
    'Codex · app-server',
    'Synthetic normalized stress sequence. App-server mapping is source/test-audited; this scenario is not a native transport integration test.',
    [],
  ),
  augment(
    'codex-cli',
    'Codex · exec JSON',
    'Synthetic item.completed wire through mapCodexLine, including completion without an earlier start.',
    fromAgent(
      mapCodexLine(
        JSON.stringify({
          type: 'item.completed',
          item: {
            id: 'codex-command',
            type: 'command_execution',
            command: 'rg -n sidebarProjects App.tsx',
            aggregated_output: 'Synthetic match',
            exit_code: 0,
          },
        }),
      ),
    ),
  ),
  acpScenario('grok-acp', 'Grok · ACP'),
  augment(
    'grok-cli',
    'Grok · NDJSON CLI',
    'Synthetic Anthropic-style partial messages through mapGrokLine.',
    fromAgent(
      mapGrokLine(
        JSON.stringify({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'I’ll check the navigation.' },
          },
        }),
      ),
    ),
  ),
  acpScenario('hermes-acp', 'Hermes · ACP'),
  augment(
    'hermes-cli',
    'Hermes · stream-json CLI',
    'Synthetic assistant block through mapHermesLine. This compatibility wire schema is explicitly unverified in its source.',
    fromAgent(
      mapHermesLine(
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'I’ll check the navigation.' }] },
        }),
      ),
    ),
  ),
  acpScenario('qoder-acp', 'Qoder · ACP only'),
  acpScenario('muse-acp', 'Muse · ACP only'),
  ...['OpenAI chat', 'Anthropic Messages', 'Ollama'].map((flavor, i) =>
    augment(
      `core-${i}`,
      `Ari Core · ${flavor}`,
      'Shared synthetic normalized sequence. Ari Core protocol streamers and agent loop are source/test-audited, not called by this offline UI.',
      [],
    ),
  ),
]

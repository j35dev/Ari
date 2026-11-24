import type { AgentEvent } from '@ari/contracts/agent-event'
import { pushMessageParts, type Message, type MessagePart } from '@ari/contracts/message'
import {
  AcpUpdateFolder,
  type AcpSessionUpdate,
} from '../../../../../../packages/providers/src/acp/protocol'
import { groupBlocks } from '../../src/features/transcript/groupBlocks'
import { splitBlocks } from '../../src/features/transcript/splitBlocks'

/** Controlled wire fixture. The utterance/phase annotations are NOT claimed to be Qoder wire fields. */
export type Frame = {
  seq: number
  update?: AcpSessionUpdate
  end?: boolean
  utterance?: string
  phase?: 'progress' | 'reply'
}
export interface StreamFixture {
  id: string
  label: string
  description: string
  frames: Frame[]
  checkpoint: number
}
const stamp = (frames: Omit<Frame, 'seq'>[]): Frame[] =>
  frames.map((frame, seq) => ({ ...frame, seq }))
const text = (value: string): AcpSessionUpdate => ({
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text: value },
})
// This is a synthetic placeholder, not private reasoning recovered from the screenshot or a live session.
const privateActivity = (): AcpSessionUpdate => ({
  sessionUpdate: 'agent_thought_chunk',
  content: { type: 'text', text: '[synthetic activity]' },
})
const fragmentPieces = [
  'The ',
  'sub',
  'scription ',
  'check ',
  'is ',
  'complete. ',
  'No ',
  'changes ',
  'were made.',
]
const fragments = stamp([
  ...fragmentPieces.flatMap((piece): Omit<Frame, 'seq'>[] => [
    { update: text(piece), utterance: 'reply-1', phase: 'reply' },
    { update: privateActivity() },
  ]),
  { end: true },
])
const loop: Omit<Frame, 'seq'>[] = []
for (let index = 1; index <= 40; index++) {
  loop.push({
    update: text(`Checking update path ${index}.\n`),
    utterance: `update-${index}`,
    phase: 'progress',
  })
  loop.push({
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: `command-${index}`,
      kind: 'execute',
      title: `Check update path ${index}`,
      status: 'in_progress',
      rawInput: { command: `rg -n "subscription_${index}" src/navigation.ts` },
    },
  })
  loop.push({
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: `command-${index}`,
      status: index === 28 ? 'failed' : 'completed',
      rawOutput:
        index === 28
          ? 'Fixture check failed; this is not actual repository output.'
          : `Fixture result ${index}. Repository contents omitted.`,
    },
  })
}
loop.push(
  {
    update: text(
      'The fixture check is complete. Forty commands were received; one failed attempt remains in the work log. No repository changes were made.',
    ),
    utterance: 'final-reply',
    phase: 'reply',
  },
  { end: true },
)
export const qoderFixtures: StreamFixture[] = [
  {
    id: 'interleaved',
    label: 'Text / thought fragmentation',
    description:
      'Neutral reconstruction of the supplied screenshot pattern. Synthetic ACP chunks pass through Ari’s actual mapper and renderer. Private activity uses placeholders.',
    frames: fragments,
    checkpoint: fragments.length - 1,
  },
  {
    id: 'long-loop',
    label: '40 sentence / command cycles',
    description:
      'Synthetic long turn: forty distinct public progress messages and commands, one failure, and an explicitly annotated reply. Message phase annotations demonstrate the proposed contract, not verified Qoder metadata.',
    frames: stamp(loop),
    checkpoint: 119,
  },
]

export function normalized(frames: Frame[]): AgentEvent[] {
  const folder = new AcpUpdateFolder(() => 0)
  return [...new Map(frames.map((frame) => [frame.seq, frame])).values()]
    .sort((a, b) => a.seq - b.seq)
    .flatMap((frame) =>
      frame.update ? folder.fold({ sessionId: 'qoder-fixture', update: frame.update }) : [],
    )
}
export function currentMessages(frames: Frame[]): Message[] {
  const parts: MessagePart[] = []
  for (const event of normalized(frames)) {
    if (event.type === 'text-delta') pushMessageParts(parts, [{ type: 'text', text: event.text }])
    else if (event.type === 'thinking-delta')
      pushMessageParts(parts, [{ type: 'thinking', text: event.text }])
    else if (event.type === 'tool-started')
      pushMessageParts(parts, [
        { type: 'tool-call', callId: event.callId, name: event.name, argsJson: event.argsJson },
      ])
    else if (event.type === 'tool-completed')
      pushMessageParts(parts, [
        {
          type: 'tool-result',
          callId: event.callId,
          resultJson: event.resultJson,
          isError: event.isError,
        },
      ])
  }
  return [
    {
      id: 'qoder-fixture-message',
      sessionId: 'qoder-fixture',
      turnId: 'qoder-fixture-turn',
      createdAt: 1,
      role: 'assistant',
      parts,
    },
  ]
}
export function currentRows(frames: Frame[]) {
  return groupBlocks(splitBlocks(currentMessages(frames)))
}

export type PublicMessage = {
  id: string
  text: string
  phase: 'progress' | 'reply' | 'unclassified'
  firstSeq: number
}
export type Operation = {
  id: string
  name: string
  args: string
  output: string
  status: 'running' | 'completed' | 'failed'
  firstSeq: number
}
/** Two independent lanes. Never concatenates private activity into public prose. */
export function calmStream(frames: Frame[]) {
  const folder = new AcpUpdateFolder(() => 0)
  const messages = new Map<string, PublicMessage>()
  const operations = new Map<string, Operation>()
  let privateUpdates = 0
  let ended = false
  let callRound = 0
  for (const frame of [...new Map(frames.map((item) => [item.seq, item])).values()].sort(
    (a, b) => a.seq - b.seq,
  )) {
    if (frame.end) {
      ended = true
      continue
    }
    if (!frame.update) continue
    for (const event of folder.fold({ sessionId: 'qoder-fixture', update: frame.update })) {
      if (event.type === 'thinking-delta') {
        privateUpdates++
        continue
      }
      if (event.type === 'text-delta') {
        // Conservative fixture fallback: tools mark model-round boundaries; private chunks do not.
        const id = frame.utterance ?? `public-round-${callRound}`
        const prior = messages.get(id)
        if (prior) prior.text += event.text
        else
          messages.set(id, {
            id,
            text: event.text,
            phase: frame.phase ?? 'unclassified',
            firstSeq: frame.seq,
          })
      } else if (event.type === 'tool-started') {
        const prior = operations.get(event.callId)
        if (prior) {
          prior.name = event.name
          prior.args = event.argsJson
        } else {
          operations.set(event.callId, {
            id: event.callId,
            name: event.name,
            args: event.argsJson,
            output: '',
            status: 'running',
            firstSeq: frame.seq,
          })
          callRound++
        }
      } else if (event.type === 'tool-completed') {
        const operation = operations.get(event.callId) ?? {
          id: event.callId,
          name: 'Tool',
          args: '',
          output: '',
          status: 'running' as const,
          firstSeq: frame.seq,
        }
        operations.set(event.callId, {
          ...operation,
          output: event.resultJson,
          status: event.isError ? 'failed' : 'completed',
        })
      }
    }
  }
  return {
    messages: [...messages.values()],
    operations: [...operations.values()],
    privateUpdates,
    ended,
    uniqueFrames: new Set(frames.map((frame) => frame.seq)).size,
  }
}

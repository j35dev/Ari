import { pushMessageParts, type Message, type MessagePart } from '@ari/contracts/message'

/**
 * A realistic agent turn, timed the way providers actually deliver it, replayed
 * through the engine's coalescing (text/thinking flush every 50 ms) into the
 * real transcript. Offline: nothing executes.
 */

export type Delivery = 'tokens' | 'bursts'

type Step =
  | { at: number; kind: 'think' | 'text'; text: string; streamId: string; ms: number }
  | { at: number; kind: 'call'; callId: string; name: string; args: unknown }
  | {
      at: number
      kind: 'result'
      callId: string
      result: unknown
      isError?: boolean
    }
  | { at: number; kind: 'end' }

const FINAL = `The flicker comes from \`SessionList\` re-sorting on **every** \`turn.settled\` event, even when the order does not change. Each settle hands the list a new array, React re-keys the rows, and the hover state and the working ring reset for a frame.

## What changed

- \`SessionList\` now compares the sorted ids before replacing its rows, so a settle that leaves the order alone renders nothing.
- The working ring reads its state from the session's own store instead of the list, so a settle no longer reaches rows that did not change.
- Pinned sessions keep their position while a turn runs; they only move once it settles.

\`\`\`ts
export function useSortedSessions(sessions: readonly Session[]): readonly Session[] {
  const previous = useRef<readonly Session[]>([])
  return useMemo(() => {
    const next = [...sessions].sort(byPinnedThenRecent)
    const same =
      next.length === previous.current.length &&
      next.every((session, index) => session.id === previous.current[index]?.id)
    if (same) return previous.current
    previous.current = next
    return next
  }, [sessions])
}
\`\`\`

| Case | Before | After |
| --- | --- | --- |
| Turn settles, order unchanged | 14 rows re-render | 0 rows |
| Turn settles, row moves up | 14 rows re-render | 2 rows |
| Hover during settle | hover lost | kept |

The four \`SessionList\` tests pass, including a new one that settles a turn without changing the order and asserts no row re-mounts. If you still see a flash, it is likely the sidebar's wallpaper blur repainting; let me know and I'll look at that next.`

const THINKING = `The user says the session list flickers when a turn finishes. Likely the list re-sorts or re-keys on turn.settled. I should find where turn.settled reaches the sidebar, then read SessionList to see how rows are keyed and sorted. If it sorts into a new array every time, memoizing on the id order should fix it. I also want to check whether the working ring is driven from the list props.`

const NARRATION_1 = `I'll trace where \`turn.settled\` reaches the sidebar, then read how the list sorts and keys its rows.`

const NARRATION_2 = `Found it: \`SessionList\` sorts into a fresh array on every settle, so every row re-renders even when nothing moved. I'll keep the previous order when the ids match.`

const READ_RESULT = Array.from(
  { length: 40 },
  (_, i) => `${String(i + 1).padStart(3)}  ${i % 5 === 0 ? 'export function' : '  const'} line${i}`,
).join('\n')

export const SCRIPT: Step[] = (() => {
  const steps: Step[] = []
  let t = 300
  steps.push({ at: t, kind: 'think', text: THINKING, streamId: 'th1', ms: 2600 })
  t += 2900
  steps.push({ at: t, kind: 'text', text: NARRATION_1, streamId: 'n1', ms: 900 })
  t += 1100
  steps.push({
    at: t,
    kind: 'call',
    callId: 'c1',
    name: 'Grep',
    args: { pattern: 'turn\\.settled', path: 'apps/desktop/src/renderer' },
  })
  t += 500
  steps.push({
    at: t,
    kind: 'result',
    callId: 'c1',
    result: 'src/features/sidebar/SessionList.tsx:88\nsrc/features/session/session-store.ts:211\nsrc/features/session/SessionView.tsx:640',
  })
  t += 200
  steps.push({
    at: t,
    kind: 'call',
    callId: 'c2',
    name: 'Read',
    args: { file_path: 'apps/desktop/src/renderer/src/features/sidebar/SessionList.tsx' },
  })
  t += 350
  steps.push({ at: t, kind: 'result', callId: 'c2', result: READ_RESULT })
  t += 150
  steps.push({
    at: t,
    kind: 'call',
    callId: 'c3',
    name: 'Read',
    args: { file_path: 'apps/desktop/src/renderer/src/features/session/session-store.ts' },
  })
  t += 400
  steps.push({ at: t, kind: 'result', callId: 'c3', result: READ_RESULT })
  t += 600
  steps.push({ at: t, kind: 'text', text: NARRATION_2, streamId: 'n2', ms: 1400 })
  t += 1600
  steps.push({
    at: t,
    kind: 'call',
    callId: 'c4',
    name: 'Edit',
    args: {
      file_path: 'apps/desktop/src/renderer/src/features/sidebar/SessionList.tsx',
      old_string: '  const sorted = [...sessions].sort(byPinnedThenRecent)\n  return sorted',
      new_string:
        '  const sorted = useSortedSessions(sessions)\n  // Keeps the previous array when the order is unchanged.\n  return sorted',
    },
  })
  t += 700
  steps.push({ at: t, kind: 'result', callId: 'c4', result: 'The file has been updated.' })
  t += 200
  steps.push({
    at: t,
    kind: 'call',
    callId: 'c5',
    name: 'Bash',
    args: { command: 'pnpm --filter @ari/desktop exec vitest run SessionList' },
  })
  t += 2200
  steps.push({
    at: t,
    kind: 'result',
    callId: 'c5',
    result:
      ' ✓ src/features/sidebar/SessionList.test.tsx (4 tests) 212ms\n\n Test Files  1 passed (1)\n      Tests  4 passed (4)\n   Duration  1.84s',
  })
  t += 700
  steps.push({ at: t, kind: 'text', text: FINAL, streamId: 'f1', ms: 9000 })
  t += 9200
  steps.push({ at: t, kind: 'end' })
  return steps
})()

export const SCRIPT_MS = SCRIPT[SCRIPT.length - 1]!.at

/** One provider delta: a slice of a text/thinking step at a moment. */
interface Delta {
  at: number
  kind: 'think' | 'text'
  streamId: string
  text: string
}

/**
 * Splits a text step into provider deltas. `tokens`: ~4-char tokens spread
 * evenly (OpenAI / Codex app-server). `bursts`: 120–400 char blocks every
 * ~350 ms with gaps (what SDK/ACP bridges often forward).
 */
function deltasOf(
  step: Extract<Step, { kind: 'think' | 'text' }>,
  delivery: Delivery,
  seed: number,
): Delta[] {
  const out: Delta[] = []
  const { text } = step
  let rand = seed
  const next = (): number => {
    rand = (rand * 1103515245 + 12345) % 2147483648
    return rand / 2147483648
  }
  if (delivery === 'tokens') {
    const pieces = text.match(/\s*\S{1,5}|\s+/g) ?? [text]
    const gap = step.ms / pieces.length
    pieces.forEach((piece, i) => {
      out.push({
        // Jitter inside the token's own slot, so order is kept.
        at: step.at + i * gap + next() * gap * 0.8,
        kind: step.kind,
        streamId: step.streamId,
        text: piece,
      })
    })
    return out
  }
  let offset = 0
  let at = step.at
  while (offset < text.length) {
    const size = Math.round(120 + next() * 280)
    out.push({
      at,
      kind: step.kind,
      streamId: step.streamId,
      text: text.slice(offset, offset + size),
    })
    offset += size
    at += 250 + next() * 450
  }
  return out
}

export type TimedParts = { at: number; parts: MessagePart[]; end?: boolean }

/** The engine's view: deltas coalesced into 50 ms flushes, tools flush first. */
export function timeline(delivery: Delivery): TimedParts[] {
  const events: (Delta | Exclude<Step, { kind: 'think' | 'text' }>)[] = []
  SCRIPT.forEach((step, i) => {
    if (step.kind === 'think' || step.kind === 'text')
      events.push(...deltasOf(step, delivery, i + 7))
    else events.push(step)
  })
  events.sort((a, b) => a.at - b.at)
  const out: TimedParts[] = []
  let buffer: MessagePart[] = []
  let bufferStart = 0
  const flush = (at: number): void => {
    if (buffer.length === 0) return
    out.push({ at, parts: buffer })
    buffer = []
  }
  for (const event of events) {
    // The engine's flush timer: a buffer never waits past 50 ms for company.
    if (buffer.length > 0 && event.at - bufferStart >= 50) flush(bufferStart + 50)
    if ('streamId' in event && (event.kind === 'think' || event.kind === 'text')) {
      if (buffer.length === 0) bufferStart = event.at
      const type = event.kind === 'think' ? 'thinking' : 'text'
      const last = buffer[buffer.length - 1]
      if (last && last.type === type && 'streamId' in last && last.streamId === event.streamId)
        last.text += event.text
      else buffer.push({ type, text: event.text, streamId: event.streamId })
      continue
    }
    flush(event.at)
    if (event.kind === 'call')
      out.push({
        at: event.at,
        parts: [
          {
            type: 'tool-call',
            callId: event.callId,
            name: event.name,
            argsJson: JSON.stringify(event.args),
          },
        ],
      })
    else if (event.kind === 'result')
      out.push({
        at: event.at,
        parts: [
          {
            type: 'tool-result',
            callId: event.callId,
            resultJson: JSON.stringify(event.result),
            isError: event.isError === true,
          },
        ],
      })
    else out.push({ at: event.at, parts: [], end: true })
  }
  return out
}

const USER: Message = {
  id: 'msg_user',
  sessionId: 'replay',
  turnId: 'turn_1',
  role: 'user',
  parts: [
    {
      type: 'text',
      text: 'The session list flickers every time a turn finishes. Can you find out why and fix it?',
    },
  ],
  createdAt: 1,
}

/** Messages after applying every flush up to `upTo` (exclusive index). */
export function messagesAt(flushes: readonly TimedParts[], upTo: number): Message[] {
  const parts: MessagePart[] = []
  for (let i = 0; i < upTo; i++) {
    const flush = flushes[i]
    if (flush) pushMessageParts(parts, flush.parts)
  }
  if (parts.length === 0) return [USER]
  return [
    USER,
    {
      id: 'msg_assistant',
      sessionId: 'replay',
      turnId: 'turn_1',
      role: 'assistant',
      parts,
      createdAt: 2,
    },
  ]
}

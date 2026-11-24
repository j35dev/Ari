import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { StreamFrame } from '@ari/contracts/rpc'
import type { UnstampedEvent } from '@ari/engine/projection'
import { MotionProvider } from '@ari/ui/motion-provider'
import { ToastProvider } from '@ari/ui/toast'
import { Titlebar } from '../src/shell/Titlebar'
import { SessionView } from '../src/features/session/SessionView'
import '@ari/ui/fonts'
import '../src/styles/index.css'
import '../src/features/transcript/transcript.css'
import './streaming/streaming.css'

// Synthetic journal events, using the production SessionView and history replay.
// Nothing here invokes a provider, tool, daemon, real session or filesystem RPC.
const frames: UnstampedEvent[] = [
  { type: 'turn.started', turnId: 'turn' },
  {
    type: 'assistant.parts.appended',
    messageId: 'parent',
    parts: [
      {
        type: 'text',
        text: 'I’m tracing the sidebar state and checking the replay behavior in parallel.',
      },
      ...['navigation', 'replay'].map((name) => ({
        type: 'tool-call' as const,
        callId: `call-${name}`,
        name: 'Agent',
        argsJson: JSON.stringify({
          description: name === 'navigation' ? 'Trace sidebar state' : 'Check event replay',
          subagent_type: 'Explore',
          run_in_background: true,
          prompt: `Inspect the ${name} fixture only.`,
        }),
      })),
    ],
  },
  ...['navigation', 'replay'].map((name): UnstampedEvent => ({
    type: 'background.task.updated',
    taskId: `call-${name}`,
    providerItemId: `call-${name}`,
    nativeTaskId: `native-${name}`,
    providerThreadId: 'fixture-thread',
    kind: 'subagent',
    label: name === 'navigation' ? 'Trace sidebar state' : 'Check event replay',
    status: 'running',
    subagentType: 'Explore',
    prompt: `Inspect the ${name} fixture only. Return a brief report; do not change files.`,
    detail: name === 'navigation' ? 'Reading sidebar fixtures' : 'Checking replay fixtures',
  })),
]
for (let i = 1; i <= 8; i++) {
  frames.push({
    type: 'background.task.parts.appended',
    taskId: 'call-navigation',
    parts: [
      {
        type: 'text',
        text:
          i === 1
            ? 'I’ll inspect how the project list reaches the sidebar.'
            : `Checking fixture path ${i}.`,
        streamId: `child-text-${i}`,
      },
      {
        type: 'tool-call',
        callId: `read-${i}`,
        name: 'Read',
        argsJson: JSON.stringify({ file_path: `fixtures/sidebar-${i}.ts` }),
      },
    ],
  })
  frames.push({
    type: 'background.task.parts.appended',
    taskId: 'call-navigation',
    parts: [
      {
        type: 'tool-result',
        callId: `read-${i}`,
        resultJson: JSON.stringify(
          `Synthetic fixture ${i}: project state flows through the sidebar subscription.`,
        ),
        isError: false,
      },
    ],
  })
}
frames.push(
  {
    type: 'assistant.parts.appended',
    messageId: 'parent',
    parts: [
      {
        type: 'text',
        text: 'Both native agents are running. Their file reads and checks are available in their own transcripts.',
      },
    ],
  },
  { type: 'session.status.changed', from: 'running', to: 'idle', reason: null },
  { type: 'turn.settled', turnId: 'turn', stopReason: 'completed', errorMessage: null },
)
const working = frames.length
frames.push({
  type: 'approval.requested',
  approvalId: 'fixture-approval',
  taskId: 'native-replay',
  toolName: 'Bash',
  summaryJson: JSON.stringify({
    command: 'pnpm test replay-fixture',
    description: 'Run the synthetic replay check',
  }),
  options: [
    { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
  ],
})
const needsYou = frames.length
frames.push(
  {
    type: 'approval.responded',
    approvalId: 'fixture-approval',
    decision: 'allow',
    optionId: 'allow',
  },
  {
    type: 'background.task.parts.appended',
    taskId: 'call-replay',
    parts: [
      { type: 'text', text: 'I’ll check whether a replayed update duplicates the tool result.' },
      {
        type: 'tool-call',
        callId: 'replay-check',
        name: 'Bash',
        argsJson: JSON.stringify({ command: 'pnpm test replay-fixture' }),
      },
      {
        type: 'tool-result',
        callId: 'replay-check',
        resultJson: JSON.stringify(
          'Synthetic failure: expected one tool result; received two.\nNo actual repository test was executed.',
        ),
        isError: true,
      },
    ],
  },
  {
    type: 'background.task.updated',
    taskId: 'call-replay',
    kind: 'subagent',
    label: 'Check event replay',
    status: 'failed',
    detail: 'Replay assertion failed',
    result:
      'The replay fixture delivered a duplicate tool result. This is a synthetic failure for review.',
  },
  {
    type: 'background.task.parts.appended',
    taskId: 'call-navigation',
    parts: [
      {
        type: 'text',
        text: 'The sidebar fixture reads the navigation subscription. The app-level list is supplied through a separate path.',
        streamId: 'child-final',
      },
    ],
  },
  {
    type: 'background.task.updated',
    taskId: 'call-navigation',
    kind: 'subagent',
    label: 'Trace sidebar state',
    status: 'completed',
    detail: 'Traced eight fixture files',
    result:
      'The sidebar fixture reads the navigation subscription. The app-level list is supplied through a separate path.',
  },
)

type Subscriber = {
  receive: (frame: StreamFrame) => void
  name?: StreamFrame['name']
  sessionId?: string
  replayed?: boolean
  lastSeq?: number
}
const subscribers = new Map<string, Subscriber>()
const replayStartedAt = Date.now() - 65_000
let interactiveEvents: UnstampedEvent[] = []
let cursor = working
let currentSessionId = 'sess_native_fixture_0'
let navigateTo: (at: number) => void = () => {}
const eventsAt = () =>
  [...frames.slice(0, cursor), ...interactiveEvents].map((frame, i) => ({
    ...frame,
    seq: i + 1,
    at: replayStartedAt + i * 900,
    sessionId: currentSessionId,
  }))
const broadcast = () => {
  for (const [id, sub] of subscribers)
    if (sub.name === 'session.events' && sub.sessionId === currentSessionId) {
      const events = eventsAt()
      if (!sub.replayed) {
        sub.receive({
          id,
          name: 'session.events',
          payload: { sessionId: currentSessionId, replay: true, events },
        })
        sub.receive({
          id,
          name: 'session.events',
          payload: {
            sessionId: currentSessionId,
            replayDone: true,
            replayOutcome: 'complete',
            liveTurnId: null,
          },
        })
        sub.replayed = true
      } else
        for (const event of events)
          if (event.seq > (sub.lastSeq ?? 0))
            sub.receive({
              id,
              name: 'session.events',
              payload: { sessionId: currentSessionId, event },
            })
      sub.lastSeq = events.length
    }
}
window.ari = {
  async invoke(method, raw) {
    await Promise.resolve()
    const params = raw as
      | {
          id?: string
          name?: StreamFrame['name']
          params?: { sessionId?: string }
          command?: { type: string; decision?: string; optionId?: string }
        }
      | undefined
    if (method === 'stream.subscribe') {
      const sub = params?.id ? subscribers.get(params.id) : null
      if (sub) {
        sub.name = params?.name
        sub.sessionId = params?.params?.sessionId
        broadcast()
      }
      return { subscribed: true }
    }
    if (method === 'stream.unsubscribe') return { subscribed: false }
    if (method === 'settings.get')
      return {
        version: 1,
        appearance: {
          themeId: 'porcelain',
          mode: 'light',
          chatStyle: 'conversation',
          reducedMotion: true,
        },
        sessions: { defaultDriverKind: null, defaultPermissionMode: 'ask' },
        notifications: { settleSound: false },
        permissions: { allowlist: [] },
        window: null,
      }
    if (method === 'session.load')
      return {
        session: {
          id: currentSessionId,
          projectId: 'fixture-project',
          title: 'Sidebar streaming review',
          driverKind: 'qoder',
          modelId: 'default',
          permissionMode: 'ask',
          status: 'idle',
          createdAt: 0,
          updatedAt: 0,
        },
        activeTurnId: null,
      }
    if (
      [
        'project.list',
        'providers.detect',
        'providers.models',
        'endpoints.list',
        'session.tasks',
        'providers.efforts',
      ].includes(method)
    )
      return []
    if (method === 'session.commands') return { commands: [], source: 'none' }
    if (method === 'session.workspace') return { path: null }
    if (method === 'files.index') return { paths: [] }
    if (method === 'git.turnDiff') return {}
    if (method === 'speech.status') return { ready: false }
    if (method === 'command.dispatch' && params?.command?.type === 'approval.respond') {
      if (params.command.optionId === 'deny' || params.command.decision === 'deny') {
        interactiveEvents.push(
          {
            type: 'approval.responded',
            approvalId: 'fixture-approval',
            decision: 'deny',
            optionId: 'deny',
          },
          {
            type: 'background.task.updated',
            taskId: 'call-replay',
            kind: 'subagent',
            label: 'Check event replay',
            status: 'stopped',
            detail: 'Synthetic check denied in replay',
          },
        )
        broadcast()
      } else navigateTo(frames.length)
      return { accepted: true }
    }
    if (method === 'session.stopChildren') {
      navigateTo(cursor)
      for (const name of ['navigation', 'replay'])
        interactiveEvents.push({
          type: 'background.task.updated',
          taskId: `call-${name}`,
          kind: 'subagent',
          label: name === 'navigation' ? 'Trace sidebar state' : 'Check event replay',
          status: 'stopped',
          detail: 'Stopped in synthetic replay',
        })
      broadcast()
      return { stopped: 2 }
    }
    throw new Error(`Offline fixture refuses ${method}`)
  },
  subscribe(id, receive) {
    subscribers.set(id, { receive })
    return () => {
      subscribers.delete(id)
    }
  },
}
document.documentElement.dataset.ariTheme = 'porcelain'
const parameters = new URLSearchParams(location.search)
function Preview() {
  const [position, setPosition] = useState(Number(parameters.get('at') ?? working))
  const [epoch, setEpoch] = useState(0)
  const [playing, setPlaying] = useState(false)
  cursor = position
  currentSessionId = `sess_native_fixture_${epoch}`
  navigateTo = (at) => {
    setPosition(at)
    setPlaying(false)
  }
  const seek = (at: number) => {
    if (interactiveEvents.length > 0) setEpoch((value) => value + 1)
    interactiveEvents = []
    if (at < position) setEpoch((value) => value + 1)
    navigateTo(at)
  }
  useEffect(() => broadcast(), [position, epoch])
  useEffect(() => {
    if (!playing) return
    const timer = setInterval(
      () =>
        setPosition((at) => {
          if (at >= frames.length) {
            setPlaying(false)
            return at
          }
          return at + 1
        }),
      650,
    )
    return () => clearInterval(timer)
  }, [playing])
  useEffect(() => {
    Object.assign(window, {
      __ari: {
        state: () => ({
          renderer: 'production SessionView',
          position,
          total: frames.length,
          playing,
          epoch,
          subscribers: [...subscribers.values()].map(({ name, sessionId }) => ({
            name,
            sessionId,
          })),
          viewport: { width: innerWidth, height: innerHeight },
        }),
      },
    })
  }, [position, playing, epoch])
  return (
    <div className="review-shell ari-frame">
      <Titlebar
        leading={<div className="review-brand">Ari</div>}
        leadingWidth={264}
        projectLabel="Native subagent review"
        usage={
          <span className="review-view-caption">Actual chat components · synthetic journal</span>
        }
      />
      <div className="review-workspace">
        <aside className="review-sidebar">
          <div className="review-aria ari-pixel">Aria</div>
          <div className="review-field-label">Qoder native agents</div>
          <div className="review-session">Sidebar streaming review</div>
          <div className="review-playback">
            <button
              data-action="replay"
              onClick={() => {
                if (playing) setPlaying(false)
                else {
                  interactiveEvents = []
                  setEpoch((v) => v + 1)
                  setPosition(0)
                  setPlaying(true)
                }
              }}
            >
              {playing ? 'Pause' : 'Replay'}
            </button>
            <button data-action="reset" onClick={() => seek(0)}>
              Reset
            </button>
            <span>
              {position}/{frames.length}
            </span>
          </div>
          <input
            type="range"
            aria-label="Replay position"
            min={0}
            max={frames.length}
            value={position}
            onChange={(event) => seek(Number(event.target.value))}
          />
          <div className="review-checkpoints">
            <button data-at="working" onClick={() => seek(working)}>
              Parallel work
            </button>
            <button data-at="approval" onClick={() => seek(needsYou)}>
              Child approval
            </button>
            <button data-at="finished" onClick={() => seek(frames.length)}>
              Results & failure
            </button>
          </div>
          <p className="review-inspector">
            Open an agent row or the child-session rail to inspect its own transcript. Eight reads
            and intermediate narration collapse into one activity group.
          </p>
          <p className="review-isolation">
            All prompts, paths, outputs and failures are synthetic. Buttons affect this replay only.
            The live SDK check is reported separately.
          </p>
        </aside>
        <main className="review-stage ari-stage">
          <SessionView
            key={epoch}
            sessionId={currentSessionId}
            defaults={{
              driverKind: 'qoder',
              modelId: 'default',
              permissionMode: 'ask',
              effort: null,
            }}
            onDefaultsChange={() => {}}
          />
        </main>
      </div>
    </div>
  )
}
createRoot(document.getElementById('root')!).render(
  <MotionProvider reducedMotion>
    <ToastProvider>
      <Preview />
    </ToastProvider>
  </MotionProvider>,
)

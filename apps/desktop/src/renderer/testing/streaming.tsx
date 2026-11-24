import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Search,
  Terminal,
  CircleAlert,
  ShieldCheck,
  Play,
  Pause,
  RotateCcw,
  SkipForward,
  ArrowDown,
  PanelLeft,
  FolderOpen,
} from 'lucide-react'
import { MotionProvider } from '@ari/ui/motion-provider'
import { ToastProvider } from '@ari/ui/toast'
import { Titlebar } from '../src/shell/Titlebar'
import { paneOriginLink } from '../src/features/session/ParentSessionLink'
import { Composer } from '../src/features/composer/Composer'
import { MarkdownBlock } from '../src/features/transcript/MarkdownBlock'
import { ToolCallDetails } from '../src/features/transcript/ToolCallDetails'
import { TranscriptView } from '../src/features/transcript/TranscriptView'
import { pushMessageParts, type Message, type MessagePart } from '@ari/contracts/message'
import {
  project,
  tally,
  readableOutput,
  type Tool,
  type Row,
  type ReplayEvent,
} from './streaming/model'
import { scenarios } from './streaming/fixtures'
import '@ari/ui/fonts'
import '../src/styles/index.css'
import '../src/features/transcript/transcript.css'
import './streaming/streaming.css'

/** Only a fixture bridge is installed. Never delegates to the desktop preload. */
window.ari = {
  async invoke(method) {
    await Promise.resolve()
    if (method === 'stream.subscribe' || method === 'stream.unsubscribe')
      return { subscribed: true }
    if (method === 'speech.status') return { ready: false }
    if (method === 'drafts.load') return { text: '' }
    if (method === 'window.toggleMaximize') return { maximized: false }
    throw new Error(`Offline review refuses RPC: ${method}`)
  },
  subscribe() {
    return () => {}
  },
}
document.documentElement.dataset.ariTheme = 'porcelain'
document.documentElement.dataset.ariReducedMotion = ''

/** Palette reconstruction is fixture-scoped; production tokens/fonts/composer are reused. */
const options = new URLSearchParams(location.search)
type Mode = 'before' | 'after' | 'source'
const initialMode = (options.get('view') ?? 'after') as Mode
const initialScenario =
  scenarios.find((scenario) => scenario.id === options.get('scenario')) ?? scenarios[0]!

function callBlock(tool: Tool) {
  return {
    kind: 'tool-call' as const,
    key: tool.key,
    role: 'assistant' as const,
    turnId: tool.turnId,
    callId: tool.callId,
    name: tool.name,
    argsJson: tool.args,
  }
}
function toolTarget(tool: Tool): string {
  try {
    const args = JSON.parse(tool.args) as Record<string, unknown>
    const input =
      typeof args.input === 'object' && args.input ? (args.input as Record<string, unknown>) : args
    const target =
      input.path ?? input.file_path ?? input.cmd ?? input.command ?? input.pattern ?? args.title
    return typeof target === 'string' ? target : tool.name
  } catch {
    return tool.name
  }
}
function nativeMessages(events: ReplayEvent[]): Message[] {
  const messages = new Map<string, Message>()
  for (const event of events) {
    let message = messages.get(event.turnId)
    if (!message) {
      message = {
        id: event.turnId,
        sessionId: 'offline-review',
        turnId: event.turnId,
        role: 'assistant',
        parts: [],
        createdAt: 1,
      }
      messages.set(event.turnId, message)
    }
    const parts: MessagePart[] = []
    if (event.type === 'narration') parts.push({ type: 'text', text: event.text })
    if (event.type === 'tool' && event.name)
      parts.push({
        type: 'tool-call',
        callId: event.callId,
        name: event.name,
        argsJson: event.args ?? '{}',
      })
    if (event.type === 'tool' && (event.status === 'completed' || event.status === 'failed'))
      parts.push({
        type: 'tool-result',
        callId: event.callId,
        resultJson: event.output ?? '',
        isError: event.status === 'failed',
      })
    if (event.type === 'diagnostic') parts.push({ type: 'text', text: `⚠ ${event.text}` })
    pushMessageParts(message.parts, parts)
  }
  return [...messages.values()]
}

function Output({ tool }: { tool: Tool }) {
  const [full, setFull] = useState(false)
  const [raw, setRaw] = useState(false)
  const text = raw ? tool.output : readableOutput(tool.output)
  const lines = text.split('\n')
  const shown = full ? text : lines.slice(0, 7).join('\n')
  const save = () => {
    const url = URL.createObjectURL(new Blob([tool.output], { type: 'text/plain' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${tool.callId}.txt`
    anchor.click()
    URL.revokeObjectURL(url)
  }
  return (
    <div className="review-output">
      <div className="review-output-bar">
        <span>
          {tool.status === 'running' ? 'Output so far' : 'Output'} · {lines.length} lines
        </span>
        <div>
          <button type="button" onClick={() => setRaw((value) => !value)} aria-pressed={raw}>
            {raw ? 'Readable output' : 'Raw output'}
          </button>
          <button type="button" onClick={() => void navigator.clipboard.writeText(tool.output)}>
            Copy exact
          </button>
          <button type="button" onClick={save}>
            Save
          </button>
        </div>
      </div>
      <pre className={full ? 'review-output-full' : ''} data-output={tool.callId}>
        {shown || (tool.status === 'running' ? 'No output received yet.' : 'No output supplied.')}
      </pre>
      {lines.length > 7 && (
        <button
          className="review-show-output"
          type="button"
          aria-expanded={full}
          onClick={() => setFull((value) => !value)}
        >
          {full ? 'Show less' : `Show all ${lines.length} lines`}
          <ChevronDown size={13} />
        </button>
      )}
      {raw && (
        <div className="review-raw-note">
          Raw output preserves escape sequences and carriage returns. Copy and Save always use the
          exact source string.
        </div>
      )}
    </div>
  )
}
function ToolDetails({ tool }: { tool: Tool }) {
  return (
    <div className="review-tool-details ari-tool-body">
      <div className="review-detail-meta">
        {tool.name}{' '}
        <span>
          Call {tool.callId} · {tool.observedStart ? 'start observed' : 'start not observed'}
        </span>
      </div>
      <ToolCallDetails call={callBlock(tool)} />
      <Output tool={tool} />
    </div>
  )
}
function ToolStep({ tool, initialOpen = false }: { tool: Tool; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen)
  const Icon = tool.category === 'read' ? FileText : tool.category === 'search' ? Search : Terminal
  const label = toolTarget(tool)
  return (
    <div className="review-step" data-call={tool.callId}>
      <button
        className="review-step-toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <ChevronRight size={13} className={open ? 'review-rotated' : ''} />
        <Icon size={14} />
        <span className="review-step-name">{label}</span>
        <span className={`review-state review-${tool.status}`}>
          {tool.status === 'unconfirmed' ? 'Outcome unknown' : tool.status}
        </span>
      </button>
      {open && <ToolDetails tool={tool} />}
    </div>
  )
}
function Activity({
  row,
  tools,
  connected,
}: {
  row: Extract<Row, { kind: 'activity' }>
  tools: Tool[]
  connected: boolean
}) {
  const [open, setOpen] = useState(options.get('details') === 'open')
  const running = tools.filter((tool) => tool.status === 'running')
  const failed = tools.filter((tool) => tool.status === 'failed')
  const cancelled = tools.filter((tool) => tool.status === 'cancelled')
  const completed = tools.filter((tool) => tool.status === 'completed')
  const unknown = tools.filter((tool) => tool.status === 'unconfirmed')
  const latest = tools.at(-1)
  const states = [
    running.length && `${running.length} running`,
    completed.length && `${completed.length} completed`,
    failed.length && `${failed.length} failed`,
    cancelled.length && `${cancelled.length} cancelled`,
    unknown.length && `${unknown.length} unknown`,
  ]
    .filter(Boolean)
    .join(' · ')
  const current = running.length
    ? running.map(toolTarget).join(' + ')
    : latest
      ? toolTarget(latest)
      : ''
  return (
    <section className="review-activity" data-group={row.key}>
      <button
        className="review-activity-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight size={15} className={open ? 'review-rotated' : ''} />
        <span className="review-activity-label">
          <strong>{tally(tools)}</strong>
          <span>
            {states}
            {!connected && running.length > 0 ? ' · connection lost' : ''}
          </span>
        </span>
        {running.length > 0 && (
          <span className="ari-status" data-status="working" aria-hidden="true" />
        )}
        <span className="review-details-label">{open ? 'Hide details' : 'Details'}</span>
      </button>
      <div className="review-current">
        {running.length ? 'Current' : 'Latest'}: <span>{current}</span>
        {running.length > 1 && <span> · {running.length} active tools</span>}
      </div>
      {failed.map((tool) => (
        <div className="review-failure" key={tool.key} role="status">
          <CircleAlert size={16} />
          <div>
            <strong>{tool.name} failed</strong>
            <p>
              {readableOutput(tool.output)
                .split('\n')
                .find((line) => /FAIL|Error|error|failed/.test(line)) ??
                'The provider reported a tool error.'}
            </p>
          </div>
          <button type="button" onClick={() => setOpen(true)}>
            Inspect failure
          </button>
        </div>
      ))}
      {open && (
        <div className="review-steps">
          {tools.map((tool) => (
            <ToolStep key={tool.key} tool={tool} initialOpen={tool.status === 'failed'} />
          ))}
        </div>
      )}
    </section>
  )
}

function Decision({
  row,
  answer,
}: {
  row: Extract<Row, { kind: 'decision' }>
  answer: (row: Extract<Row, { kind: 'decision' }>, value: string) => void
}) {
  return (
    <section
      className={`review-decision ${row.answer ? 'review-decision-resolved' : ''}`}
      data-decision={row.id}
    >
      <ShieldCheck size={18} />
      <div>
        <strong>
          {row.answer
            ? `Answered · ${row.answer}`
            : row.decisionKind === 'approval'
              ? 'Permission needed'
              : 'Your decision needed'}
        </strong>
        <p>{row.text}</p>
        {row.command && <code>{row.command}</code>}
        {!row.answer && (
          <div className="review-decision-buttons">
            {row.options.map((value) => (
              <button key={value} onClick={() => answer(row, value)}>
                {value}
              </button>
            ))}
          </div>
        )}
        {!row.answer && <small>Offline simulation · choices only update this replay.</small>}
      </div>
    </section>
  )
}

function Review() {
  const [scenarioId, setScenarioId] = useState(initialScenario.id)
  const scenario = scenarios.find((item) => item.id === scenarioId)!
  const [mode, setMode] = useState<Mode>(initialMode)
  const [cursor, setCursor] = useState(Number(options.get('at') ?? scenario.checkpoint))
  const [playing, setPlaying] = useState(false)
  const [extra, setExtra] = useState<ReplayEvent[]>([])
  const [reconnects, setReconnects] = useState(0)
  const [notice, setNotice] = useState('')
  const [following, setFollowing] = useState(true)
  const followingRef = useRef(true)
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const events = useMemo(
    () => scenario.events.slice(0, cursor).concat(extra),
    [scenario, cursor, extra],
  )
  const presentation = useMemo(() => project(events), [events])
  const messages = useMemo(() => nativeMessages(events), [events])
  const suspend = () => {
    followingRef.current = false
    setFollowing(false)
  }
  const follow = () => {
    followingRef.current = true
    setFollowing(true)
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight
  }
  useEffect(() => {
    if (!playing) return
    const timer = setInterval(
      () =>
        setCursor((value) => {
          if (value >= scenario.events.length) {
            setPlaying(false)
            return value
          }
          return value + 1
        }),
      650,
    )
    return () => clearInterval(timer)
  }, [playing, scenario])
  useLayoutEffect(() => {
    const element = content.current
    if (!element) return
    const observer = new ResizeObserver(() => {
      if (followingRef.current && scroller.current)
        scroller.current.scrollTop = scroller.current.scrollHeight
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [mode])
  const chooseScenario = (id: string) => {
    const next = scenarios.find((item) => item.id === id)!
    setScenarioId(id)
    setCursor(next.checkpoint)
    setExtra([])
    setPlaying(false)
    setReconnects(0)
    follow()
  }
  const reset = () => {
    setCursor(0)
    setExtra([])
    setPlaying(false)
    setReconnects(0)
    follow()
  }
  const answer = (row: Extract<Row, { kind: 'decision' }>, value: string) => {
    setExtra((previous) =>
      previous.concat({
        type: 'resolved',
        id: row.id,
        turnId: row.turnId,
        answer: value,
        seq: scenario.events.length + previous.length,
      }),
    )
    setNotice(`Simulated answer: ${value}`)
  }
  const reconnect = () => {
    setExtra((previous) => previous.concat(scenario.events.slice(0, cursor)))
    setReconnects((value) => value + 1)
    setNotice(
      'Replayed the same journal sequence. Tools and counts stay unchanged. No provider callback was restored.',
    )
  }
  const exportEvents = () => {
    const url = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify(
            { scenario: scenario.id, provenance: scenario.provenance, events },
            null,
            2,
          ),
        ],
        { type: 'application/json' },
      ),
    )
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${scenario.id}-events.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }
  useEffect(() => {
    Object.assign(window, {
      __ari: {
        state: () => ({
          scenario: scenario.id,
          mode,
          cursor,
          total: scenario.events.length,
          playing,
          following: followingRef.current,
          reconnects,
          uniqueEvents: presentation.uniqueEvents,
          deliveredEvents: events.length,
          rows: presentation.rows.map((row) => ({
            kind: row.kind,
            key: row.key,
            count: row.kind === 'activity' ? row.toolKeys.length : undefined,
          })),
          tools: [...presentation.tools.values()].map((tool) => ({
            id: tool.callId,
            key: tool.key,
            status: tool.status,
            category: tool.category,
            outputLines: tool.output.split('\n').length,
          })),
          connected: presentation.connected,
          settled: presentation.settled,
          scrollTop: scroller.current?.scrollTop,
          viewport: { width: innerWidth, height: innerHeight },
          notice,
        }),
      },
    })
  }, [scenario, mode, cursor, playing, reconnects, presentation, events, notice])
  const totalTools = presentation.tools.size
  const pendingDecision = presentation.rows.find(
    (row): row is Extract<Row, { kind: 'decision' }> => row.kind === 'decision' && !row.answer,
  )
  return (
    <div className="review-shell ari-frame" data-review-mode={mode}>
      <Titlebar
        leading={
          <div className="review-brand">
            Ari <PanelLeft size={15} />
          </div>
        }
        leadingWidth={264}
        projectLabel="Ari"
        usage={
          <span className="review-view-caption">
            {mode === 'before'
              ? 'BEFORE · reference reconstruction'
              : mode === 'source'
                ? 'CURRENT SOURCE · existing TranscriptView'
                : 'AFTER · proposed activity presentation'}
          </span>
        }
      />
      <div className="review-workspace">
        <aside className="review-sidebar" aria-label="Review controls">
          <button className="review-aria">
            <span className="ari-pixel">Aria</span>
          </button>
          <div className="review-project">
            <FolderOpen size={15} /> Ari <ChevronDown size={13} />
          </div>
          <div className="review-session">
            <span className="ari-status" data-status="working" /> Improve streaming presentation
          </div>
          <div className="review-sidebar-rule" />
          <label className="review-field-label" htmlFor="scenario">
            Replay scenario
          </label>
          <select
            id="scenario"
            value={scenarioId}
            onChange={(event) => chooseScenario(event.target.value)}
          >
            {scenarios.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          <div className="review-view-tabs" role="group" aria-label="Presentation">
            <button
              data-view="before"
              aria-pressed={mode === 'before'}
              onClick={() => setMode('before')}
            >
              Before
            </button>
            <button
              data-view="after"
              aria-pressed={mode === 'after'}
              onClick={() => setMode('after')}
            >
              After
            </button>
            <button
              data-view="source"
              aria-pressed={mode === 'source'}
              onClick={() => setMode('source')}
            >
              Source
            </button>
          </div>
          <div className="review-playback">
            <button
              data-action="play"
              title={playing ? 'Pause replay' : 'Replay from beginning'}
              onClick={() => {
                if (!playing && cursor >= scenario.checkpoint) {
                  setCursor(0)
                  setExtra([])
                }
                setPlaying((value) => !value)
              }}
            >
              {playing ? <Pause size={16} /> : <Play size={16} />}
            </button>
            <button data-action="reset" title="Reset" onClick={reset}>
              <RotateCcw size={15} />
            </button>
            <button
              data-action="step"
              title="Next event"
              onClick={() => setCursor((value) => Math.min(value + 1, scenario.events.length))}
            >
              <SkipForward size={15} />
            </button>
            <span>
              {cursor} / {scenario.events.length}
            </span>
          </div>
          <input
            aria-label="Replay position"
            type="range"
            min="0"
            max={scenario.events.length}
            value={cursor}
            onChange={(event) => {
              setCursor(Number(event.target.value))
              setExtra([])
              setPlaying(false)
            }}
          />
          <div className="review-checkpoints">
            <button
              data-action="checkpoint"
              onClick={() => {
                setCursor(scenario.checkpoint)
                setPlaying(false)
                setExtra([])
              }}
            >
              Main checkpoint
            </button>
            <button
              data-action="finish"
              onClick={() => {
                setCursor(scenario.events.length)
                setPlaying(false)
                setExtra([])
              }}
            >
              End
            </button>
            <button data-action="reconnect" onClick={reconnect}>
              Reconnect / replay
            </button>
            <button data-action="export" onClick={exportEvents}>
              Export events
            </button>
          </div>
          <details className="review-provenance">
            <summary>Fixture provenance</summary>
            <p>{scenario.provenance}</p>
            <p>
              Before and After share event IDs and the same cursor. Source uses the existing
              renderer’s representable message parts. No hidden reasoning is displayed.
            </p>
            <p>
              Lavender palette and sidebar are reconstructions. Titlebar, Geist fonts,
              MarkdownBlock, tool arguments and Composer are existing Ari components.
            </p>
          </details>
          <div className="review-inspector">
            <span>{scenario.harness}</span>
            <strong>
              {totalTools} tools · {presentation.uniqueEvents} events
            </strong>
            <p>
              {notice ||
                'Expand a tool, scroll up, or reconnect while replaying to check stability.'}
            </p>
          </div>
          <span className="review-isolation">Offline fixture · no agent executes</span>
        </aside>
        <main className="review-stage ari-stage">
          <div className={paneOriginLink}>Started by Aria</div>
          {mode === 'source' ? (
            <div className="review-source">
              <TranscriptView
                messages={messages}
                sessionId="offline-review"
                running={!presentation.settled}
              />
            </div>
          ) : (
            <div
              ref={scroller}
              className="review-scroller ari-scroll"
              role="log"
              aria-label="Conversation transcript"
              aria-live="off"
              onWheel={(event) => {
                if (event.deltaY < 0) suspend()
              }}
              onScroll={() => {
                const el = scroller.current
                if (el && el.scrollHeight - el.clientHeight - el.scrollTop > 36) suspend()
              }}
              onClickCapture={(event) => {
                if ((event.target as HTMLElement).closest('button')) suspend()
              }}
            >
              <div ref={content} className="review-chat ari-chat-column">
                {presentation.rows.map((row) => (
                  <div key={row.key} data-row-key={row.key}>
                    {row.kind === 'narration' && (
                      <div className="review-narration">
                        <MarkdownBlock text={row.text} streaming={playing} />
                      </div>
                    )}
                    {row.kind === 'activity' &&
                      (mode === 'after' ? (
                        <Activity
                          row={row}
                          tools={row.toolKeys.map((key) => presentation.tools.get(key)!)}
                          connected={presentation.connected}
                        />
                      ) : (
                        row.toolKeys.map((key) => {
                          const tool = presentation.tools.get(key)!
                          return (
                            <details className="review-before-tool" key={key}>
                              <summary>
                                <span>
                                  {tool.category === 'command'
                                    ? 'Ran 1 command'
                                    : tool.category === 'read'
                                      ? 'Read 1 file'
                                      : tool.category === 'search'
                                        ? 'Searched 1 time'
                                        : tool.name}
                                </span>
                                <ChevronRight size={14} />
                              </summary>
                              <ToolDetails tool={tool} />
                            </details>
                          )
                        })
                      ))}
                    {row.kind === 'decision' && <Decision row={row} answer={answer} />}
                    {row.kind === 'diagnostic' && (
                      <div className="review-diagnostic">
                        <CircleAlert size={16} />
                        {row.text}
                      </div>
                    )}
                  </div>
                ))}
                {!events.length && (
                  <p className="review-empty">
                    Replay paused at the beginning. Press Play or Next event.
                  </p>
                )}
              </div>
            </div>
          )}
          {!presentation.connected && (
            <div className="review-connection">
              Connection lost · tool outcomes are not yet known. Reconnect does not imply
              completion.
            </div>
          )}
          <div className="review-jump-slot">
            {pendingDecision && (
              <button
                className="review-attention-link"
                data-action="review-decision"
                onClick={() => {
                  suspend()
                  document
                    .querySelector(`[data-decision="${pendingDecision.id}"]`)
                    ?.scrollIntoView({ block: 'nearest' })
                }}
              >
                <ShieldCheck size={14} />
                {pendingDecision.decisionKind === 'approval'
                  ? 'Permission needed'
                  : 'Your decision needed'}{' '}
                · Review request
              </button>
            )}
            {(!following || mode === 'before') && (
              <button data-action="latest" onClick={follow}>
                <ArrowDown size={14} />
                Jump to latest{!following && playing ? ' · new activity' : ''}
              </button>
            )}
          </div>
          <div className="review-composer ari-chat-column">
            <Composer
              sessionId="streaming-offline-review"
              running={!presentation.settled}
              onSend={() => setNotice('Offline composer: message was not submitted.')}
              onStop={() => {
                setPlaying(false)
                setNotice('Replay paused. No live session was stopped.')
              }}
            />
          </div>
          <div className="review-bottom-status" role="status">
            {playing
              ? 'Replaying activity'
              : presentation.settled
                ? 'Replay finished'
                : 'Replay paused'}{' '}
            · {totalTools} tools{!following ? ' · following paused' : ''}
          </div>
        </main>
      </div>
    </div>
  )
}
createRoot(document.getElementById('root')!).render(
  <MotionProvider reducedMotion>
    <ToastProvider>
      <Review />
    </ToastProvider>
  </MotionProvider>,
)

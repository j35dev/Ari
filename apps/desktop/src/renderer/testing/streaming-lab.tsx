import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  ArrowDown,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FileText,
  FolderOpen,
  List,
  MessageSquare,
  PanelLeft,
  PanelRight,
  Pause,
  Play,
  RotateCcw,
  Search,
  ShieldCheck,
  SkipForward,
  Terminal,
  X,
} from 'lucide-react'
import { MotionProvider } from '@ari/ui/motion-provider'
import { ToastProvider } from '@ari/ui/toast'
import { Composer } from '../src/features/composer/Composer'
import { MarkdownBlock } from '../src/features/transcript/MarkdownBlock'
import { ToolCallDetails } from '../src/features/transcript/ToolCallDetails'
import { Titlebar } from '../src/shell/Titlebar'
import { paneOriginLink } from '../src/features/session/ParentSessionLink'
import {
  project,
  readableOutput,
  tally,
  type Tool,
  type Row,
  type ReplayEvent,
} from './streaming/model'
import { scenarios } from './streaming/fixtures'
import { attentionCheckpoint, labScenario, liveCheckpoint } from './streaming/lab-fixture'
import { research } from './streaming/research'
import '@ari/ui/fonts'
import '../src/styles/index.css'
import '../src/features/transcript/transcript.css'
import './streaming/streaming.css'
import './streaming/lab.css'

window.ari = {
  async invoke(method) {
    await Promise.resolve()
    if (method === 'stream.subscribe' || method === 'stream.unsubscribe')
      return { subscribed: true }
    if (method === 'speech.status') return { ready: false }
    if (method === 'drafts.load') return { text: '' }
    throw new Error(`Offline design lab refuses ${method}`)
  },
  subscribe() {
    return () => {}
  },
}
document.documentElement.dataset.ariTheme = 'porcelain'
document.documentElement.dataset.ariReducedMotion = ''
const params = new URLSearchParams(location.search)
type Layout = 'quiet' | 'split' | 'outline' | 'before'
const layouts = [
  {
    id: 'quiet',
    name: 'Quiet thread',
    description: 'Conversation first. Detail when you need it.',
    icon: MessageSquare,
  },
  {
    id: 'split',
    name: 'Conversation + work log',
    description: 'Keep the conversation and execution separate.',
    icon: PanelRight,
  },
  {
    id: 'outline',
    name: 'Inline work outline',
    description: 'See the sequence without a stack of cards.',
    icon: List,
  },
] as const
const allScenarios = [labScenario, ...scenarios]
const initialScenario =
  allScenarios.find((item) => item.id === params.get('scenario')) ?? labScenario

export function targetOf(tool: Tool): string {
  try {
    const args = JSON.parse(tool.args) as Record<string, unknown>
    const input =
      typeof args.input === 'object' && args.input ? (args.input as Record<string, unknown>) : args
    const value =
      input.cmd ?? input.command ?? input.path ?? input.file_path ?? input.pattern ?? args.title
    return typeof value === 'string' ? value : tool.name
  } catch {
    return tool.name
  }
}
const shortTarget = (tool: Tool) =>
  tool.category === 'read'
    ? (targetOf(tool).split(/[\\/]/).at(-1) ?? targetOf(tool))
    : targetOf(tool)
const IconFor = ({ tool }: { tool: Tool }) =>
  tool.category === 'read' ? (
    <FileText size={14} />
  ) : tool.category === 'search' ? (
    <Search size={14} />
  ) : (
    <Terminal size={14} />
  )
const statusName = (tool: Tool) => (tool.status === 'unconfirmed' ? 'Outcome unknown' : tool.status)
const stateCount = (tools: Tool[]) =>
  tools.filter((tool) => tool.status !== 'running' && tool.status !== 'unconfirmed').length

function Detail({
  tool,
  preference,
  updatePreference,
}: {
  tool: Tool
  preference: { raw: boolean; expanded: boolean }
  updatePreference: (value: { raw: boolean; expanded: boolean }) => void
}) {
  const { raw, expanded } = preference
  let text = tool.output
  if (!raw) {
    try {
      const value: unknown = JSON.parse(text)
      if (typeof value === 'string') text = value
    } catch {
      /* Already text. */
    }
    text = readableOutput(text)
  }
  const lines = text.split('\n')
  const preview =
    tool.status === 'failed'
      ? lines.slice(-8).join('\n')
      : tool.status === 'running'
        ? lines.slice(-6).join('\n')
        : lines.slice(0, 6).join('\n')
  const save = () => {
    const url = URL.createObjectURL(new Blob([tool.output], { type: 'text/plain' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `${tool.callId}.txt`
    link.click()
    URL.revokeObjectURL(url)
  }
  return (
    <div className="lab-detail" data-detail={tool.callId}>
      <div className="lab-detail-title">
        <IconFor tool={tool} />
        <strong>{shortTarget(tool)}</strong>
        <span className={`lab-call-status is-${tool.status}`}>{statusName(tool)}</span>
      </div>
      <div className="lab-detail-id">
        {tool.name} · Call {tool.callId}
      </div>
      <div className="lab-arguments ari-tool-body">
        <ToolCallDetails
          call={{
            kind: 'tool-call',
            key: tool.key,
            role: 'assistant',
            callId: tool.callId,
            name: tool.name,
            argsJson: tool.args,
          }}
        />
      </div>
      <div className="lab-output-head">
        <span>
          {tool.status === 'running' ? 'Live output' : 'Output'} · {tool.output ? lines.length : 0}{' '}
          lines
        </span>
        <button aria-pressed={raw} onClick={() => updatePreference({ ...preference, raw: !raw })}>
          {raw ? 'Readable' : 'Raw'}
        </button>
        <button onClick={() => void navigator.clipboard.writeText(tool.output)}>Copy exact</button>
        <button onClick={save}>Save</button>
      </div>
      <pre data-output={tool.callId} className={expanded ? 'lab-output expanded' : 'lab-output'}>
        {(expanded ? text : preview) || 'No output received yet.'}
      </pre>
      {lines.length > 6 && (
        <button
          className="lab-expand-output"
          aria-expanded={expanded}
          onClick={() => updatePreference({ ...preference, expanded: !expanded })}
        >
          {expanded ? 'Show less' : `Show all ${lines.length} lines`}
          <ChevronDown size={13} />
        </button>
      )}
    </div>
  )
}

function Log({
  tools,
  selected,
  select,
  close,
  open,
}: {
  tools: Tool[]
  selected: string | null
  select: (key: string) => void
  close: () => void
  open: boolean
}) {
  const [filter, setFilter] = useState('all')
  const [preferences, setPreferences] = useState<
    Record<string, { raw: boolean; expanded: boolean }>
  >({})
  const selectedTool = tools.find((tool) => tool.key === selected)
  const visible = tools.filter((tool) => filter === 'all' || tool.status === filter)
  return (
    <aside className={`lab-log ${open ? 'is-open' : ''}`} aria-label="Work log">
      <header>
        <span>
          <List size={15} />
          Work log
        </span>
        <button aria-label="Close work log" data-action="close-log" onClick={close}>
          <X size={15} />
        </button>
      </header>
      <div className="lab-log-meta">
        {stateCount(tools)} settled · {tools.length} actions received
      </div>
      <div className="lab-log-filters">
        <button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
          All
        </button>
        <button aria-pressed={filter === 'running'} onClick={() => setFilter('running')}>
          Running {tools.filter((t) => t.status === 'running').length}
        </button>
        <button aria-pressed={filter === 'failed'} onClick={() => setFilter('failed')}>
          Failed {tools.filter((t) => t.status === 'failed').length}
        </button>
      </div>
      <div className="lab-log-list">
        {visible.map((tool, index) => (
          <button
            className={`lab-log-call ${selected === tool.key ? 'selected' : ''}`}
            data-log-call={tool.callId}
            key={tool.key}
            onClick={() => select(tool.key)}
          >
            <span className="lab-call-index">{index + 1}</span>
            <IconFor tool={tool} />
            <span className="lab-log-label">
              <strong>{shortTarget(tool)}</strong>
              <small>{tool.name}</small>
            </span>
            <span className={`lab-call-dot is-${tool.status}`} title={statusName(tool)}>
              {tool.status === 'completed' ? (
                <Check size={12} />
              ) : tool.status === 'failed' ? (
                <CircleAlert size={13} />
              ) : tool.status === 'running' ? (
                <span className="lab-running-dot" />
              ) : (
                <span>–</span>
              )}
            </span>
          </button>
        ))}
        {!visible.length && (
          <p className="lab-log-empty">No {filter === 'all' ? '' : filter} calls received.</p>
        )}
      </div>
      {selectedTool ? (
        <Detail
          key={selectedTool.key}
          tool={selectedTool}
          preference={preferences[selectedTool.key] ?? { raw: false, expanded: false }}
          updatePreference={(value) =>
            setPreferences((previous) => ({ ...previous, [selectedTool.key]: value }))
          }
        />
      ) : (
        <div className="lab-log-hint">
          Select an action to inspect its exact arguments and output.
        </div>
      )}
      <div className="lab-log-foot">
        Ordered by first start. Results update their original action.
      </div>
    </aside>
  )
}

function Attention({
  row,
  answer,
}: {
  row: Extract<Row, { kind: 'decision' }>
  answer: (row: Extract<Row, { kind: 'decision' }>, value: string) => void
}) {
  return (
    <div className={`lab-decision ${row.answer ? 'resolved' : ''}`} data-decision={row.id}>
      <ShieldCheck size={16} />
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
          <div className="lab-choice-row">
            {row.options.map((value) => (
              <button key={value} onClick={() => answer(row, value)}>
                {value}
              </button>
            ))}
            <small>Fixture simulation</small>
          </div>
        )}
      </div>
    </div>
  )
}
function Failure({ tool, inspect }: { tool: Tool; inspect: (key: string) => void }) {
  return (
    <div className="lab-failure" data-failure={tool.callId}>
      <CircleAlert size={15} />
      <div>
        <strong>{tool.category === 'command' ? 'Command failed' : `${tool.name} failed`}</strong>
        <code>{targetOf(tool)}</code>
      </div>
      <button onClick={() => inspect(tool.key)}>
        Inspect <ArrowUpRight size={13} />
      </button>
    </div>
  )
}

function Activity({
  row,
  tools,
  layout,
  inspect,
  selected,
  pauseFollowing,
}: {
  row: Extract<Row, { kind: 'activity' }>
  tools: Tool[]
  layout: Layout
  inspect: (key: string) => void
  selected: string | null
  pauseFollowing: () => void
}) {
  const active = tools.filter((tool) => tool.status === 'running')
  const failed = tools.filter((tool) => tool.status === 'failed')
  const [showAll, setShowAll] = useState(false)
  const title = tally(tools)
  if (layout === 'before')
    return (
      <div>
        {tools.map((tool) => (
          <button className="lab-before-call" key={tool.key} onClick={() => inspect(tool.key)}>
            {tool.category === 'command'
              ? 'Ran 1 command'
              : tool.category === 'read'
                ? 'Read 1 file'
                : tool.category === 'search'
                  ? 'Searched 1 time'
                  : tool.name}
            <ChevronRight size={14} />
          </button>
        ))}
      </div>
    )
  if (layout === 'split')
    return (
      <div className="lab-log-reference">
        <button onClick={() => inspect(tools[0]!.key)}>
          <List size={13} />
          {title}
          <ChevronRight size={12} />
        </button>
        {failed.map((tool) => (
          <Failure key={tool.key} tool={tool} inspect={inspect} />
        ))}
      </div>
    )
  if (layout === 'outline')
    return (
      <section className="lab-outline-group" data-group={row.key}>
        <div className="lab-outline-heading">
          <span className="lab-outline-marker" />
          {title}
          <span>
            {stateCount(tools)} / {tools.length} settled
          </span>
        </div>
        <div className="lab-outline-calls">
          {tools.map((tool) => (
            <button
              data-inline-call={tool.callId}
              key={tool.key}
              aria-pressed={selected === tool.key}
              onClick={() => inspect(tool.key)}
            >
              <IconFor tool={tool} />
              <span>{shortTarget(tool)}</span>
              <span className={`lab-call-status is-${tool.status}`}>{statusName(tool)}</span>
              {tool.status === 'running' ? (
                <span className="lab-running-dot" />
              ) : tool.status === 'completed' ? (
                <Check size={12} />
              ) : (
                <ChevronRight size={12} />
              )}
            </button>
          ))}
        </div>
        {failed.map((tool) => (
          <Failure key={tool.key} tool={tool} inspect={inspect} />
        ))}
      </section>
    )
  return (
    <section className="lab-quiet-activity" data-group={row.key}>
      <button
        className="lab-history-line"
        aria-expanded={showAll}
        onClick={() => {
          pauseFollowing()
          setShowAll((value) => !value)
        }}
      >
        <ChevronRight size={13} className={showAll ? 'rotated' : ''} />
        <span>{title}</span>
        <span className="lab-history-status">
          {active.length
            ? `${active.length} running`
            : failed.length
              ? `${failed.length} failed`
              : tools.some((tool) => tool.status === 'unconfirmed')
                ? 'Outcome unknown'
                : tools.some((tool) => tool.status === 'cancelled')
                  ? 'Cancelled'
                  : 'Completed'}
        </span>
      </button>
      {showAll && (
        <div className="lab-inline-list">
          {tools.map((tool) => (
            <button key={tool.key} onClick={() => inspect(tool.key)}>
              <IconFor tool={tool} />
              <span>{shortTarget(tool)}</span>
              <span className={`lab-call-status is-${tool.status}`}>{statusName(tool)}</span>
            </button>
          ))}
        </div>
      )}
      {active.length > 0 && (
        <div className="lab-active-steps">
          {active.map((tool) => (
            <button key={tool.key} onClick={() => inspect(tool.key)}>
              <span className="lab-running-dot" />
              <span className="lab-active-verb">
                {tool.category === 'read'
                  ? 'Reading'
                  : tool.category === 'search'
                    ? 'Searching'
                    : 'Running'}
              </span>
              <code>{shortTarget(tool)}</code>
              <ArrowUpRight size={12} />
            </button>
          ))}
        </div>
      )}
      {failed.map((tool) => (
        <Failure key={tool.key} tool={tool} inspect={inspect} />
      ))}
    </section>
  )
}

function Lab() {
  const [scenarioId, setScenarioId] = useState(initialScenario.id)
  const scenario = allScenarios.find((item) => item.id === scenarioId)!
  const [layout, setLayout] = useState<Layout>((params.get('layout') ?? 'quiet') as Layout)
  const [cursor, setCursor] = useState(Number(params.get('at') ?? scenario.checkpoint))
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(300)
  const [extra, setExtra] = useState<ReplayEvent[]>([])
  const [logOpen, setLogOpen] = useState(layout === 'split' || params.get('log') === 'open')
  const [selected, setSelected] = useState<string | null>(() => {
    if (layout !== 'split') return null
    const initial = [
      ...project(
        initialScenario.events.slice(0, Number(params.get('at') ?? initialScenario.checkpoint)),
      ).tools.values(),
    ]
    return initial.find((tool) => tool.status === 'running')?.key ?? initial[0]?.key ?? null
  })
  const [viewportWidth, setViewportWidth] = useState(innerWidth)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const [following, setFollowing] = useState(true)
  const followingRef = useRef(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const anchorRef = useRef<{ key: string; offset: number } | null>(null)
  const events = useMemo(
    () => scenario.events.slice(0, cursor).concat(extra),
    [scenario, cursor, extra],
  )
  const presentation = useMemo(() => project(events), [events])
  const tools = [...presentation.tools.values()]
  const active = tools.filter((tool) => tool.status === 'running')
  const failures = tools.filter((tool) => tool.status === 'failed')
  const pending = presentation.rows.find(
    (row): row is Extract<Row, { kind: 'decision' }> => row.kind === 'decision' && !row.answer,
  )
  const rememberAnchor = () => {
    const scroll = scrollRef.current
    if (!scroll) return
    const top = scroll.getBoundingClientRect().top
    const row = Array.from(scroll.querySelectorAll<HTMLElement>('[data-row]')).find(
      (node) => node.getBoundingClientRect().bottom > top + 8,
    )
    if (row)
      anchorRef.current = { key: row.dataset.row!, offset: row.getBoundingClientRect().top - top }
  }
  const pauseFollow = () => {
    followingRef.current = false
    setFollowing(false)
    rememberAnchor()
  }
  const follow = () => {
    anchorRef.current = null
    followingRef.current = true
    setFollowing(true)
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }
  const inspect = (key: string) => {
    pauseFollow()
    setSelected(key)
    setLogOpen(true)
  }
  const setPosition = (position: number) => {
    setPlaying(false)
    setCursor(position)
    setExtra([])
  }
  const changeLayout = (value: Layout) => {
    rememberAnchor()
    setLayout(value)
    setLogOpen(value === 'split')
    if (value === 'split' && !selected) setSelected(active[0]?.key ?? tools[0]?.key ?? null)
  }
  const chooseScenario = (id: string) => {
    const next = allScenarios.find((item) => item.id === id)!
    setScenarioId(id)
    setCursor(next.checkpoint)
    setExtra([])
    setSelected(null)
    setPlaying(false)
    follow()
  }
  const answer = (row: Extract<Row, { kind: 'decision' }>, value: string) =>
    setExtra((previous) =>
      previous.concat({
        seq: scenario.events.length + previous.length,
        turnId: row.turnId,
        type: 'resolved',
        id: row.id,
        answer: value,
      }),
    )
  const replay = () => {
    if (playing) setPlaying(false)
    else {
      setCursor(0)
      setExtra([])
      follow()
      setPlaying(true)
    }
  }
  useEffect(() => {
    const resize = () => setViewportWidth(innerWidth)
    addEventListener('resize', resize)
    return () => removeEventListener('resize', resize)
  }, [])
  const reconnect = () => {
    setExtra((previous) => previous.concat(scenario.events.slice(0, cursor)))
    setNotice('Replayed the same journal. Counts, selected details and narration remain unchanged.')
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
      speed,
    )
    return () => clearInterval(timer)
  }, [playing, speed, scenario])
  useLayoutEffect(() => {
    const scroll = scrollRef.current
    const inner = innerRef.current
    if (!scroll || !inner) return
    const preserve = () => {
      if (followingRef.current) scroll.scrollTop = scroll.scrollHeight
      else if (anchorRef.current) {
        const anchor = anchorRef.current
        const node = Array.from(inner.querySelectorAll<HTMLElement>('[data-row]')).find(
          (item) => item.dataset.row === anchor.key,
        )
        if (node)
          scroll.scrollTop +=
            node.getBoundingClientRect().top - scroll.getBoundingClientRect().top - anchor.offset
      }
    }
    preserve()
    const observer = new ResizeObserver(preserve)
    observer.observe(inner)
    return () => observer.disconnect()
  }, [layout])
  useEffect(() => {
    Object.assign(window, {
      __ari: {
        state: () => ({
          fixture: 'Ari streaming design lab v2',
          layout,
          scenario: scenario.id,
          cursor,
          total: scenario.events.length,
          playing,
          following: followingRef.current,
          logOpen,
          selected,
          sourcesOpen,
          deliveredEvents: events.length,
          uniqueEvents: presentation.uniqueEvents,
          connected: presentation.connected,
          settled: presentation.settled,
          active: active.map((tool) => tool.callId),
          failed: failures.map((tool) => tool.callId),
          pending: pending?.id ?? null,
          tools: tools.map((tool) => ({
            key: tool.key,
            id: tool.callId,
            status: tool.status,
            category: tool.category,
            outputLines: tool.output.split('\n').length,
          })),
          rows: presentation.rows.map((row) => ({ key: row.key, kind: row.kind })),
          scrollTop: scrollRef.current?.scrollTop,
          viewport: { width: innerWidth, height: innerHeight },
          notice,
        }),
      },
    })
  }, [
    layout,
    scenario,
    cursor,
    playing,
    logOpen,
    selected,
    sourcesOpen,
    events,
    presentation,
    active,
    failures,
    pending,
    tools,
    notice,
  ])
  const workLabel = !presentation.connected
    ? 'Connection lost'
    : pending
      ? 'Needs your response'
      : presentation.settled
        ? 'Finished'
        : active.length
          ? active.length === 1
            ? `${active[0]!.category === 'read' ? 'Reading' : active[0]!.category === 'search' ? 'Searching' : 'Running'} ${shortTarget(active[0]!)}`
            : `${active.length} actions running`
          : 'Waiting for the next update'
  return (
    <div className="review-shell lab-shell" data-layout={layout}>
      <Titlebar
        leading={
          <div className="review-brand">
            Ari
            <PanelLeft size={15} />
          </div>
        }
        leadingWidth={viewportWidth <= 700 ? 162 : viewportWidth <= 1150 ? 220 : 264}
        projectLabel="Ari"
        usage={
          <span className="lab-top-label">
            Streaming design lab ·{' '}
            {layout === 'before'
              ? 'Reference reconstruction'
              : layouts.find((item) => item.id === layout)?.name}
          </span>
        }
      />
      <div className="review-workspace">
        <aside className="review-sidebar lab-sidebar">
          <div className="review-aria">
            <span className="ari-pixel">Aria</span>
          </div>
          <div className="review-project">
            <FolderOpen size={15} />
            Ari
            <ChevronDown size={13} />
          </div>
          <div className="review-session">
            <span className="lab-running-dot" />
            Streaming presentation
          </div>
          <div className="lab-control-heading">Explore the layouts</div>
          {layouts.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                data-layout-choice={item.id}
                className={`lab-layout-choice ${layout === item.id ? 'selected' : ''}`}
                onClick={() => changeLayout(item.id)}
              >
                <Icon size={15} />
                <span>
                  <strong>{item.name}</strong>
                  <small>{item.description}</small>
                </span>
                {layout === item.id && <Check size={12} />}
              </button>
            )
          })}
          <button
            className="lab-before-link"
            data-layout-choice="before"
            onClick={() => changeLayout('before')}
          >
            Compare isolated tool rows
            <ArrowUpRight size={12} />
          </button>
          <div className="lab-control-heading">Replay the same events</div>
          <select
            id="lab-scenario"
            value={scenarioId}
            onChange={(event) => chooseScenario(event.target.value)}
          >
            {allScenarios.map((item) => (
              <option value={item.id} key={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          <div className="lab-replay-controls">
            <button data-action="play" onClick={replay}>
              {playing ? <Pause size={14} /> : <Play size={14} />}
              {playing ? 'Pause' : 'Replay'}
            </button>
            <button
              aria-label="Reset replay"
              data-action="reset"
              onClick={() => {
                setPosition(0)
                follow()
              }}
            >
              <RotateCcw size={14} />
            </button>
            <button
              aria-label="Next event"
              data-action="step"
              onClick={() => setPosition(Math.min(cursor + 1, scenario.events.length))}
            >
              <SkipForward size={14} />
            </button>
            <span>
              {cursor}/{scenario.events.length}
            </span>
          </div>
          <input
            aria-label="Replay position"
            type="range"
            min="0"
            max={scenario.events.length}
            value={cursor}
            onChange={(event) => setPosition(Number(event.target.value))}
          />
          <div className="lab-checkpoints">
            <button
              data-action="live"
              onClick={() =>
                setPosition(scenarioId === labScenario.id ? liveCheckpoint : scenario.checkpoint)
              }
            >
              Working
            </button>
            <button
              data-action="attention"
              onClick={() =>
                setPosition(
                  scenarioId === labScenario.id ? attentionCheckpoint : scenario.checkpoint,
                )
              }
            >
              Needs you
            </button>
            <button data-action="end" onClick={() => setPosition(scenario.events.length)}>
              Finished
            </button>
          </div>
          <div className="lab-utility-row">
            <button data-action="reconnect" onClick={reconnect}>
              Replay / reconnect
            </button>
            <select
              aria-label="Replay speed"
              value={speed}
              onChange={(event) => setSpeed(Number(event.target.value))}
            >
              <option value={300}>1×</option>
              <option value={150}>2×</option>
              <option value={650}>Slow</option>
            </select>
          </div>
          <button
            className="lab-sources-button"
            data-action="sources"
            onClick={() => setSourcesOpen(true)}
          >
            What I researched
            <ArrowUpRight size={13} />
          </button>
          <p className="lab-provenance">{scenario.provenance}</p>
          <p className="lab-local-note">
            Offline fixture. No provider executes.
            <br />
            Same event sequence in every layout.
          </p>
        </aside>
        <main className="review-stage ari-stage lab-stage">
          <div className="lab-session-heading">
            <div className={paneOriginLink}>Started by Aria</div>
            <button
              className="lab-open-log"
              data-action="open-log"
              onClick={() => {
                setLogOpen((value) => !value)
                if (!selected) setSelected(active[0]?.key ?? tools[0]?.key ?? null)
              }}
            >
              <List size={14} />
              Work log <span>{tools.length}</span>
            </button>
          </div>
          <div className={`lab-body ${layout === 'split' && logOpen ? 'with-log' : ''}`}>
            <div className="lab-conversation">
              <div
                className="lab-transcript ari-scroll"
                ref={scrollRef}
                role="log"
                aria-label="Conversation transcript"
                aria-live="off"
                onWheel={(event) => {
                  if (event.deltaY < 0) pauseFollow()
                }}
                onScroll={() => {
                  const scroll = scrollRef.current
                  if (scroll && scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop > 40) {
                    if (followingRef.current) pauseFollow()
                    else rememberAnchor()
                  }
                }}
              >
                <div className="lab-chat" ref={innerRef}>
                  <div className="lab-task-prompt">
                    <span>You</span>
                    <p>
                      {scenarioId === labScenario.id
                        ? 'Trace why the sidebar project list can go stale. Check the update path and verify it with the focused tests.'
                        : `Replay the recorded or synthetic event fixture: ${scenario.label}.`}
                    </p>
                  </div>
                  <div className="lab-assistant-label">
                    <span className="lab-agent-mark">A</span>
                    <span>Ari</span>
                    <small>{scenario.harness}</small>
                  </div>
                  {presentation.rows.map((row) => (
                    <div key={row.key} data-row={row.key} className={`lab-row row-${row.kind}`}>
                      {row.kind === 'narration' && (
                        <div className="lab-prose">
                          <MarkdownBlock text={row.text} streaming={playing} />
                        </div>
                      )}
                      {row.kind === 'activity' && (
                        <Activity
                          row={row}
                          tools={row.toolKeys.map((key) => presentation.tools.get(key)!)}
                          layout={layout}
                          inspect={inspect}
                          selected={selected}
                          pauseFollowing={pauseFollow}
                        />
                      )}
                      {row.kind === 'decision' && <Attention row={row} answer={answer} />}
                      {row.kind === 'diagnostic' && (
                        <div className="lab-diagnostic">
                          <CircleAlert size={15} />
                          {row.text}
                        </div>
                      )}
                    </div>
                  ))}
                  {!events.length && (
                    <p className="lab-empty">
                      Replay is starting. The same narration and tool events will arrive in this
                      layout.
                    </p>
                  )}
                  {presentation.settled && (
                    <div className="lab-finished">
                      <Check size={14} />
                      {tools.length} actions received ·{' '}
                      {failures.length
                        ? `${failures.length} failed attempts preserved`
                        : 'all results available'}
                      <button
                        onClick={() => {
                          setLogOpen(true)
                          setSelected(tools[0]?.key ?? null)
                        }}
                      >
                        Review work
                      </button>
                    </div>
                  )}
                </div>
              </div>
              <div
                className={`lab-work-status ${pending ? 'needs-you' : ''} ${!presentation.connected ? 'disconnected' : ''}`}
                role="status"
              >
                <span>
                  {pending ? (
                    <ShieldCheck size={15} />
                  ) : presentation.settled ? (
                    <Check size={14} />
                  ) : (
                    <span className="lab-running-dot" />
                  )}
                </span>
                <strong>{workLabel}</strong>
                <span className="lab-work-tally">
                  {stateCount(tools)} settled{active.length ? ` · ${active.length} active` : ''}
                </span>
                {pending ? (
                  <button
                    data-action="review-decision"
                    onClick={() => {
                      pauseFollow()
                      document
                        .querySelector(`[data-decision="${pending.id}"]`)
                        ?.scrollIntoView({ block: 'nearest' })
                    }}
                  >
                    Review request
                    <ArrowUpRight size={12} />
                  </button>
                ) : !following ? (
                  <button data-action="latest" onClick={follow}>
                    <ArrowDown size={13} />
                    Jump to latest
                  </button>
                ) : (
                  <button onClick={() => setLogOpen(true)}>
                    Details
                    <ChevronRight size={12} />
                  </button>
                )}
              </div>
              <div className="lab-composer">
                <Composer
                  sessionId="streaming-design-lab"
                  running={!presentation.settled}
                  onSend={() =>
                    setNotice('Fixture-only message. Nothing was submitted to an agent.')
                  }
                  onStop={() => {
                    setPlaying(false)
                    setNotice('Replay paused. No live agent was stopped.')
                  }}
                />
              </div>
            </div>
            <Log
              open={logOpen}
              tools={tools}
              selected={selected}
              select={inspect}
              close={() => setLogOpen(false)}
            />
          </div>
          {sourcesOpen && (
            <aside className="lab-research" aria-label="Research sources">
              <header>
                <div>
                  <strong>Research, not replicas</strong>
                  <p>Patterns checked on 23 Nov 2026. Ari keeps its own shell and typography.</p>
                </div>
                <button
                  aria-label="Close research"
                  data-action="close-sources"
                  onClick={() => setSourcesOpen(false)}
                >
                  <X size={17} />
                </button>
              </header>
              {research.map((source, index) => (
                <article key={source.url}>
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <div>
                    <a href={source.url} target="_blank" rel="noreferrer">
                      {source.product}
                      <ArrowUpRight size={12} />
                    </a>
                    <small>{source.kind}</small>
                    <p>{source.note}</p>
                  </div>
                </article>
              ))}
            </aside>
          )}
        </main>
      </div>
    </div>
  )
}
createRoot(document.getElementById('root')!).render(
  <MotionProvider reducedMotion>
    <ToastProvider>
      <Lab />
    </ToastProvider>
  </MotionProvider>,
)

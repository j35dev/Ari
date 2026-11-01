import { memo, useCallback, useId, useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Minus,
  TriangleAlert,
  X,
} from 'lucide-react'
import type { ResponseStyle } from '@ari/contracts/settings'
import { useHeldLive } from './ActivityBurst'
import { KIND_ICON } from './ActivityStep'
import { describeActivity, formatToolSummary } from './groupBlocks'
import { ImageGenerationActivity } from './ImageGenerationActivity'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCallDetails } from './ToolCallDetails'
import { ToolResultBody } from './ToolResultBody'
import { isImageGenerationCall } from './toolLabels'
import {
  foregroundResponseCall,
  responseToolInfo,
  responseToolState,
  responseToolStateLabels,
  toolKindLabels,
  type ResponseToolInfo,
  type ResponseToolState,
} from './response-presentation'
import type { ToolGroupRow, TranscriptBlock } from './types'

export type StyledResponse = Exclude<ResponseStyle, 'default'>

function StateMark({ state }: { state: ResponseToolState }) {
  if (state === 'running') return <span className="ari-response-live-dot" aria-hidden="true" />
  const Icon = state === 'failed' ? TriangleAlert : state === 'returned' ? Check : CircleHelp
  return <Icon size={12} aria-hidden="true" />
}

function resultFor(row: ToolGroupRow, call: TranscriptBlock): TranscriptBlock | undefined {
  return call.callId ? row.resultsByCallId.get(call.callId) : undefined
}

function ToolPreview({ info, state }: { info: ResponseToolInfo; state: ResponseToolState }) {
  return info.preview !== null ? (
    <pre className="ari-response-preview">{info.preview}</pre>
  ) : (
    <p className="ari-response-preview-note">
      {state === 'running'
        ? 'Waiting for tool output…'
        : state === 'unanswered'
          ? 'No result was received for this call.'
          : (info.hint ??
            (state === 'failed'
              ? 'This tool reported an error. Open its result for details.'
              : 'Result received. Open details to inspect it.'))}
    </p>
  )
}

function DiffStat({ info }: { info: ResponseToolInfo }) {
  if (!info.stat || (info.stat.added === 0 && info.stat.removed === 0)) return null
  return (
    <span className="ari-response-diffstat" title="Lines in the requested edit">
      +{info.stat.added} −{info.stat.removed}
    </span>
  )
}

/** Uses the original payload renderers, including copy, long output, diffs and MCP images. */
const SelectedToolDetails = memo(function SelectedToolDetails({
  call,
  result,
  turnRunning,
  onClose,
}: {
  call: TranscriptBlock
  result: TranscriptBlock | undefined
  turnRunning: boolean
  onClose: () => void
}) {
  const info = responseToolInfo(call, result)
  const state = responseToolState(result, turnRunning)
  return (
    <section
      className="ari-response-details"
      aria-label={`Tool details: ${info.title}`}
      data-tool-state={state}
    >
      <header className="ari-response-details-header">
        <div>
          <h4>{info.title}</h4>
          <span className="ari-response-state">
            <StateMark state={state} />
            {responseToolStateLabels[state]}
          </span>
        </div>
        <button
          type="button"
          className="ari-response-icon-button"
          aria-label="Close tool details"
          onClick={onClose}
        >
          <X size={15} />
        </button>
      </header>
      <div className="ari-response-details-body">
        {call.argsJson !== undefined ? (
          <ToolCallDetails call={call} />
        ) : (
          <p className="ari-response-empty-output">No input was provided.</p>
        )}
        {result?.resultJson !== undefined ? (
          result.resultJson.length > 0 ? (
            <ToolResultBody resultJson={result.resultJson} />
          ) : (
            <p className="ari-response-empty-output">The tool returned no output.</p>
          )
        ) : (
          <p className="ari-response-empty-output">
            {state === 'running' ? 'Waiting for tool output…' : 'No result was received.'}
          </p>
        )}
      </div>
    </section>
  )
})

/** A complete, source-ordered history remains available in every optional style. */
function ActivityHistory({
  row,
  turnRunning,
  onInspect,
}: {
  row: ToolGroupRow
  turnRunning: boolean
  onInspect: (call: TranscriptBlock, origin: HTMLButtonElement) => void
}) {
  const callIds = useMemo(
    () => new Set(row.calls.map((call) => call.callId).filter(Boolean)),
    [row.calls],
  )
  let ordinal = 0
  return (
    <ol className="ari-response-history" aria-label="Tool activity history">
      {row.blocks.map((block) => {
        if (block.kind === 'thinking')
          return (
            <li key={block.key}>
              <ThinkingBlock text={block.text ?? ''} compact />
            </li>
          )
        if (block.kind === 'tool-result') {
          // A resumed/imported transcript can contain a result without its call.
          // Keep that evidence too, instead of silently discarding it.
          if (block.callId && callIds.has(block.callId)) return null
          return (
            <li key={block.key} className="ari-response-orphan-result">
              <p>{block.isError ? 'Tool error' : 'Tool result'}</p>
              <ToolResultBody resultJson={block.resultJson ?? ''} />
            </li>
          )
        }
        if (block.kind !== 'tool-call') return null
        ordinal += 1
        const info = responseToolInfo(block, resultFor(row, block))
        const state = responseToolState(resultFor(row, block), turnRunning)
        const Icon = KIND_ICON[info.kind]
        return (
          <li key={block.key}>
            <button
              type="button"
              className="ari-response-history-step"
              data-tool-state={state}
              onClick={(event) => onInspect(block, event.currentTarget)}
              aria-label={`Inspect tool ${ordinal}: ${info.title}, ${responseToolStateLabels[state]}`}
            >
              <span className="ari-response-sequence" aria-hidden="true">
                {ordinal}
              </span>
              <Icon size={13} aria-hidden="true" />
              <span className="ari-response-history-title" title={info.title}>
                {info.title}
              </span>
              <span className="ari-response-history-hint">
                {info.hint ?? responseToolStateLabels[state]}
              </span>
              <StateMark state={state} />
            </button>
          </li>
        )
      })}
    </ol>
  )
}

/**
 * The four opt-in views share one controller and the original payload renderers.
 * No mock timings, inferred test counts, fabricated reasoning, or replacement
 * markdown pipeline. Default is deliberately not routed through this component.
 */
export function ResponseActivity({
  row,
  active,
  turnRunning,
  style,
  onExplore,
}: {
  row: ToolGroupRow
  active: boolean
  turnRunning: boolean
  style: StyledResponse
  onExplore?: () => void
}) {
  const live = useHeldLive(active)
  const [expandedOverride, setExpandedOverride] = useState<boolean | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [inspectedKey, setInspectedKey] = useState<string | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const originRef = useRef<HTMLButtonElement | null>(null)
  const summaryRef = useRef<HTMLButtonElement | null>(null)
  const id = useId()
  const expanded = expandedOverride ?? live
  const activity = useMemo(() => describeActivity(row, live), [row, live])
  const automatic = foregroundResponseCall(row, turnRunning)
  const selected = row.calls.find((call) => call.key === selectedKey)
  const foreground = style === 'signal' ? (selected ?? automatic) : automatic
  const result = foreground ? resultFor(row, foreground) : undefined
  const info = foreground ? responseToolInfo(foreground, result) : null
  const state = responseToolState(result, turnRunning)
  const inspected = row.calls.find((call) => call.key === inspectedKey)
  const errors = activity.summary.errors
  const received = row.calls.length - activity.summary.pending
  const summary = formatToolSummary(activity.summary)
  const title =
    row.calls.length === 0
      ? 'Tool results'
      : activity.summary.pending > 0 && !turnRunning
        ? 'Tool activity'
        : activity.label
  const windowSize = style === 'signal' ? 12 : style === 'margin' ? 4 : 6
  const start = Math.max(0, row.calls.length - windowSize)
  const visibleCalls = row.calls.slice(start)
  const hasImageProgress =
    active &&
    row.calls.length === 1 &&
    foreground !== undefined &&
    result === undefined &&
    isImageGenerationCall(foreground)

  const inspect = useCallback(
    (call: TranscriptBlock, origin: HTMLButtonElement) => {
      onExplore?.()
      originRef.current = origin
      setInspectedKey(call.key)
      setExpandedOverride(true)
    },
    [onExplore],
  )

  const closeDetails = useCallback(() => {
    setInspectedKey(null)
    const target = originRef.current?.isConnected ? originRef.current : summaryRef.current
    target?.focus({ preventScroll: true })
  }, [])

  const expandHistory = () => {
    onExplore?.()
    setHistoryOpen((open) => !open)
    // A reader inspecting the work owns its state, even after the turn settles.
    setExpandedOverride(true)
  }

  const select = (call: TranscriptBlock) => {
    onExplore?.()
    setSelectedKey(call.key)
    setExpandedOverride(true)
  }

  const StatusIcon =
    state === 'failed' ? TriangleAlert : state === 'unanswered' ? CircleHelp : Check
  const ToolIcon = info ? KIND_ICON[info.kind] : Check

  return (
    <section
      className="ari-response-activity"
      data-response-style={style}
      data-activity={live ? 'working' : 'settled'}
      data-has-error={errors > 0 || undefined}
    >
      <button
        ref={summaryRef}
        type="button"
        className="ari-response-summary"
        aria-expanded={expanded}
        aria-controls={`${id}-stage`}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} activity: ${title}${errors > 0 ? `, ${errors} failed` : ''}`}
        onClick={() => {
          onExplore?.()
          setExpandedOverride(!expanded)
          if (expanded) {
            setHistoryOpen(false)
            setInspectedKey(null)
          }
        }}
      >
        {live ? (
          <span className="ari-response-live-dot" aria-hidden="true" />
        ) : (
          <StatusIcon size={12} aria-hidden="true" />
        )}
        <span className="ari-response-summary-title" title={summary}>
          {expanded && style !== 'flow' ? 'Tool activity' : title}
        </span>
        <span className="ari-response-call-count">
          {row.calls.length} {row.calls.length === 1 ? 'call' : 'calls'}
        </span>
        {errors > 0 ? <span className="ari-response-error-count">{errors} failed</span> : null}
        <ChevronRight size={12} className="ari-response-summary-chevron" aria-hidden="true" />
      </button>

      {expanded ? (
        <div className="ari-response-stage" id={`${id}-stage`}>
          {hasImageProgress && foreground ? (
            <ImageGenerationActivity call={foreground} />
          ) : foreground && info ? (
            <>
              {style === 'signal' ? (
                <nav className="ari-response-event-strip" aria-label="Tool events">
                  {start > 0 ? (
                    <button
                      type="button"
                      className="ari-response-earlier"
                      onClick={expandHistory}
                      aria-label={`Show all activity, including ${start} earlier calls`}
                    >
                      +{start} earlier
                    </button>
                  ) : null}
                  {visibleCalls.map((call, index) => {
                    const tool = responseToolInfo(call, resultFor(row, call))
                    const toolState = responseToolState(resultFor(row, call), turnRunning)
                    const Icon = KIND_ICON[tool.kind]
                    return (
                      <button
                        type="button"
                        key={call.key}
                        className="ari-response-event"
                        data-tool-state={toolState}
                        aria-pressed={call.key === foreground.key}
                        aria-label={`Select tool ${start + index + 1}: ${tool.title}, ${responseToolStateLabels[toolState]}`}
                        onClick={() => select(call)}
                        title={tool.title}
                      >
                        <span>{toolKindLabels[tool.kind]}</span>
                        <span className="ari-response-sequence">{start + index + 1}</span>
                        <Icon size={12} aria-hidden="true" />
                        <StateMark state={toolState} />
                      </button>
                    )
                  })}
                </nav>
              ) : null}

              <div className="ari-response-stage-layout">
                <div className="ari-response-card-wrap">
                  <article
                    className="ari-response-tool-card"
                    data-tool-state={state}
                    key={foreground.key}
                  >
                    <header className="ari-response-card-header">
                      <div className="ari-response-card-heading">
                        <span className="ari-response-kind">
                          <ToolIcon size={13} aria-hidden="true" />
                          {toolKindLabels[info.kind]}
                        </span>
                        <h4 title={info.title}>{info.target || info.title}</h4>
                      </div>
                      <span className="ari-response-state">
                        <StateMark state={state} />
                        {responseToolStateLabels[state]}
                      </span>
                    </header>
                    <ToolPreview info={info} state={state} />
                    <footer className="ari-response-card-footer">
                      <DiffStat info={info} />
                      <span className="ari-response-result-hint">
                        {info.hint === info.preview ? null : info.hint}
                      </span>
                      <button
                        type="button"
                        className="ari-response-inspect"
                        onClick={(event) => inspect(foreground, event.currentTarget)}
                        aria-label={`Inspect ${info.title}`}
                      >
                        Open details
                        <ArrowUpRight size={13} aria-hidden="true" />
                      </button>
                    </footer>
                  </article>
                </div>

                {style === 'margin' ? (
                  <aside className="ari-response-annotations" aria-label="Tool annotations">
                    {visibleCalls.map((call, index) => {
                      const tool = responseToolInfo(call, resultFor(row, call))
                      const toolState = responseToolState(resultFor(row, call), turnRunning)
                      return (
                        <button
                          key={call.key}
                          type="button"
                          className="ari-response-annotation"
                          data-tool-state={toolState}
                          onClick={(event) => inspect(call, event.currentTarget)}
                          aria-label={`Inspect tool ${start + index + 1}: ${tool.title}`}
                        >
                          <span className="ari-response-sequence">[{start + index + 1}]</span>
                          <span className="ari-response-annotation-title" title={tool.title}>
                            {tool.target || tool.title}
                          </span>
                          <span className="ari-response-annotation-state">
                            <StateMark state={toolState} />
                            {toolState === 'returned'
                              ? (tool.hint ?? responseToolStateLabels[toolState])
                              : responseToolStateLabels[toolState]}
                          </span>
                        </button>
                      )
                    })}
                    {start > 0 ? (
                      <button
                        type="button"
                        className="ari-response-text-button"
                        onClick={expandHistory}
                      >
                        View {start} earlier calls
                      </button>
                    ) : null}
                  </aside>
                ) : style === 'signal' ? (
                  <div className="ari-response-counter">
                    <span>{received}</span>
                    <span>results received</span>
                    <span className="ari-response-counter-total">
                      {row.calls.length} calls observed
                    </span>
                  </div>
                ) : null}
              </div>

              {style === 'fold' ? (
                <nav className="ari-response-leaves" aria-label="Recent tool calls">
                  {visibleCalls.map((call) => {
                    const tool = responseToolInfo(call, resultFor(row, call))
                    const Icon = KIND_ICON[tool.kind]
                    return (
                      <button
                        key={call.key}
                        type="button"
                        className="ari-response-leaf"
                        title={tool.title}
                        onClick={(event) => inspect(call, event.currentTarget)}
                        aria-label={`Inspect ${tool.title}`}
                      >
                        <Icon size={12} aria-hidden="true" />
                        <span>{tool.target || tool.title}</span>
                        <DiffStat info={tool} />
                      </button>
                    )
                  })}
                  {start > 0 ? (
                    <button
                      type="button"
                      className="ari-response-text-button"
                      onClick={expandHistory}
                    >
                      +{start} earlier
                    </button>
                  ) : null}
                </nav>
              ) : null}
              {style === 'signal' && selected ? (
                <button
                  type="button"
                  className="ari-response-follow"
                  onClick={() => {
                    onExplore?.()
                    setSelectedKey(null)
                  }}
                >
                  <ArrowDown size={11} aria-hidden="true" />
                  Follow current tool
                </button>
              ) : null}
            </>
          ) : (
            <p className="ari-response-preview-note">
              Tool results are available in the activity history.
            </p>
          )}
        </div>
      ) : null}

      {expanded || historyOpen ? (
        <button
          type="button"
          className="ari-response-history-toggle"
          aria-expanded={historyOpen}
          aria-controls={`${id}-history`}
          onClick={expandHistory}
        >
          {historyOpen ? (
            <Minus size={11} aria-hidden="true" />
          ) : (
            <ChevronDown size={11} aria-hidden="true" />
          )}
          {historyOpen ? 'Hide activity history' : 'Show all activity'}
        </button>
      ) : null}
      {historyOpen ? (
        <div id={`${id}-history`}>
          <ActivityHistory row={row} turnRunning={turnRunning} onInspect={inspect} />
        </div>
      ) : null}
      {inspected ? (
        <SelectedToolDetails
          key={inspected.key}
          call={inspected}
          result={resultFor(row, inspected)}
          turnRunning={turnRunning}
          onClose={closeDetails}
        />
      ) : null}
    </section>
  )
}

import { createContext, useContext } from 'react'
import { ChevronRight } from 'lucide-react'
import type { BackgroundTask } from '@ari/contracts/background-task'
import { ElapsedSeconds, formatElapsed } from '../moment'
import { reportSnippet } from './report-snippet'
import type { SubagentCallRow } from './types'

/** What the transcript knows of the session's native sub-agents, by the call that started each. */
export interface SubagentLinks {
  taskOf: (callId: string) => BackgroundTask | undefined
  /** Opens the sub-agent's own view; absent where there is none to open. */
  open?: (callId: string) => void
  providerLabel?: string
}

const NO_LINKS: SubagentLinks = { taskOf: () => undefined }
export const SubagentLinksContext = createContext<SubagentLinks>(NO_LINKS)

const STATUS_GLYPH: Record<BackgroundTask['status'], string> = {
  running: 'working',
  completed: 'done',
  failed: 'error',
  stopped: 'stopped',
}
const STATUS_WORD: Record<BackgroundTask['status'], string> = {
  running: 'working',
  completed: 'done',
  failed: 'failed',
  stopped: 'stopped',
}

interface CallArgs {
  description?: string
  subagentType?: string
}

function callArgs(argsJson: string | undefined): CallArgs {
  try {
    const parsed = JSON.parse(argsJson ?? '{}') as Record<string, unknown>
    // ACP wraps the tool input as `{ title, input }`.
    const input =
      parsed['input'] !== null && typeof parsed['input'] === 'object'
        ? (parsed['input'] as Record<string, unknown>)
        : parsed
    return {
      ...(typeof input['description'] === 'string' ? { description: input['description'] } : {}),
      ...(typeof input['subagent_type'] === 'string'
        ? { subagentType: input['subagent_type'] }
        : {}),
    }
  } catch {
    return {}
  }
}

/** A finished call's result text, unless it only says the agent went to the background. */
function callResult(resultJson: string | undefined): string | null {
  if (resultJson === undefined) return null
  let value: unknown
  try {
    value = JSON.parse(resultJson)
  } catch {
    return null
  }
  const text =
    typeof value === 'string'
      ? value
      : Array.isArray(value)
        ? value
            .map((block) =>
              block !== null && typeof block === 'object' && 'text' in block
                ? String((block as { text: unknown }).text)
                : '',
            )
            .join('\n')
        : ''
  return text.trim().length === 0 || /^Async agent launched/i.test(text.trim()) ? null : text
}

/**
 * The call that started a Claude sub-agent, as one compact row in the parent:
 * what it was sent to do, how it is going, how long it took and what it found.
 * The sub-agent's own work is in its view, which the row opens.
 */
export function SubagentRow({ row }: { row: SubagentCallRow }) {
  const { taskOf, open, providerLabel = 'Claude' } = useContext(SubagentLinksContext)
  const callId = row.call.callId ?? ''
  const task = taskOf(callId)
  const args = callArgs(row.call.argsJson)
  const title = task?.label || args.description || 'Subagent'
  const type = task?.subagentType ?? args.subagentType ?? null
  const status: BackgroundTask['status'] | null =
    task?.status ??
    (row.result
      ? row.result.isPartial
        ? 'running'
        : row.result.isError
          ? 'failed'
          : 'completed'
      : null)
  const result = task?.result ?? callResult(row.result?.resultJson)
  const said =
    status === 'running'
      ? task?.detail
        ? `▸ ${task.detail}`
        : 'working'
      : result
        ? reportSnippet(result)
        : status
          ? STATUS_WORD[status]
          : ''
  const body = (
    <>
      <span
        aria-hidden="true"
        className="ari-status"
        data-status={status ? STATUS_GLYPH[status] : 'idle'}
      />
      <span className="max-w-[42%] shrink-0 truncate font-medium text-fg">{title}</span>
      <span className="min-w-0 flex-1 truncate text-fg-muted" title={said || undefined}>
        {said}
      </span>
      <span className="flex shrink-0 items-center gap-2 text-xs text-fg-subtle">
        <span className="truncate">
          {type ? `${providerLabel} subagent · ${type}` : `${providerLabel} subagent`}
        </span>
        {task && status === 'running' ? (
          <ElapsedSeconds startedAt={task.startedAt} />
        ) : task && task.endedAt !== null ? (
          <span className="tabular-nums">
            {formatElapsed(Math.max(0, Math.floor((task.endedAt - task.startedAt) / 1000)))}
          </span>
        ) : null}
        {open ? <ChevronRight size={14} aria-hidden="true" /> : null}
      </span>
    </>
  )
  const className =
    'flex h-9 w-full min-w-0 items-center gap-2.5 rounded-md text-left text-[13.5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring'
  return (
    <div className="ari-burst my-1" data-activity={status === 'running' ? 'working' : 'settled'}>
      {open ? (
        <button
          type="button"
          onClick={() => open(callId)}
          aria-label={`Open ${providerLabel} subagent: ${title}`}
          className={`${className} -mx-1.5 w-[calc(100%+0.75rem)] px-1.5 transition-colors hover:bg-fg/5`}
        >
          {body}
        </button>
      ) : (
        <div className={className}>{body}</div>
      )}
    </div>
  )
}

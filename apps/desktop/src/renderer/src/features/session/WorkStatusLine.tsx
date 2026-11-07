import { useRef } from 'react'
import { GitBranch, Square } from 'lucide-react'
import type { ChildTask } from '@ari/contracts/agent-control'
import type { OrchestrationTask } from '@ari/contracts/orchestration'
import { isWorkLive, workState, workSummary } from './work-presentation'

const action =
  'shrink-0 rounded px-1 py-1 text-xs text-fg-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:opacity-40'

/** Current work, without adding another elevated surface to the conversation. */
export function WorkStatusLine({
  tasks,
  panelId = 'ari-work-panel',
  open,
  onOpen,
  onStopAll,
  stopping = false,
}: {
  tasks: readonly (ChildTask | OrchestrationTask)[]
  panelId?: string
  open: boolean
  onOpen: () => void
  onStopAll?: () => void
  stopping?: boolean
}) {
  const trigger = useRef<HTMLButtonElement>(null)
  if (tasks.length === 0) return null
  const attention = tasks.filter((task) => workState(task) === 'needs-you').length
  const failures = tasks.filter((task) => workState(task) === 'failed').length
  const live = tasks.some((task) =>
    'currentActivity' in task ? task.capabilities.stop : isWorkLive(workState(task)),
  )
  return (
    <div
      className="flex min-w-0 items-center gap-2 py-1.5 text-xs text-fg-subtle"
      data-orchestration-status
    >
      <GitBranch size={13} aria-hidden className="shrink-0" />
      <span className="min-w-0 flex-1 truncate" title={workSummary(tasks)}>
        {workSummary(tasks)}
      </span>
      <span role="status" className="sr-only">
        {[
          attention
            ? `${attention} ${attention === 1 ? 'agent needs' : 'agents need'} your decision`
            : '',
          failures ? `${failures} ${failures === 1 ? 'agent failed' : 'agents failed'}` : '',
        ]
          .filter(Boolean)
          .join('. ')}
      </span>
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onOpen}
        className={action}
      >
        Details
      </button>
      {live && onStopAll ? (
        <button
          type="button"
          disabled={stopping}
          onClick={onStopAll}
          className={action}
          aria-label="Stop all agents"
        >
          <span className="flex items-center gap-1">
            <Square size={10} aria-hidden />
            {stopping ? 'Stopping…' : 'Stop'}
          </span>
        </button>
      ) : null}
    </div>
  )
}

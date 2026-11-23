import { useMemo } from 'react'
import type { BackgroundTask } from '@ari/contracts/background-task'
import { pushMessageParts, type Message, type MessagePart } from '@ari/contracts/message'
import { cx, quietButton } from '../../lib/recipes'
import { ElapsedSeconds, formatElapsed, WorkingGlyph } from '../moment'
import { TranscriptView } from '../transcript'
import { ParentSessionLink } from './ParentSessionLink'

const STATUS_GLYPH: Record<BackgroundTask['status'], string> = {
  running: 'working',
  completed: 'done',
  failed: 'error',
  stopped: 'stopped',
}
const STATUS_WORD: Record<BackgroundTask['status'], string> = {
  running: 'Working',
  completed: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
}

/**
 * A sub-agent's transcript as messages: what it was asked, as a message from
 * the parent, then everything it did as one reply, ending in its result. Its
 * separate text messages stay separate paragraphs.
 */
export function subagentMessages(
  parentSessionId: string,
  taskId: string,
  task: BackgroundTask | undefined,
  parts: readonly MessagePart[],
): Message[] {
  const createdAt = task?.startedAt ?? 0
  const messages: Message[] = []
  if (task?.prompt)
    messages.push({
      id: `${taskId}:prompt`,
      sessionId: parentSessionId,
      turnId: null,
      role: 'user',
      origin: { kind: 'session', sessionId: parentSessionId },
      parts: [{ type: 'text', text: task.prompt }],
      createdAt,
    })
  const work: MessagePart[] = []
  const received: MessagePart[] = []
  pushMessageParts(received, parts)
  for (const part of received) {
    const last = work[work.length - 1]
    if (part.type === 'text' && last?.type === 'text')
      work[work.length - 1] = { type: 'text', text: `${last.text}\n\n${part.text}` }
    else work.push(part)
  }
  const lastText = [...work].reverse().find((part) => part.type === 'text')
  const result = task?.result?.trim()
  if (task?.status !== 'running' && result && !lastText?.text.trim().endsWith(result))
    work.push({ type: 'text', text: lastText ? `\n\n${result}` : result })
  if (work.length > 0)
    messages.push({
      id: `${taskId}:work`,
      sessionId: parentSessionId,
      turnId: taskId,
      role: 'assistant',
      parts: work,
      createdAt,
    })
  return messages
}

/**
 * A native sub-agent, opened from its parent: its own transcript with the
 * parent's transcript components, how it is going, and the way back. It is
 * read-only: steering messages go to its parent.
 */
export function SubagentView({
  parentSession,
  taskId,
  task,
  parts,
  onBack,
  onStop,
  stopping = false,
  chatStyle,
  providerLabel = 'Claude',
}: {
  parentSession: { id: string; title: string }
  taskId: string
  task: BackgroundTask | undefined
  parts: readonly MessagePart[]
  onBack: () => void
  /** Stops the session's running sub-agents; absent when there is nothing to stop. */
  onStop?: () => void
  stopping?: boolean
  chatStyle?: 'conversation' | 'terminal'
  providerLabel?: string
}) {
  const messages = useMemo(
    () => subagentMessages(parentSession.id, taskId, task, parts),
    [parentSession.id, taskId, task, parts],
  )
  const running = task?.status === 'running'
  const title = task?.label || 'Subagent'
  const facts = [task?.subagentType, task?.model].filter(
    (fact): fact is string => typeof fact === 'string' && fact.length > 0,
  )
  return (
    <div
      className="ari-session-canvas relative isolate flex h-full min-h-0 min-w-0 flex-1 flex-col"
      aria-label={`${providerLabel} subagent: ${title}`}
      role="region"
    >
      <ParentSessionLink parentSession={parentSession} onOpenSession={onBack} />
      <div className="ari-chat-column mt-1 flex h-9 shrink-0 items-center gap-2.5 px-3 text-[13.5px]">
        <span
          role="status"
          aria-label={task ? STATUS_WORD[task.status] : 'Unknown'}
          className="ari-status"
          data-status={task ? STATUS_GLYPH[task.status] : 'idle'}
        />
        <h2 className="min-w-0 truncate font-medium text-fg">{title}</h2>
        <span className="min-w-0 flex-1 truncate text-fg-subtle">
          {[`${providerLabel} subagent`, ...facts].join(' · ')}
        </span>
        <span className="flex shrink-0 items-center gap-2 text-xs text-fg-subtle">
          <span>{task ? STATUS_WORD[task.status] : null}</span>
          {task && running ? (
            <ElapsedSeconds startedAt={task.startedAt} />
          ) : task && task.endedAt !== null ? (
            <span className="tabular-nums">
              {formatElapsed(Math.max(0, Math.floor((task.endedAt - task.startedAt) / 1000)))}
            </span>
          ) : null}
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <TranscriptView
          sessionId={parentSession.id}
          messages={messages}
          running={running}
          chatStyle={chatStyle}
          sessionTitle={(id) => (id === parentSession.id ? parentSession.title : undefined)}
          onOpenSession={(id) => {
            if (id === parentSession.id) onBack()
          }}
          working={running ? <WorkingGlyph startedAt={task.startedAt} /> : null}
        />
      </div>
      <div className="ari-chat-column mb-3 flex shrink-0 items-center gap-3 px-3 text-[13px] text-fg-subtle">
        <p role="note" className="min-w-0 flex-1">
          Message the parent to steer this subagent.
        </p>
        {onStop && running ? (
          <button
            type="button"
            disabled={stopping}
            onClick={onStop}
            className={cx(quietButton, 'shrink-0')}
          >
            {stopping ? 'Stopping…' : 'Stop subagents'}
          </button>
        ) : null}
      </div>
    </div>
  )
}

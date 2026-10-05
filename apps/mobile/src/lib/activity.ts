import {
  describeToolCall,
  effectiveToolName,
  humanizeToolName,
  thoughtPreview,
  type ToolKind,
} from '@ari/ui/tool-labels'
import type { ConversationPart } from './conversation-parts'

export interface ActivityStep {
  key: string
  kind: ToolKind | 'thought'
  /** "Read", or "Reading" for the step in progress. */
  label: string
  /** The file, command or query acted on; a reasoning step's first line. */
  target: string
  input: string | null
  output: string | null
  failed: boolean
  /** A call whose result has not arrived. */
  pending: boolean
}

function readable(json: string): string {
  try {
    const value: unknown = JSON.parse(json)
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  } catch {
    return json
  }
}

/**
 * A run of reasoning and tool parts as the steps a person would describe:
 * each call joined to its result and worded as the desktop words it. `live`
 * is whether the agent is still working on this run.
 */
export function activitySteps(parts: readonly ConversationPart[], live: boolean): ActivityStep[] {
  const steps: ActivityStep[] = []
  const calls = new Map<string, ActivityStep>()
  for (const { part, sourceIndex } of parts) {
    const key = String(sourceIndex)
    if (part.type === 'thinking') {
      steps.push({
        key,
        kind: 'thought',
        label: 'Thought',
        target: thoughtPreview(part.text),
        input: null,
        output: part.text,
        failed: false,
        pending: false,
      })
    } else if (part.type === 'tool-call') {
      const step: ActivityStep = {
        key,
        ...describe(part, false),
        input: readable(part.argsJson),
        output: null,
        failed: false,
        pending: true,
      }
      calls.set(part.callId, step)
      steps.push(step)
    } else if (part.type === 'tool-result') {
      const step = calls.get(part.callId)
      if (step === undefined)
        steps.push({
          key,
          kind: 'run',
          label: 'Result',
          target: '',
          input: null,
          output: readable(part.resultJson),
          failed: part.isError,
          pending: false,
        })
      else {
        step.output = readable(part.resultJson)
        step.failed = part.isError
        step.pending = false
      }
    }
  }
  if (live) {
    // Only the newest unanswered call is in progress; older ones were abandoned.
    const running = steps.findLast((step) => step.pending)
    const source = parts.find((entry) => String(entry.sourceIndex) === running?.key)?.part
    if (running !== undefined && source?.type === 'tool-call')
      Object.assign(running, describe(source, true))
  }
  return steps
}

function describe(
  part: { name: string; argsJson: string },
  live: boolean,
): Pick<ActivityStep, 'kind' | 'label' | 'target'> {
  const { kind, verb, target } = describeToolCall(part, live)
  return {
    kind,
    label: verb,
    target: target || humanizeToolName(effectiveToolName(part.name, part.argsJson)),
  }
}

/** "6 steps", and how many failed when any did. */
export function activitySummary(steps: readonly ActivityStep[]): string {
  const failed = steps.filter((step) => step.failed).length
  return `${steps.length} step${steps.length === 1 ? '' : 's'}${failed > 0 ? `, ${failed} failed` : ''}`
}

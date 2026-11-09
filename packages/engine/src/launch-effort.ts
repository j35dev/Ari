import { ControlFailure } from '@ari/contracts/agent-control'
import type { EffortSelection } from '@ari/contracts/project'

export interface LaunchEffortOption {
  id: string
  label?: string
  current?: boolean
}

const levels = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

function rank(id: string): number {
  const normalized = id.toLowerCase().replace(/[\s_-]/g, '')
  return levels.indexOf(
    normalized === 'extrahigh'
      ? 'xhigh'
      : normalized === 'med'
        ? 'medium'
        : normalized === 'off'
          ? 'none'
          : normalized,
  )
}

/** A conservative fallback; the coordinator can choose any advertised level explicitly. */
export function taskEffort(text = ''): 'low' | 'medium' | 'high' | 'xhigh' {
  if (
    text.length > 4000 ||
    /\b(architect(?:ure|ural)|migrat(?:e|ion)|concurren\w*|race condition|security|cross[ -](?:project|service)|end[ -]to[ -]end|comprehensive)\b/i.test(
      text,
    )
  )
    return 'xhigh'
  if (
    text.length < 300 &&
    /\b(typo|rename|format|extract|list|look up|lookup)\b/i.test(text) &&
    !/\b(implement|build|refactor|debug|diagnos\w*|investigate|regression|review|tests?)\b/i.test(
      text,
    )
  )
    return 'low'
  if (
    text.length > 1200 ||
    /\b(implement|build|refactor|debug|diagnos\w*|investigate|regression|review|fix)\b/i.test(text)
  )
    return 'high'
  return 'medium'
}

export function resolveLaunchEffort(input: {
  requested?: string | null
  baseline?: string | null
  baselineSource?: 'project' | 'inherited' | 'lead'
  text?: string
  options: readonly LaunchEffortOption[]
}): EffortSelection {
  const supported = input.options.map((option) => option.id)
  const result = (
    resolved: string | null,
    source: EffortSelection['source'],
    reason: string,
  ): EffortSelection => ({ resolved, source, reason, supported })
  if (input.requested === null)
    return result(
      null,
      'provider-default',
      'Explicitly requested the provider default; its effort is not controlled by Ari.',
    )
  const explicit = input.requested !== undefined && input.requested !== 'auto'
  if (explicit) {
    if (!supported.includes(input.requested!))
      throw new ControlFailure(
        'effort_unavailable',
        `Reasoning effort ${input.requested} is not supported by this provider/model. Supported efforts: ${supported.join(', ') || 'none advertised'}.`,
      )
    return result(input.requested!, 'explicit', 'Explicit requested effort takes priority.')
  }
  if (supported.length === 0)
    return result(
      null,
      'unsupported',
      'This provider/model advertises no configurable reasoning effort.',
    )
  const desired = taskEffort(input.text)
  const baseline =
    input.requested === 'auto'
      ? undefined
      : input.options.find((option) => option.id === input.baseline)
  const ranked = input.options
    .filter((option) => rank(option.id) >= 0)
    .sort((a, b) => rank(a.id) - rank(b.id))
  const target = Math.max(rank(desired), baseline ? rank(baseline.id) : -1)
  const picked =
    ranked.find((option) => rank(option.id) >= target) ??
    ranked.at(-1) ??
    baseline ??
    input.options.find((option) => option.current) ??
    input.options[0]!
  const source = baseline?.id === picked.id ? (input.baselineSource ?? 'project') : 'task'
  return result(
    picked.id,
    source,
    `Task assessment selected ${desired}; resolved to advertised ${picked.id}${baseline ? ` with ${input.baselineSource ?? 'project'} effort ${baseline.id} as a minimum` : ''}${rank(picked.id) >= 0 && rank(picked.id) < rank(desired) ? ' (the model supports no higher effort)' : ''}.`,
  )
}

/**
 * Parsers and reply builders for ACP server→client requests that need a
 * human: Grok's `_x.ai/ask_user_question` / `exit_plan_mode`, standard
 * `elicitation/create`, and N-way permission prompts that are really
 * questions (pi's select/confirm). Kept pure so the adapter and tests share
 * one mapping onto Ari's `input-requested` payload.
 */

export const OTHER_LABEL = 'Other'

export interface QuestionOption {
  id: string
  label: string
  description?: string
}

export interface QuestionItem {
  id: string
  question: string
  header?: string
  options: QuestionOption[]
  multiSelect: boolean
}

export interface Questionnaire {
  kind: 'questionnaire' | 'plan-approval'
  questions: QuestionItem[]
  planContent?: string
}

const PERMISSION_KINDS = new Set(['allow_once', 'allow_always', 'reject_once', 'reject_always'])

export function isAskUserQuestionMethod(method: string): boolean {
  return method.toLowerCase().includes('ask_user_question')
}

export function isExitPlanModeMethod(method: string): boolean {
  return method.toLowerCase().includes('exit_plan_mode')
}

export function isInteractiveClientMethod(method: string): boolean {
  return method === 'elicitation/create' || isAskUserQuestionMethod(method) || isExitPlanModeMethod(method)
}

export function encodeQuestionnaire(payload: Questionnaire): string {
  return JSON.stringify(payload)
}

/** True when permission options are an N-way question, not allow/deny. */
export function isQuestionPermission(
  options: { kind?: string; optionId?: string; name?: string }[] | undefined,
): boolean {
  const list = options ?? []
  if (list.length === 0) return false
  return list.every((o) => typeof o.kind !== 'string' || !PERMISSION_KINDS.has(o.kind))
}

export function parseAskUserQuestions(params: unknown): QuestionItem[] {
  const obj = asRecord(params)
  if (obj === null) return []
  const raw = obj['questions']
  if (Array.isArray(raw) && raw.length > 0) {
    return raw.flatMap((item, i) => {
      const parsed = parseOneQuestion(item, i)
      return parsed === null ? [] : [parsed]
    })
  }
  const single = parseOneQuestion(obj, 0)
  if (single !== null && (single.question.length > 0 || single.options.length > 0)) return [single]
  const fallback = str(obj, 'prompt') || str(obj, 'message') || str(obj, 'text')
  if (fallback.length === 0) return []
  return [{ id: '0', question: fallback, options: [], multiSelect: false }]
}

export function parseElicitationForm(params: unknown): {
  message: string
  questions: QuestionItem[]
  url: boolean
} {
  const obj = asRecord(params)
  if (obj === null) return { message: '', questions: [], url: false }
  const mode = str(obj, 'mode')
  const message = str(obj, 'message')
  if (mode === 'url') return { message, questions: [], url: true }
  const schema = asRecord(obj['requestedSchema'])
  const properties = asRecord(schema?.['properties'])
  if (properties === null) {
    return {
      message,
      questions:
        message.length > 0 ? [{ id: 'response', question: message, options: [], multiSelect: false }] : [],
      url: false,
    }
  }
  const questions: QuestionItem[] = []
  for (const [id, spec] of Object.entries(properties)) {
    const field = asRecord(spec) ?? {}
    const enums = Array.isArray(field['enum'])
      ? field['enum'].filter((v): v is string => typeof v === 'string' && v.length > 0)
      : []
    const title = str(field, 'title') || str(field, 'description') || id
    const options =
      enums.length > 0
        ? enums.map((label, i) => ({ id: `${id}-${i}`, label }))
        : field['type'] === 'boolean'
          ? [
              { id: `${id}-yes`, label: 'Yes' },
              { id: `${id}-no`, label: 'No' },
            ]
          : []
    questions.push({
      id,
      question: title,
      header: id !== title ? id : undefined,
      options,
      multiSelect: false,
    })
  }
  return { message, questions, url: false }
}

export function parsePlanExit(params: unknown): { planContent: string; toolCallId: string | null } {
  const obj = asRecord(params)
  if (obj === null) return { planContent: '', toolCallId: null }
  const nested = asRecord(obj['input']) ?? asRecord(obj['plan'])
  const planContent =
    str(obj, 'planContent') ||
    str(obj, 'plan_content') ||
    str(obj, 'content') ||
    (nested !== null ? str(nested, 'planContent') || str(nested, 'content') || str(nested, 'text') : '')
  const toolCallId = str(obj, 'toolCallId') || str(obj, 'tool_call_id')
  return { planContent, toolCallId: toolCallId.length > 0 ? toolCallId : null }
}

export function questionsFromPermission(
  title: string,
  options: { optionId?: string; name?: string }[] | undefined,
): QuestionItem[] {
  const choices = (options ?? []).flatMap((o, i) => {
    const label = typeof o.name === 'string' && o.name.length > 0 ? o.name : (o.optionId ?? '')
    if (label.length === 0) return []
    return [{ id: o.optionId ?? `opt-${i}`, label }]
  })
  return [
    {
      id: 'choice',
      question: title.length > 0 ? title : 'Choose an option',
      options: choices,
      multiSelect: false,
    },
  ]
}

export function replyAskUser(questions: QuestionItem[], value: string): unknown {
  return {
    outcome: 'accepted',
    answers: remapAnswers(questions, value, (q) => q.question),
    partial_answers: {},
  }
}

export function replyAskUserCancelled(): unknown {
  return { outcome: 'cancelled' }
}

export function replyElicitation(questions: QuestionItem[], value: string): unknown {
  return { action: 'accept', content: remapAnswers(questions, value, (q) => q.id) }
}

export function replyElicitationCancel(): unknown {
  return { action: 'cancel' }
}

export function replyPlanExit(value: string): unknown {
  const trimmed = value.trim()
  if (trimmed === 'approved' || trimmed === 'abandoned') return { outcome: trimmed }
  try {
    const parsed = JSON.parse(trimmed) as { outcome?: unknown; feedback?: unknown }
    if (parsed.outcome === 'approved' || parsed.outcome === 'abandoned') {
      return { outcome: parsed.outcome }
    }
    if (parsed.outcome === 'cancelled') {
      const feedback = typeof parsed.feedback === 'string' ? parsed.feedback.trim() : ''
      return feedback.length > 0 ? { outcome: 'cancelled', feedback } : { outcome: 'cancelled' }
    }
  } catch {
    // Free-text "request changes" feedback.
  }
  return trimmed.length > 0 ? { outcome: 'cancelled', feedback: trimmed } : { outcome: 'cancelled' }
}

export function replyPermissionChoice(
  options: { optionId?: string; name?: string }[] | undefined,
  value: string,
): unknown {
  const list = options ?? []
  const answers = parseAnswerMap(value)
  const chosen = answers['choice'] ?? Object.values(answers)[0] ?? value
  const match = list.find((o) => o.optionId === chosen || o.name === chosen)
  if (match?.optionId !== undefined) {
    return { outcome: { outcome: 'selected', optionId: match.optionId } }
  }
  return { outcome: { outcome: 'cancelled' } }
}

export function replyPermissionCancelled(): unknown {
  return { outcome: { outcome: 'cancelled' } }
}

function remapAnswers(
  questions: QuestionItem[],
  value: string,
  keyOf: (q: QuestionItem) => string,
): Record<string, string> {
  const byId = parseAnswerMap(value)
  const out: Record<string, string> = {}
  if (questions.length === 0) return out
  for (const question of questions) {
    const raw = byId[question.id] ?? byId[question.question] ?? (questions.length === 1 ? value : undefined)
    if (raw === undefined || raw.length === 0) continue
    out[keyOf(question)] = raw
  }
  return out
}

function parseAnswerMap(value: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(value)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>
      const answers = obj['answers']
      const source =
        answers !== null && typeof answers === 'object' && !Array.isArray(answers)
          ? (answers as Record<string, unknown>)
          : obj
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(source)) {
        if (typeof v === 'string') out[k] = v
        else if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === 'string').join(', ')
      }
      return out
    }
  } catch {
    // Plain string answer.
  }
  return {}
}

function parseOneQuestion(raw: unknown, index: number): QuestionItem | null {
  if (typeof raw === 'string') {
    const question = raw.trim()
    if (question.length === 0) return null
    return { id: String(index), question, options: [], multiSelect: false }
  }
  const obj = asRecord(raw)
  if (obj === null) return null
  const question =
    str(obj, 'question') || str(obj, 'prompt') || str(obj, 'text') || str(obj, 'header') || str(obj, 'title')
  const id = str(obj, 'id') || str(obj, 'questionId') || str(obj, 'question_id') || String(index)
  const header = str(obj, 'header')
  const multiSelect = obj['multiSelect'] === true || obj['multi_select'] === true
  const options = parseOptions(obj['options'] ?? obj['choices'])
  if (question.length === 0 && options.length === 0) return null
  return {
    id,
    question: question.length > 0 ? question : `Question ${index + 1}`,
    ...(header.length > 0 && header !== question ? { header } : {}),
    options,
    multiSelect,
  }
}

function parseOptions(raw: unknown): QuestionOption[] {
  if (!Array.isArray(raw)) return []
  const out: QuestionOption[] = []
  for (const [i, item] of raw.entries()) {
    if (typeof item === 'string') {
      const label = item.trim()
      if (label.length > 0) out.push({ id: `opt-${i}`, label })
      continue
    }
    const obj = asRecord(item)
    if (obj === null) continue
    const label = str(obj, 'label') || str(obj, 'name') || str(obj, 'text') || str(obj, 'title') || str(obj, 'value')
    if (label.length === 0) continue
    const description = str(obj, 'description') || str(obj, 'preview')
    out.push({
      id: str(obj, 'id') || `opt-${i}`,
      label,
      ...(description.length > 0 ? { description } : {}),
    })
  }
  return out
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function str(obj: Record<string, unknown>, key: string): string {
  const v = obj[key]
  return typeof v === 'string' ? v.trim() : ''
}

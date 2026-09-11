/** Shared shape for one option inside a questionnaire. */
export interface QuestionOption {
  id: string
  label: string
  /** What gets submitted instead of the label, when an agent distinguishes them. */
  value?: string
  description?: string
}

/** One question the agent is asking. */
export interface QuestionItem {
  id: string
  question: string
  header?: string
  options: QuestionOption[]
  multiSelect: boolean
  /** The schema property a typed "Other" answer has to be sent to, if any. */
  customId?: string
}

export type QuestionPayload =
  | { kind: 'free-text'; prompt: string }
  | { kind: 'choices'; prompt: string; choices: string[] }
  | { kind: 'questionnaire'; prompt: string; questions: QuestionItem[] }
  | { kind: 'plan-approval'; prompt: string; planContent: string }

/**
 * Reads `input.requested.choicesJson`. Legacy payloads are a JSON string
 * array; ACP/Ari Core send `{ kind, questions, planContent }`.
 */
export function parseQuestionPayload(prompt: string, choicesJson: string | null): QuestionPayload {
  if (choicesJson == null || choicesJson === '') return { kind: 'free-text', prompt }
  try {
    const parsed: unknown = JSON.parse(choicesJson)
    if (Array.isArray(parsed)) {
      const strings = parsed.filter((choice): choice is string => typeof choice === 'string')
      if (strings.length === parsed.length && strings.length > 0) {
        return { kind: 'choices', prompt, choices: strings }
      }
      return { kind: 'free-text', prompt }
    }
    if (parsed !== null && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>
      if (obj['kind'] === 'plan-approval') {
        return {
          kind: 'plan-approval',
          prompt,
          planContent: typeof obj['planContent'] === 'string' ? obj['planContent'] : '',
        }
      }
      const raw = obj['questions']
      if (Array.isArray(raw) && raw.length > 0) {
        const questions = raw.flatMap((item, i) => {
          const q = asQuestion(item, i)
          return q === null ? [] : [q]
        })
        if (questions.length > 0) return { kind: 'questionnaire', prompt, questions }
      }
    }
  } catch {
    return { kind: 'free-text', prompt }
  }
  return { kind: 'free-text', prompt }
}

function asQuestion(raw: unknown, index: number): QuestionItem | null {
  if (raw === null || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const question = typeof obj['question'] === 'string' ? obj['question'].trim() : ''
  const options = asOptions(obj['options'])
  // A question with choices but no text is still a question — the panel can
  // ask it. Only a wholly empty entry is dropped.
  if (question.length === 0 && options.length === 0) return null
  const header = typeof obj['header'] === 'string' ? obj['header'].trim() : ''
  const id = typeof obj['id'] === 'string' && obj['id'].length > 0 ? obj['id'] : String(index)
  const customId = typeof obj['customId'] === 'string' ? obj['customId'].trim() : ''
  return {
    id,
    question: question.length > 0 ? question : `Question ${index + 1}`,
    ...(header.length > 0 ? { header } : {}),
    options,
    multiSelect: obj['multiSelect'] === true,
    ...(customId.length > 0 ? { customId } : {}),
  }
}

function asOptions(raw: unknown): QuestionOption[] {
  if (!Array.isArray(raw)) return []
  const out: QuestionOption[] = []
  for (const [i, item] of raw.entries()) {
    if (typeof item === 'string' && item.trim().length > 0) {
      out.push({ id: `opt-${i}`, label: item.trim() })
      continue
    }
    if (item === null || typeof item !== 'object') continue
    const obj = item as Record<string, unknown>
    const label = typeof obj['label'] === 'string' ? obj['label'].trim() : ''
    if (label.length === 0) continue
    const description = typeof obj['description'] === 'string' ? obj['description'].trim() : ''
    const value = typeof obj['value'] === 'string' ? obj['value'].trim() : ''
    out.push({
      id: typeof obj['id'] === 'string' && obj['id'].length > 0 ? obj['id'] : `opt-${i}`,
      label,
      ...(value.length > 0 && value !== label ? { value } : {}),
      ...(description.length > 0 ? { description } : {}),
    })
  }
  return out
}

/** What an option submits: its value when the agent set one, else its label. */
export function optionValue(option: QuestionOption): string {
  return option.value ?? option.label
}

/**
 * Encode a questionnaire answer map for `input.respond`.
 *
 * Answers arrive keyed by question id, but a question whose agent offered a
 * separate "Other" property has to send typed text to *that* property — the
 * agent reads it first, and free text under the choice key reads as a choice
 * it never offered. A value matching one of the options is a choice.
 */
export function encodeAnswers(questions: QuestionItem[], answers: Record<string, string>): string {
  const wire: Record<string, string> = {}
  for (const question of questions) {
    const answer = answers[question.id]
    if (answer === undefined || answer.length === 0) continue
    const { customId } = question
    const chosen = question.options.some((option) => optionValue(option) === answer)
    if (customId !== undefined && !chosen) {
      wire[customId] = answer
      continue
    }
    wire[question.id] = answer
  }
  return JSON.stringify({ answers: wire })
}

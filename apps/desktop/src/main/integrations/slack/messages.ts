import {
  parseQuestionPayload,
  encodeAnswers,
  optionValue,
  type AnswerMap,
  type QuestionItem,
} from '@ari/contracts/questions'
import type { ExternalTaskView } from '../../external/task-host'
import type { SlackCallback } from './store'
import type { SlackModal, SlackPlainText, SlackReply } from './transport'

export const slackPlain = (text: string): SlackPlainText => ({
  type: 'plain_text',
  text: text.slice(0, 3000),
  emoji: false,
})
export const slackHelp =
  'Mention @Aria with a task to start an isolated session in this channel’s project. Mention it in the same thread for follow-ups. Use status, stop, or answer <text>. Your connected Ari desktop runs the agents.'

export function statusText(view: ExternalTaskView): string {
  if (view.archived) return `${view.title} is archived. Restore it in Ari to continue.`
  if (view.pending.length)
    return `${view.title} is waiting for ${view.pending.some((request) => request.kind === 'approval') ? 'approval' : 'your answer'}.`
  if (view.activeTurnId)
    return `${view.title} is running${view.queued ? `, with ${view.queued} follow-up${view.queued === 1 ? '' : 's'} queued` : ''}.`
  if (view.workingChildren) return `${view.title} is waiting for delegated work to settle.`
  if (view.lastTurn?.outcome === 'error')
    return `${view.title} ended with an error. Inspect it in Ari${view.queued ? '; queued follow-ups are held' : ''}.`
  if (view.lastTurn?.outcome === 'interrupted')
    return `${view.title} was stopped${view.queued ? '; queued follow-ups are held' : ''}.`
  if (view.queued)
    return `${view.title} has ${view.queued} follow-up${view.queued === 1 ? '' : 's'} queued.`
  return `${view.title} ${view.lastTurn ? 'finished' : 'is ready'}.`
}

export function resultReply(view: ExternalTaskView): SlackReply {
  const turn = view.lastTurn
  if (!turn) return { text: statusText(view) }
  const heading =
    turn.outcome === 'completed'
      ? 'Finished'
      : turn.outcome === 'interrupted'
        ? 'Stopped'
        : 'Ended with an error'
  const text = turn.text.replace(/<!--[\s\S]*?-->/g, '').trim()
  return {
    text: `${heading} · ${view.title}\n\n${text || (turn.outcome === 'error' ? 'Open this task in Ari to inspect the provider error.' : 'This turn produced no final text. Review the task in Ari.')}${view.queued && turn.outcome !== 'completed' ? '\n\nQueued follow-ups are held. Continue or remove them in Ari.' : ''}`.slice(
      0,
      11_000,
    ),
  }
}

function questionsFor(
  callback: SlackCallback,
): { questions: QuestionItem[]; questionnaire: boolean } | null {
  const payload = parseQuestionPayload(callback.prompt, callback.choicesJson)
  if (payload.kind === 'plan-approval') return null
  if (payload.kind === 'questionnaire') {
    if (
      payload.questions.length > 8 ||
      payload.questions.some((question) => question.options.length > 100)
    )
      return null
    return { questions: payload.questions, questionnaire: true }
  }
  return {
    questionnaire: false,
    questions: [
      {
        id: 'answer',
        question: payload.prompt,
        options:
          payload.kind === 'choices'
            ? payload.choices.slice(0, 100).map((label, index) => ({ id: String(index), label }))
            : [],
        multiSelect: false,
      },
    ],
  }
}

export function questionModal(callback: SlackCallback): SlackModal | null {
  const form = questionsFor(callback)
  if (!form) return null
  const blocks: SlackModal['blocks'] = []
  for (const [index, question] of form.questions.entries()) {
    blocks.push({
      type: 'input',
      block_id: `q${index}`,
      label: slackPlain(question.question.slice(0, 1900)),
      ...(question.options.length ? { optional: true } : {}),
      element: question.options.length
        ? {
            type: question.multiSelect ? 'multi_static_select' : 'static_select',
            action_id: 'answer',
            options: question.options.map((option, optionIndex) => ({
              text: slackPlain(option.label.slice(0, 75)),
              value: String(optionIndex),
            })),
          }
        : { type: 'plain_text_input', action_id: 'answer', multiline: true, max_length: 4000 },
    })
    if (question.options.length)
      blocks.push({
        type: 'input',
        block_id: `c${index}`,
        label: slackPlain('Or enter your own answer'),
        optional: true,
        element: {
          type: 'plain_text_input',
          action_id: 'answer',
          multiline: false,
          max_length: 4000,
        },
      })
  }
  return {
    type: 'modal',
    callback_id: 'ari_question',
    private_metadata: callback.id,
    title: slackPlain('Answer Aria'),
    submit: slackPlain('Send answer'),
    close: slackPlain('Cancel'),
    blocks,
  }
}

export class SlackFormError extends Error {
  constructor(readonly errors: Record<string, string>) {
    super('Choose or enter an answer for each question.')
  }
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** Decode only server-offered option indices; typed answers retain the provider's custom property. */
export function questionAnswer(callback: SlackCallback, rawValues: unknown): string {
  const form = questionsFor(callback)
  if (!form) throw new SlackFormError({ q0: 'Review and answer this plan in Ari.' })
  const values = object(rawValues)
  const answers = Object.create(null) as AnswerMap
  const typed = new Set<string>()
  const errors: Record<string, string> = {}
  for (const [index, question] of form.questions.entries()) {
    const key = `q${index}`
    const field = object(object(values[key])['answer'])
    const custom = object(object(values[`c${index}`])['answer'])['value']
    const selected = field['selected_option']
    const selectedMany = field['selected_options']
    const raw = field['value']
    let answer: string | string[] | undefined
    if (!question.options.length) {
      if (typeof raw === 'string' && raw.trim() && raw.length <= 4000) answer = raw
    } else {
      const indices = question.multiSelect
        ? Array.isArray(selectedMany)
          ? selectedMany
          : []
        : selected
          ? [selected]
          : []
      const picked: string[] = []
      for (const option of indices) {
        const value = object(option)['value']
        if (
          typeof value !== 'string' ||
          !/^(0|[1-9]\d*)$/.test(value) ||
          !question.options[Number(value)]
        ) {
          errors[key] = 'Choose an offered option.'
          continue
        }
        picked.push(optionValue(question.options[Number(value)]!))
      }
      if (picked.length) answer = question.multiSelect ? [...new Set(picked)] : picked[0]
      if (typeof custom === 'string' && custom.trim() && custom.length <= 4000) {
        if (answer !== undefined)
          errors[key] = 'Choose an option or enter your own answer, rather than both.'
        else {
          answer = custom
          typed.add(question.id)
        }
      }
    }
    if (answer === undefined) errors[key] ??= 'Choose or enter an answer.'
    else answers[question.id] = answer
  }
  if (Object.keys(errors).length) throw new SlackFormError(errors)
  return form.questionnaire
    ? encodeAnswers(form.questions, answers, typed)
    : String(answers['answer'] ?? '')
}

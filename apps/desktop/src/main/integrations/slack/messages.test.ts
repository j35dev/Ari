// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { questionAnswer, questionModal, SlackFormError } from './messages'
import type { SlackCallback } from './store'

const callback = (choicesJson: string | null): SlackCallback => ({
  id: 'opaque-callback',
  bindingKey: 'binding',
  revision: 1,
  sessionId: 'task',
  turnId: 'turn',
  requestId: 'question',
  kind: 'input',
  value: null,
  prompt: 'Choose a change',
  choicesJson,
  at: 1,
})

describe('Slack question forms', () => {
  it('encodes provider property names without relying on object prototypes', () => {
    const request = callback(
      JSON.stringify({ questions: [{ id: '__proto__', question: 'Answer?', options: [] }] }),
    )
    expect(questionAnswer(request, { q0: { answer: { value: 'A literal answer' } } })).toBe(
      '{"answers":{"__proto__":"A literal answer"}}',
    )
  })
  it('preserves distinct option values and typed custom properties', () => {
    const request = callback(
      JSON.stringify({
        kind: 'questionnaire',
        questions: [
          {
            id: 'scope',
            customId: 'scope_custom',
            question: 'What should change?',
            options: [
              { id: 'one', label: 'Tests', value: 'tests_only' },
              { id: 'two', label: 'Code', value: 'code_only' },
            ],
          },
        ],
      }),
    )
    expect(questionModal(request)?.blocks[0]?.element.type).toBe('static_select')
    expect(
      JSON.parse(questionAnswer(request, { q0: { answer: { selected_option: { value: '1' } } } })),
    ).toEqual({ answers: { scope: 'code_only' } })
    expect(
      JSON.parse(questionAnswer(request, { c0: { answer: { value: 'Only fix documentation' } } })),
    ).toEqual({ answers: { scope_custom: 'Only fix documentation' } })
  })

  it('keeps multiple selections as arrays and rejects forged options', () => {
    const request = callback(
      JSON.stringify({
        questions: [
          {
            id: 'targets',
            question: 'Targets?',
            multiSelect: true,
            options: [
              { label: 'Desktop', value: 'desktop' },
              { label: 'Mobile', value: 'mobile' },
            ],
          },
        ],
      }),
    )
    expect(questionModal(request)?.blocks[0]?.element.type).toBe('multi_static_select')
    expect(
      JSON.parse(
        questionAnswer(request, {
          q0: { answer: { selected_options: [{ value: '0' }, { value: '1' }] } },
        }),
      ),
    ).toEqual({ answers: { targets: ['desktop', 'mobile'] } })
    expect(() =>
      questionAnswer(request, { q0: { answer: { selected_options: [{ value: '99' }] } } }),
    ).toThrow(SlackFormError)
  })

  it('returns validation errors for incomplete forms rather than sending empty answers', () => {
    const request = callback(null)
    expect(() => questionAnswer(request, {})).toThrow(SlackFormError)
    expect(
      questionAnswer(request, { q0: { answer: { value: 'Keep the existing behavior.' } } }),
    ).toBe('Keep the existing behavior.')
  })

  it('keeps plan approval and oversized questionnaires in Ari', () => {
    expect(
      questionModal(callback(JSON.stringify({ kind: 'plan-approval', planContent: 'Full plan' }))),
    ).toBeNull()
    expect(
      questionModal(
        callback(
          JSON.stringify({
            questions: Array.from({ length: 9 }, (_, index) => ({
              id: String(index),
              question: 'Question',
              options: [],
            })),
          }),
        ),
      ),
    ).toBeNull()
  })
})

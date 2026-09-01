import { describe, expect, it } from 'vitest'
import { encodeAnswers, parseQuestionPayload } from './questionnaire'

describe('parseQuestionPayload', () => {
  it('treats a JSON string array as legacy choices', () => {
    expect(parseQuestionPayload('Proceed?', JSON.stringify(['Yes', 'No']))).toEqual({
      kind: 'choices',
      prompt: 'Proceed?',
      choices: ['Yes', 'No'],
    })
  })

  it('reads a questionnaire object', () => {
    const payload = parseQuestionPayload(
      '2 questions',
      JSON.stringify({
        kind: 'questionnaire',
        questions: [
          {
            id: 'q1',
            question: 'Which approach?',
            options: [{ id: 'a', label: 'Rewrite' }],
            multiSelect: false,
          },
        ],
      }),
    )
    expect(payload.kind).toBe('questionnaire')
    if (payload.kind === 'questionnaire') {
      expect(payload.questions[0]?.question).toBe('Which approach?')
    }
  })

  it('reads a plan-approval payload', () => {
    expect(
      parseQuestionPayload('Approve this plan?', JSON.stringify({ kind: 'plan-approval', planContent: '# Go' })),
    ).toEqual({
      kind: 'plan-approval',
      prompt: 'Approve this plan?',
      planContent: '# Go',
    })
  })

  it('falls back to free text when choices are absent or malformed', () => {
    expect(parseQuestionPayload('Name?', null)).toEqual({ kind: 'free-text', prompt: 'Name?' })
    expect(parseQuestionPayload('Name?', '{"option":"nope"}')).toEqual({
      kind: 'free-text',
      prompt: 'Name?',
    })
  })
})

describe('encodeAnswers', () => {
  it('wraps an id→answer map', () => {
    expect(JSON.parse(encodeAnswers({ q1: 'Rewrite' }))).toEqual({ answers: { q1: 'Rewrite' } })
  })
})

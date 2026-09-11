import { describe, expect, it } from 'vitest'
import { encodeAnswers, parseQuestionPayload, type QuestionItem } from './questionnaire'

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

  it('keeps a questionnaire item that has choices but no text', () => {
    const payload = parseQuestionPayload(
      'Pick',
      JSON.stringify({
        questions: [{ id: 'q1', options: [{ id: 'a', label: 'A' }], multiSelect: false }],
      }),
    )
    expect(payload.kind).toBe('questionnaire')
    if (payload.kind === 'questionnaire') expect(payload.questions[0]?.question).toBe('Question 1')
  })

  it('carries option values and the custom-answer property through', () => {
    const payload = parseQuestionPayload(
      'Pick',
      JSON.stringify({
        questions: [
          {
            id: 'question_0',
            question: 'Which approach?',
            options: [{ id: 'opt-0', label: 'Patch', value: 'patch' }],
            multiSelect: false,
            customId: 'question_0_custom',
          },
        ],
      }),
    )
    expect(payload.kind).toBe('questionnaire')
    if (payload.kind === 'questionnaire') {
      expect(payload.questions[0]?.options[0]?.value).toBe('patch')
      expect(payload.questions[0]?.customId).toBe('question_0_custom')
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
  const question = (over: Partial<QuestionItem> = {}): QuestionItem => ({
    id: 'q1',
    question: 'Which approach?',
    options: [{ id: 'a', label: 'Rewrite' }],
    multiSelect: false,
    ...over,
  })

  it('wraps an id→answer map', () => {
    expect(JSON.parse(encodeAnswers([question()], { q1: 'Rewrite' }))).toEqual({
      answers: { q1: 'Rewrite' },
    })
  })

  it('sends the option value when it differs from the label', () => {
    const q = question({ options: [{ id: 'a', label: 'Rewrite', value: 'rewrite-the-config' }] })
    expect(JSON.parse(encodeAnswers([q], { q1: 'rewrite-the-config' }))).toEqual({
      answers: { q1: 'rewrite-the-config' },
    })
  })

  it('sends a typed answer to the question’s custom-answer property', () => {
    const q = question({ customId: 'q1_custom' })
    const chosen = encodeAnswers([q], { q1: 'Rewrite' })
    expect(JSON.parse(chosen)).toEqual({ answers: { q1: 'Rewrite' } })
    // Anything that is not one of the choices is the user's own text, and the
    // agent reads `q1_custom` first — a choice key would read as a real choice.
    const typed = encodeAnswers([q], { q1: 'Something else' })
    expect(JSON.parse(typed)).toEqual({ answers: { q1_custom: 'Something else' } })
  })

  it('drops unanswered questions', () => {
    const answers = encodeAnswers([question(), question({ id: 'q2' })], { q2: 'Rewrite' })
    expect(JSON.parse(answers)).toEqual({ answers: { q2: 'Rewrite' } })
  })

  it('sends a multi select as the array its schema asked for', () => {
    const q = question({
      multiSelect: true,
      options: [
        { id: 'a', label: 'a.ts', value: 'a.ts' },
        { id: 'b', label: 'b.ts', value: 'b.ts' },
      ],
    })
    expect(JSON.parse(encodeAnswers([q], { q1: ['a.ts', 'b.ts'] }))).toEqual({
      answers: { q1: ['a.ts', 'b.ts'] },
    })
  })

  it('keeps a multi select out of the custom-answer property', () => {
    // Joined into "a.ts, b.ts" the answer matched no single option, so it was
    // classified as typed and sent to the companion as free text.
    const q = question({
      multiSelect: true,
      customId: 'q1_custom',
      options: [
        { id: 'a', label: 'a.ts', value: 'a.ts' },
        { id: 'b', label: 'b.ts', value: 'b.ts' },
      ],
    })
    expect(JSON.parse(encodeAnswers([q], { q1: ['a.ts', 'b.ts'] }))).toEqual({
      answers: { q1: ['a.ts', 'b.ts'] },
    })
  })

  it('routes an answer the user typed to the companion even when it names an option', () => {
    // The panel knows this answer came from the Other box; the text alone
    // cannot say so, since it is a string the agent also offered as a choice.
    const q = question({ customId: 'q1_custom' })
    expect(JSON.parse(encodeAnswers([q], { q1: 'Rewrite' }, new Set(['q1'])))).toEqual({
      answers: { q1_custom: 'Rewrite' },
    })
  })
})

import { describe, expect, it } from 'vitest'
import {
  encodeQuestionnaire,
  isAskUserQuestionMethod,
  isExitPlanModeMethod,
  isInteractiveClientMethod,
  isQuestionPermission,
  parseAskUserQuestions,
  parseElicitationForm,
  parsePlanExit,
  questionsFromPermission,
  replyAskUser,
  replyElicitation,
  replyPermissionChoice,
  replyPlanExit,
} from './client-requests'

describe('client-request method matchers', () => {
  it('recognizes Grok ext methods with and without the underscore prefix', () => {
    expect(isAskUserQuestionMethod('_x.ai/ask_user_question')).toBe(true)
    expect(isAskUserQuestionMethod('x.ai/ask_user_question')).toBe(true)
    expect(isExitPlanModeMethod('_x.ai/exit_plan_mode')).toBe(true)
    expect(isInteractiveClientMethod('elicitation/create')).toBe(true)
    expect(isInteractiveClientMethod('session/request_permission')).toBe(false)
  })
})

describe('parseAskUserQuestions', () => {
  it('reads a Grok questionnaire with labeled options', () => {
    const questions = parseAskUserQuestions({
      questions: [
        {
          question: 'Which approach?',
          header: 'Approach',
          options: [
            { label: 'Conservative', description: 'Small diffs' },
            { label: 'Rewrite' },
          ],
        },
      ],
    })
    expect(questions).toHaveLength(1)
    expect(questions[0]?.question).toBe('Which approach?')
    expect(questions[0]?.header).toBe('Approach')
    expect(questions[0]?.options.map((o) => o.label)).toEqual(['Conservative', 'Rewrite'])
  })

  it('falls back to a flat prompt', () => {
    expect(parseAskUserQuestions({ prompt: 'Proceed?' })[0]?.question).toBe('Proceed?')
  })
})

describe('parseElicitationForm', () => {
  it('projects enum properties into questions', () => {
    const form = parseElicitationForm({
      mode: 'form',
      message: 'How should I refactor?',
      requestedSchema: {
        type: 'object',
        properties: {
          strategy: {
            type: 'string',
            enum: ['conservative', 'balanced', 'aggressive'],
            description: 'Refactoring strategy',
          },
        },
      },
    })
    expect(form.url).toBe(false)
    expect(form.questions[0]?.id).toBe('strategy')
    expect(form.questions[0]?.options.map((o) => o.label)).toEqual([
      'conservative',
      'balanced',
      'aggressive',
    ])
  })

  it('marks URL mode so the caller can decline it', () => {
    expect(parseElicitationForm({ mode: 'url', url: 'https://example', message: 'auth' }).url).toBe(
      true,
    )
  })
})

describe('parsePlanExit', () => {
  it('reads the flat Grok planContent field', () => {
    expect(parsePlanExit({ sessionId: 's', planContent: '# Plan\n\nDo the thing.' }).planContent).toBe(
      '# Plan\n\nDo the thing.',
    )
  })
})

describe('permission-as-question', () => {
  it('treats custom option kinds as a question, not allow/deny', () => {
    expect(isQuestionPermission([{ kind: 'select', optionId: 'a', name: 'A' }])).toBe(true)
    expect(isQuestionPermission([{ kind: 'allow_once', optionId: 'allow_once', name: 'Allow' }])).toBe(
      false,
    )
  })

  it('maps a chosen label back onto the option id', () => {
    const options = [
      { optionId: 'left', name: 'Left' },
      { optionId: 'right', name: 'Right' },
    ]
    expect(questionsFromPermission('Pick a side', options)[0]?.options).toHaveLength(2)
    expect(replyPermissionChoice(options, 'Right')).toEqual({
      outcome: { outcome: 'selected', optionId: 'right' },
    })
  })
})

describe('reply builders', () => {
  it('keys Grok answers by question text', () => {
    const questions = parseAskUserQuestions({
      questions: [{ id: 'q1', question: 'Which approach?', options: [{ label: 'Rewrite' }] }],
    })
    expect(replyAskUser(questions, JSON.stringify({ answers: { q1: 'Rewrite' } }))).toEqual({
      outcome: 'accepted',
      answers: { 'Which approach?': 'Rewrite' },
      partial_answers: {},
    })
  })

  it('keys elicitation content by schema property id', () => {
    const { questions } = parseElicitationForm({
      mode: 'form',
      message: 'pick',
      requestedSchema: { properties: { strategy: { enum: ['balanced'] } } },
    })
    expect(replyElicitation(questions, JSON.stringify({ answers: { strategy: 'balanced' } }))).toEqual({
      action: 'accept',
      content: { strategy: 'balanced' },
    })
  })

  it('maps plan verdicts, including request-changes feedback', () => {
    expect(replyPlanExit('approved')).toEqual({ outcome: 'approved' })
    expect(replyPlanExit('abandoned')).toEqual({ outcome: 'abandoned' })
    expect(replyPlanExit(JSON.stringify({ outcome: 'cancelled', feedback: 'smaller scope' }))).toEqual({
      outcome: 'cancelled',
      feedback: 'smaller scope',
    })
    expect(replyPlanExit('please drop the migration')).toEqual({
      outcome: 'cancelled',
      feedback: 'please drop the migration',
    })
  })

  it('round-trips a questionnaire payload', () => {
    const encoded = encodeQuestionnaire({
      kind: 'plan-approval',
      questions: [],
      planContent: '# Do it',
    })
    expect(JSON.parse(encoded)).toMatchObject({ kind: 'plan-approval', planContent: '# Do it' })
  })
})

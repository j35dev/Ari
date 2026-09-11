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

  it('reads an AskUserQuestion oneOf schema as one question with its choices', () => {
    const { questions } = parseElicitationForm(askUserQuestionForm())
    // The `_custom` companion is where a typed answer goes, not a second
    // question — counting it is what told the user "Question 1 of 2".
    expect(questions).toHaveLength(1)
    expect(questions[0]?.id).toBe('question_0')
    expect(questions[0]?.question).toBe('Which approach should I take?')
    expect(questions[0]?.header).toBe('Approach')
    expect(questions[0]?.multiSelect).toBe(false)
    expect(questions[0]?.customId).toBe('question_0_custom')
    expect(questions[0]?.options).toEqual([
      { id: 'opt-0', label: 'Rewrite', description: 'Start over from the config' },
      { id: 'opt-1', label: 'Patch' },
    ])
  })

  it('matches the companion by name when the adapter drops the meta', () => {
    const { questions } = parseElicitationForm({
      mode: 'form',
      requestedSchema: {
        properties: {
          question_0: { type: 'string', oneOf: [{ const: 'A', title: 'A' }] },
          question_0_custom: { type: 'string', title: 'Other' },
        },
      },
    })
    expect(questions).toHaveLength(1)
    expect(questions[0]?.customId).toBe('question_0_custom')
  })

  it('keeps a _custom property that names no sibling as a question', () => {
    const { questions } = parseElicitationForm({
      mode: 'form',
      requestedSchema: { properties: { freeform_custom: { type: 'string', title: 'Freeform' } } },
    })
    expect(questions.map((q) => q.id)).toEqual(['freeform_custom'])
  })

  it('submits a const that differs from its title, and splits a flattened one back off', () => {
    const { questions } = parseElicitationForm({
      mode: 'form',
      requestedSchema: {
        properties: {
          pick: {
            oneOf: [
              { const: 'a', title: 'Alpha' },
              { const: 'b', title: 'Beta — the slower one', description: 'the slower one' },
            ],
          },
        },
      },
    })
    expect(questions[0]?.options[0]).toEqual({ id: 'opt-0', label: 'Alpha', value: 'a' })
    // The adapter flattens `title` to `Label — description` for clients that
    // ignore its meta; keeping both would print the sentence twice.
    expect(questions[0]?.options[1]).toEqual({
      id: 'opt-1',
      label: 'Beta',
      value: 'b',
      description: 'the slower one',
    })
  })

  it('reads items.anyOf as a multi select', () => {
    const { questions } = parseElicitationForm({
      mode: 'form',
      message: 'Which files?',
      requestedSchema: {
        properties: {
          question_0: {
            type: 'array',
            title: 'Files',
            description: 'Which files should I touch?',
            items: {
              anyOf: [
                { const: 'a.ts', title: 'a.ts' },
                { const: 'b.ts', title: 'b.ts' },
              ],
            },
          },
        },
      },
    })
    expect(questions[0]?.multiSelect).toBe(true)
    expect(questions[0]?.question).toBe('Which files should I touch?')
    expect(questions[0]?.options.map((o) => o.label)).toEqual(['a.ts', 'b.ts'])
  })

  it('leaves a choice-less question option-free for the panel to render as text', () => {
    const { questions } = parseElicitationForm({
      mode: 'form',
      message: 'Anything else?',
      requestedSchema: {
        type: 'object',
        properties: { notes: { type: 'string', title: 'Notes' } },
      },
    })
    expect(questions).toHaveLength(1)
    expect(questions[0]?.question).toBe('Notes')
    expect(questions[0]?.options).toEqual([])
  })

  it('marks URL mode so the caller can decline it', () => {
    expect(parseElicitationForm({ mode: 'url', url: 'https://example', message: 'auth' }).url).toBe(
      true,
    )
  })
})

/**
 * What claude-agent-acp builds for a single AskUserQuestion: `question_<i>` with
 * its choices as `oneOf`, and a `question_<i>_custom` companion for "Other".
 */
function askUserQuestionForm(): unknown {
  return {
    mode: 'form',
    message: 'Which approach should I take?',
    requestedSchema: {
      type: 'object',
      properties: {
        question_0: {
          type: 'string',
          title: 'Approach',
          description: 'Which approach should I take?',
          oneOf: [
            { const: 'Rewrite', title: 'Rewrite', description: 'Start over from the config' },
            { const: 'Patch', title: 'Patch' },
          ],
        },
        question_0_custom: {
          type: 'string',
          title: 'Other',
          description: 'Describe your own answer',
          _meta: {
            _askUserQuestionCustomAnswer: { questionId: 'question_0', isCustomAnswer: true },
          },
        },
      },
    },
  }
}

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

  it('answers a chosen option under the question and typed text under its companion', () => {
    const { questions } = parseElicitationForm(askUserQuestionForm())
    expect(
      replyElicitation(questions, JSON.stringify({ answers: { question_0: 'Patch' } })),
    ).toEqual({
      action: 'accept',
      content: { question_0: 'Patch' },
    })
    // The agent reads `question_0_custom` first; sending free text as a choice
    // would look like an answer it never offered.
    expect(
      replyElicitation(
        questions,
        JSON.stringify({ answers: { question_0_custom: 'Something else' } }),
      ),
    ).toEqual({ action: 'accept', content: { question_0_custom: 'Something else' } })
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

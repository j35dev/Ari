import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { QuestionPanel } from './QuestionPanel'

describe('QuestionPanel', () => {
  const setup = (onRespond: (value: string) => void, choicesJson: string | null, onCancel?: () => void) => {
    const user = userEvent.setup()
    render(<QuestionPanel prompt="Proceed?" choicesJson={choicesJson} onRespond={onRespond} onCancel={onCancel} />)
    return user
  }

  it('renders one question with full-width numbered options', () => {
    setup(vi.fn(), JSON.stringify(['Yes', 'No', 'Ask later']))
    expect(screen.getByText('Proceed?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /1\s*Yes/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /3\s*Ask later/ })).toBeInTheDocument()
    expect(screen.queryByText(/Question 1 of/)).not.toBeInTheDocument()
  })

  it('selects an option via number key and submits a single-choice list', async () => {
    const onRespond = vi.fn()
    const user = setup(onRespond, JSON.stringify(['Yes', 'No', 'Ask later']))
    screen.getByRole('region', { name: 'Agent question' }).focus()
    await user.keyboard('2')
    await waitFor(() => expect(onRespond).toHaveBeenCalledOnce())
    expect(onRespond).toHaveBeenCalledWith('No')
  })

  it('selects an option by click', async () => {
    const onRespond = vi.fn()
    const user = setup(onRespond, JSON.stringify(['Yes', 'No']))
    await user.click(screen.getByRole('button', { name: /1\s*Yes/ }))
    await waitFor(() => expect(onRespond).toHaveBeenCalledWith('Yes'))
  })

  it('lists more than nine choices without paging', () => {
    setup(vi.fn(), JSON.stringify(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k']))
    expect(screen.getByRole('button', { name: /10\s*j/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /11\s*k/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument()
  })

  it('falls back to free text when choices are absent and submits on Enter', async () => {
    const onRespond = vi.fn()
    const user = setup(onRespond, null)
    const input = screen.getByLabelText('Answer')
    await user.type(input, '  blue  ')
    await user.type(input, '{Enter}')
    expect(onRespond).toHaveBeenCalledOnce()
    expect(onRespond).toHaveBeenCalledWith('blue')
  })

  it('treats non-string-array choices as free text', () => {
    setup(vi.fn(), '{"option": "not-a-list"}')
    expect(screen.getByLabelText('Answer')).toBeInTheDocument()
  })

  it('skips a free-text question via Skip', async () => {
    const onCancel = vi.fn()
    const user = setup(vi.fn(), null, onCancel)
    await user.click(screen.getByRole('button', { name: 'Skip' }))
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('offers Other on a choice list and submits the custom text', async () => {
    const onRespond = vi.fn()
    const user = setup(onRespond, JSON.stringify(['Yes', 'No']))
    expect(screen.getByRole('button', { name: /Other/ })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Other/ }))
    expect(screen.getByLabelText('Custom answer')).toBeInTheDocument()
    expect(screen.getByText(/sent as the answer/)).toBeInTheDocument()
    await user.type(screen.getByLabelText('Custom answer'), '  maybe later  ')
    await user.click(screen.getByRole('button', { name: 'Submit' }))
    expect(onRespond).toHaveBeenCalledOnce()
    expect(onRespond).toHaveBeenCalledWith('maybe later')
  })

  it('toggles the custom-answer box closed on a second Other click', async () => {
    const user = setup(vi.fn(), JSON.stringify(['Yes', 'No']))
    await user.click(screen.getByRole('button', { name: /Other/ }))
    expect(screen.getByLabelText('Custom answer')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Other/ }))
    expect(screen.queryByLabelText('Custom answer')).not.toBeInTheDocument()
  })

  it('skips the question via the Skip button without answering', async () => {
    const onRespond = vi.fn()
    const onCancel = vi.fn()
    const user = setup(onRespond, JSON.stringify(['Yes', 'No']), onCancel)
    await user.click(screen.getByRole('button', { name: 'Skip' }))
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onRespond).not.toHaveBeenCalled()
  })

  it('hides Skip when no cancel handler is provided', () => {
    setup(vi.fn(), JSON.stringify(['Yes', 'No']))
    expect(screen.queryByRole('button', { name: 'Skip' })).not.toBeInTheDocument()
  })

  it('skips the question on Escape', async () => {
    const onCancel = vi.fn()
    const user = setup(vi.fn(), JSON.stringify(['Yes', 'No']), onCancel)
    screen.getByRole('region', { name: 'Agent question' }).focus()
    await user.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('asks one questionnaire item at a time and encodes the map', async () => {
    const onRespond = vi.fn()
    const user = userEvent.setup()
    render(
      <QuestionPanel
        prompt="2 questions"
        choicesJson={JSON.stringify({
          kind: 'questionnaire',
          questions: [
            {
              id: 'color',
              question: 'Which color?',
              options: [
                { id: 'r', label: 'Red', description: 'Warm' },
                { id: 'b', label: 'Blue' },
              ],
              multiSelect: false,
            },
            {
              id: 'size',
              question: 'Which size?',
              options: [
                { id: 's', label: 'Small' },
                { id: 'l', label: 'Large' },
              ],
              multiSelect: false,
            },
          ],
        })}
        onRespond={onRespond}
      />,
    )
    expect(screen.getByText('Question 1 of 2')).toBeInTheDocument()
    expect(screen.getByText('Which color?')).toBeInTheDocument()
    expect(screen.queryByText('Which size?')).not.toBeInTheDocument()
    expect(screen.getByText('Warm')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Red/ }))
    expect(await screen.findByText('Which size?')).toBeInTheDocument()
    expect(screen.getByText('Question 2 of 2')).toBeInTheDocument()
    expect(screen.queryByText('Which color?')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Large/ }))
    await waitFor(() =>
      expect(onRespond).toHaveBeenCalledWith(JSON.stringify({ answers: { color: 'Red', size: 'Large' } })),
    )
  })

  it('lets Back return to the previous question', async () => {
    const user = userEvent.setup()
    render(
      <QuestionPanel
        prompt="2 questions"
        choicesJson={JSON.stringify({
          questions: [
            { id: 'a', question: 'First?', options: [{ id: 'y', label: 'Yes' }], multiSelect: false },
            { id: 'b', question: 'Second?', options: [{ id: 'n', label: 'No' }], multiSelect: false },
          ],
        })}
        onRespond={vi.fn()}
      />,
    )
    await user.click(screen.getByRole('button', { name: /Yes/ }))
    expect(await screen.findByText('Second?')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByText('First?')).toBeInTheDocument()
  })

  it('renders a choice-less question as plain free text, not an Other-only list', async () => {
    const onRespond = vi.fn()
    const user = userEvent.setup()
    render(
      <QuestionPanel
        prompt="Anything else?"
        choicesJson={JSON.stringify({
          kind: 'questionnaire',
          questions: [{ id: 'notes', question: 'Anything else?', options: [], multiSelect: false }],
        })}
        onRespond={onRespond}
      />,
    )
    // The panel always appends an "Other" row; with no options to choose from
    // that is the whole question, and the user is asked to describe their own
    // answer to something never offered.
    expect(screen.queryByRole('button', { name: /Other/ })).not.toBeInTheDocument()
    await user.type(screen.getByLabelText('Your answer'), '  nothing more  ')
    await user.click(screen.getByRole('button', { name: 'Submit' }))
    expect(onRespond).toHaveBeenCalledWith(JSON.stringify({ answers: { notes: 'nothing more' } }))
  })

  it('submits an option value rather than its label', async () => {
    const onRespond = vi.fn()
    const user = userEvent.setup()
    render(
      <QuestionPanel
        prompt="Which approach?"
        choicesJson={JSON.stringify({
          questions: [
            {
              id: 'question_0',
              question: 'Which approach?',
              options: [
                { id: 'opt-0', label: 'Rewrite', value: 'rewrite' },
                { id: 'opt-1', label: 'Patch', value: 'patch' },
              ],
              multiSelect: false,
            },
          ],
        })}
        onRespond={onRespond}
      />,
    )
    await user.click(screen.getByRole('button', { name: /2\s*Patch/ }))
    expect(onRespond).toHaveBeenCalledWith(JSON.stringify({ answers: { question_0: 'patch' } }))
  })

  it('sends a typed answer to the question’s custom-answer property', async () => {
    const onRespond = vi.fn()
    const user = userEvent.setup()
    render(
      <QuestionPanel
        prompt="Which approach?"
        choicesJson={JSON.stringify({
          questions: [
            {
              id: 'question_0',
              question: 'Which approach?',
              options: [{ id: 'opt-0', label: 'Patch', value: 'patch' }],
              multiSelect: false,
              customId: 'question_0_custom',
            },
          ],
        })}
        onRespond={onRespond}
      />,
    )
    await user.click(screen.getByRole('button', { name: /Other/ }))
    await user.type(screen.getByLabelText('Custom answer'), 'Neither')
    await user.click(screen.getByRole('button', { name: 'Submit' }))
    expect(onRespond).toHaveBeenCalledWith(
      JSON.stringify({ answers: { question_0_custom: 'Neither' } }),
    )
  })

  it('submits a multi select as an array of the chosen values', async () => {
    const onRespond = vi.fn()
    const user = userEvent.setup()
    render(
      <QuestionPanel
        prompt="Which files?"
        choicesJson={JSON.stringify({
          kind: 'questionnaire',
          questions: [
            {
              id: 'files',
              question: 'Which files?',
              options: [
                { id: 'a', label: 'a.ts', value: 'a.ts' },
                { id: 'b', label: 'b.ts', value: 'b.ts' },
                { id: 'c', label: 'c.ts', value: 'c.ts' },
              ],
              multiSelect: true,
            },
          ],
        })}
        onRespond={onRespond}
      />,
    )
    // A multi select answers an array-typed schema property, so the two picks
    // have to arrive as a list — a joined string is what the schema rejects.
    await user.click(screen.getByText('a.ts'))
    await user.click(screen.getByText('c.ts'))
    await user.click(screen.getByRole('button', { name: 'Submit' }))
    expect(onRespond).toHaveBeenCalledWith(JSON.stringify({ answers: { files: ['a.ts', 'c.ts'] } }))
  })

  it('skips a choice-less question on Escape from its own answer box', async () => {
    const onCancel = vi.fn()
    const user = userEvent.setup()
    render(
      <QuestionPanel
        prompt="Anything else?"
        choicesJson={JSON.stringify({
          kind: 'questionnaire',
          questions: [{ id: 'notes', question: 'Anything else?', options: [], multiSelect: false }],
        })}
        onRespond={vi.fn()}
        onCancel={onCancel}
      />,
    )
    // The box autofocuses, so this is where the keyboard already is — the one
    // place the Skip button's "(Esc)" could never reach.
    expect(screen.getByLabelText('Your answer')).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('renders a compact plan-approval card and reports the verdict', async () => {
    const onRespond = vi.fn()
    const user = userEvent.setup()
    render(
      <QuestionPanel
        prompt="Approve this plan?"
        choicesJson={JSON.stringify({ kind: 'plan-approval', planContent: '# Ship it' })}
        onRespond={onRespond}
      />,
    )
    expect(screen.getByRole('region', { name: 'Plan approval' })).toBeInTheDocument()
    expect(screen.getByText('# Ship it')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Approve' }))
    expect(onRespond).toHaveBeenCalledWith('approved')
  })
})

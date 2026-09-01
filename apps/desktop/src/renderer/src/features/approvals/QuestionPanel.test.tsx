import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { QuestionPanel } from './QuestionPanel'

describe('QuestionPanel', () => {
  const setup = (onRespond: (value: string) => void, choicesJson: string | null) => {
    const user = userEvent.setup()
    render(<QuestionPanel prompt="Proceed?" choicesJson={choicesJson} onRespond={onRespond} />)
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

  it('offers Other on a choice list and submits the custom text', async () => {
    const onRespond = vi.fn()
    const user = setup(onRespond, JSON.stringify(['Yes', 'No']))
    expect(screen.getByRole('button', { name: /Other/ })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Other/ }))
    await user.type(screen.getByLabelText('Other'), '  maybe later  ')
    await user.click(screen.getByRole('button', { name: 'Submit' }))
    expect(onRespond).toHaveBeenCalledOnce()
    expect(onRespond).toHaveBeenCalledWith('maybe later')
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

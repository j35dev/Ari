import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/react'
import { QuestionPanel } from './QuestionPanel'

describe('QuestionPanel', () => {
  const setup = (onRespond: (value: string) => void, choicesJson: string | null) => {
    const user = userEvent.setup()
    render(<QuestionPanel prompt="Proceed?" choicesJson={choicesJson} onRespond={onRespond} />)
    return user
  }

  it('renders the prompt and paged option buttons with number hints', () => {
    setup(vi.fn(), JSON.stringify(['Yes', 'No', 'Ask later']))
    expect(screen.getByText('Proceed?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /1\s*Yes/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /3\s*Ask later/ })).toBeInTheDocument()
  })

  it('selects an option via number key and auto-advances after 220ms', async () => {
    const onRespond = vi.fn()
    const user = setup(onRespond, JSON.stringify(['Yes', 'No', 'Ask later']))
    screen.getByRole('region', { name: 'Agent question' }).focus()
    await user.keyboard('2')
    await waitFor(() => expect(onRespond).toHaveBeenCalledOnce(), { timeout: 1500 })
    expect(onRespond).toHaveBeenCalledWith('No')
  })

  it('selects an option by click with the same auto-advance delay', async () => {
    const onRespond = vi.fn()
    const user = setup(onRespond, JSON.stringify(['Yes', 'No']))
    await user.click(screen.getByRole('button', { name: /1\s*Yes/ }))
    await waitFor(() => expect(onRespond).toHaveBeenCalledWith('Yes'), { timeout: 1500 })
  })

  it('pages through more than nine choices', async () => {
    const onRespond = vi.fn()
    const user = setup(
      onRespond,
      JSON.stringify(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k']),
    )
    expect(screen.queryByRole('button', { name: /10\s*j/ })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByRole('button', { name: /2\s*k/ })).toBeInTheDocument()
    screen.getByRole('region', { name: 'Agent question' }).focus()
    await user.keyboard('1')
    await waitFor(() => expect(onRespond).toHaveBeenCalledWith('j'), { timeout: 1500 })
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

  it('renders a plan-approval card and reports the verdict', async () => {
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

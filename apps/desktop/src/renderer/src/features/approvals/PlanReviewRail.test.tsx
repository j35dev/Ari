import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { PlanReviewRail } from './PlanReviewRail'

describe('PlanReviewRail', () => {
  it('renders the plan markdown and reports approve', async () => {
    const onRespond = vi.fn()
    const user = userEvent.setup()
    render(
      <PlanReviewRail prompt="Approve this plan?" planContent="# Ship it\n\nGo." onRespond={onRespond} />,
    )
    expect(screen.getByRole('complementary', { name: 'Plan review' })).toBeInTheDocument()
    expect(screen.getByText('Plan')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /Ship it/ })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Approve plan' }))
    expect(onRespond).toHaveBeenCalledWith('approved')
  })

  it('sends cancelled feedback when requesting changes', async () => {
    const onRespond = vi.fn()
    const user = userEvent.setup()
    render(<PlanReviewRail prompt="Plan" planContent="body" onRespond={onRespond} />)
    await user.click(screen.getByRole('button', { name: 'Request changes' }))
    await user.type(screen.getByLabelText('Requested changes'), '  split the work  ')
    await user.click(screen.getByRole('button', { name: 'Send feedback' }))
    expect(onRespond).toHaveBeenCalledWith(
      JSON.stringify({ outcome: 'cancelled', feedback: 'split the work' }),
    )
  })

  it('abandons the plan', async () => {
    const onRespond = vi.fn()
    const user = userEvent.setup()
    render(<PlanReviewRail prompt="Plan" planContent="" onRespond={onRespond} />)
    await user.click(screen.getByRole('button', { name: 'Abandon' }))
    expect(onRespond).toHaveBeenCalledWith('abandoned')
  })
})

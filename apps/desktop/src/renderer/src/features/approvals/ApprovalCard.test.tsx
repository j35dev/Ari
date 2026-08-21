import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ApprovalCard } from './ApprovalCard'

describe('ApprovalCard', () => {
  it('renders tool name and pretty-printed summary JSON', () => {
    render(
      <ApprovalCard
        approvalId="ap-1"
        toolName="bash"
        summaryJson='{"command":"ls -la","cwd":"/tmp"}'
        onRespond={vi.fn()}
      />,
    )
    expect(screen.getByRole('group', { name: 'Approval requested: bash' })).toBeInTheDocument()
    expect(screen.getByText(/"command": "ls -la"/)).toBeInTheDocument()
  })

  it('calls onRespond("allow") when Allow is clicked', async () => {
    const user = userEvent.setup()
    const onRespond = vi.fn()
    render(<ApprovalCard approvalId="ap-1" toolName="bash" summaryJson="{}" onRespond={onRespond} />)
    await user.click(screen.getByRole('button', { name: 'Allow' }))
    expect(onRespond).toHaveBeenCalledOnce()
    expect(onRespond).toHaveBeenCalledWith('allow')
  })

  it('styles Deny with the danger token', () => {
    render(<ApprovalCard approvalId="ap-1" toolName="bash" summaryJson="{}" onRespond={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Deny' }).className).toContain('bg-danger')
  })

  it('calls onRespond("always_allow") when Always allow is clicked', async () => {
    const user = userEvent.setup()
    const onRespond = vi.fn()
    render(<ApprovalCard approvalId="ap-1" toolName="bash" summaryJson="{}" onRespond={onRespond} />)
    await user.click(screen.getByRole('button', { name: 'Always allow' }))
    expect(onRespond).toHaveBeenCalledWith('always_allow')
  })

  it('responds to y/a/n keys while the card is focused', async () => {
    const user = userEvent.setup()
    const onRespond = vi.fn()
    render(<ApprovalCard approvalId="ap-1" toolName="bash" summaryJson="{}" onRespond={onRespond} />)
    const card = screen.getByRole('group', { name: 'Approval requested: bash' })
    card.focus()
    await user.keyboard('y')
    expect(onRespond).toHaveBeenLastCalledWith('allow')
    await user.keyboard('a')
    expect(onRespond).toHaveBeenLastCalledWith('always_allow')
    await user.keyboard('n')
    expect(onRespond).toHaveBeenLastCalledWith('deny')
    expect(onRespond).toHaveBeenCalledTimes(3)
  })
})

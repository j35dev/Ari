import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ApprovalCard, formatApprovalToolName } from './ApprovalCard'

describe('ApprovalCard', () => {
  it.each([
    [{ command: 'pnpm test' }, 'Command', 'pnpm test'],
    [{ file_path: 'src/app.ts' }, 'File', 'src/app.ts'],
  ])('shows ACP raw input details: %j', (rawInput, label, detail) => {
    render(
      <ApprovalCard
        approvalId="acp-1"
        toolName="tool"
        summaryJson={JSON.stringify({ kind: 'execute', rawInput, options: [] })}
        onRespond={vi.fn()}
      />,
    )
    expect(screen.getByText(label)).toBeInTheDocument()
    expect(screen.getByText(detail)).toBeInTheDocument()
  })

  it('does not offer or shortcut persistent approval when ACP only allows once', async () => {
    const user = userEvent.setup()
    const onRespond = vi.fn()
    render(
      <ApprovalCard
        approvalId="acp-1"
        toolName="tool"
        summaryJson={JSON.stringify({ options: [{ kind: 'allow_once', optionId: 'once' }] })}
        onRespond={onRespond}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Always allow' })).not.toBeInTheDocument()
    screen.getByRole('group', { name: 'Approval requested: tool' }).focus()
    await user.keyboard('a')
    expect(onRespond).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Allow' }))
    expect(onRespond).toHaveBeenCalledWith('allow')
  })

  it('offers persistent approval when ACP advertises it', () => {
    render(
      <ApprovalCard
        approvalId="acp-1"
        toolName="tool"
        summaryJson={JSON.stringify({ options: [{ kind: 'allow_always', optionId: 'always' }] })}
        onRespond={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: 'Always allow' })).toBeInTheDocument()
  })

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
    render(
      <ApprovalCard approvalId="ap-1" toolName="bash" summaryJson="{}" onRespond={onRespond} />,
    )
    await user.click(screen.getByRole('button', { name: 'Allow' }))
    expect(onRespond).toHaveBeenCalledOnce()
    expect(onRespond).toHaveBeenCalledWith('allow')
  })

  it('styles Deny with the danger token', () => {
    render(<ApprovalCard approvalId="ap-1" toolName="bash" summaryJson="{}" onRespond={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Deny' }).className).toContain('text-danger')
  })

  it('humanizes underscored tool names', () => {
    render(
      <ApprovalCard
        approvalId="ap-1"
        toolName="Ari_delegation"
        summaryJson="{}"
        onRespond={vi.fn()}
      />,
    )
    expect(screen.getByText('Ari delegation')).toBeInTheDocument()
    expect(formatApprovalToolName('Ari_delegation')).toBe('Ari delegation')
  })

  it('calls onRespond("always_allow") when Always allow is clicked', async () => {
    const user = userEvent.setup()
    const onRespond = vi.fn()
    render(
      <ApprovalCard approvalId="ap-1" toolName="bash" summaryJson="{}" onRespond={onRespond} />,
    )
    await user.click(screen.getByRole('button', { name: 'Always allow' }))
    expect(onRespond).toHaveBeenCalledWith('always_allow')
  })

  it('responds to y/a/n keys while the card is focused', async () => {
    const user = userEvent.setup()
    const onRespond = vi.fn()
    render(
      <ApprovalCard approvalId="ap-1" toolName="bash" summaryJson="{}" onRespond={onRespond} />,
    )
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

  it('extracts a command headline for shell-like tools', () => {
    render(
      <ApprovalCard
        approvalId="ap-1"
        toolName="bash"
        summaryJson='{"command":"rm -rf dist","cwd":"/repo"}'
        onRespond={vi.fn()}
      />,
    )
    expect(screen.getByText('Command')).toBeInTheDocument()
    expect(screen.getByText('rm -rf dist')).toBeInTheDocument()
  })

  it('falls back to a file headline for file tools', () => {
    render(
      <ApprovalCard
        approvalId="ap-1"
        toolName="edit_file"
        summaryJson='{"path":"src/app.ts"}'
        onRespond={vi.fn()}
      />,
    )
    expect(screen.getByText('File')).toBeInTheDocument()
    expect(screen.getByText('src/app.ts')).toBeInTheDocument()
  })

  it('shows the pending counter only with more than one approval', () => {
    const { rerender } = render(
      <ApprovalCard
        approvalId="ap-1"
        toolName="bash"
        summaryJson="{}"
        position={1}
        total={3}
        onRespond={vi.fn()}
      />,
    )
    expect(screen.getByText('1/3 pending')).toBeInTheDocument()

    rerender(
      <ApprovalCard
        approvalId="ap-1"
        toolName="bash"
        summaryJson="{}"
        position={1}
        total={1}
        onRespond={vi.fn()}
      />,
    )
    expect(screen.queryByText(/pending/)).not.toBeInTheDocument()
  })
})

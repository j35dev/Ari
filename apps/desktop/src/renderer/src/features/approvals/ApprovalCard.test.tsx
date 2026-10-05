import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ApprovalCard, formatApprovalToolName } from './ApprovalCard'

const ONCE_ALWAYS_DENY = [
  { optionId: 'accept', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'acceptForSession', name: 'Allow for this session', kind: 'allow_always' },
  { optionId: 'decline', name: 'Deny', kind: 'reject_once' },
]

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
        options={ONCE_ALWAYS_DENY}
        onRespond={vi.fn()}
      />,
    )
    expect(screen.getByText(label)).toBeInTheDocument()
    expect(screen.getByText(detail)).toBeInTheDocument()
  })

  it('renders one button per offered option and answers with its exact id', async () => {
    const user = userEvent.setup()
    const onRespond = vi.fn()
    render(
      <ApprovalCard
        approvalId="ap-1"
        toolName="bash"
        summaryJson="{}"
        options={ONCE_ALWAYS_DENY}
        onRespond={onRespond}
      />,
    )
    await user.click(screen.getByRole('button', { name: /Allow for this session/ }))
    expect(onRespond).toHaveBeenCalledExactlyOnceWith({ optionId: 'acceptForSession' })
  })

  it('distinguishes two grants that share one kind', async () => {
    const user = userEvent.setup()
    const onRespond = vi.fn()
    render(
      <ApprovalCard
        approvalId="ap-1"
        toolName="bash"
        summaryJson="{}"
        options={[
          { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'allow_session', name: 'Allow for this session', kind: 'allow_always' },
          { optionId: 'allow_prefix', name: 'Allow every git command', kind: 'allow_always' },
          { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
        ]}
        onRespond={onRespond}
      />,
    )
    // Both persistent grants are `allow_always`; the id is what tells them
    // apart, so each has to be its own button.
    await user.click(screen.getByRole('button', { name: /Allow every git command/ }))
    expect(onRespond).toHaveBeenCalledExactlyOnceWith({ optionId: 'allow_prefix' })
    expect(screen.getByRole('button', { name: /Allow for this session/ })).toBeInTheDocument()
  })

  it('offers only what the provider advertised', () => {
    render(
      <ApprovalCard
        approvalId="acp-1"
        toolName="tool"
        summaryJson="{}"
        options={[
          { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ]}
        onRespond={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button', { name: /session/ })).not.toBeInTheDocument()
    expect(screen.getAllByRole('button')).toHaveLength(2)
  })

  it('shortcuts y/a/n onto the first allow, persistent allow, and refusal', async () => {
    const user = userEvent.setup()
    const onRespond = vi.fn()
    render(
      <ApprovalCard
        approvalId="ap-1"
        toolName="bash"
        summaryJson="{}"
        options={ONCE_ALWAYS_DENY}
        onRespond={onRespond}
      />,
    )
    screen.getByRole('group', { name: 'Approval requested: bash' }).focus()
    await user.keyboard('y')
    expect(onRespond).toHaveBeenLastCalledWith({ optionId: 'accept' })
    await user.keyboard('a')
    expect(onRespond).toHaveBeenLastCalledWith({ optionId: 'acceptForSession' })
    await user.keyboard('n')
    expect(onRespond).toHaveBeenLastCalledWith({ optionId: 'decline' })
    expect(onRespond).toHaveBeenCalledTimes(3)
  })

  it('leaves `a` inert when the provider offers no persistent grant', async () => {
    const user = userEvent.setup()
    const onRespond = vi.fn()
    render(
      <ApprovalCard
        approvalId="acp-1"
        toolName="tool"
        summaryJson="{}"
        options={[
          { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ]}
        onRespond={onRespond}
      />,
    )
    screen.getByRole('group', { name: 'Approval requested: tool' }).focus()
    await user.keyboard('a')
    expect(onRespond).not.toHaveBeenCalled()
    await user.keyboard('y')
    expect(onRespond).toHaveBeenCalledExactlyOnceWith({ optionId: 'once' })
  })

  it('falls back to the decision vocabulary for pre-option journals', async () => {
    const user = userEvent.setup()
    const onRespond = vi.fn()
    render(
      <ApprovalCard
        approvalId="ap-1"
        toolName="bash"
        summaryJson="{}"
        options={[]}
        onRespond={onRespond}
      />,
    )
    await user.click(screen.getByRole('button', { name: /Always allow/ }))
    expect(onRespond).toHaveBeenCalledExactlyOnceWith({ decision: 'always-allow' })
  })

  it('renders tool name and pretty-printed summary JSON', () => {
    render(
      <ApprovalCard
        approvalId="ap-1"
        toolName="bash"
        summaryJson='{"command":"ls -la","cwd":"/tmp"}'
        options={ONCE_ALWAYS_DENY}
        onRespond={vi.fn()}
      />,
    )
    expect(screen.getByRole('group', { name: 'Approval requested: bash' })).toBeInTheDocument()
    expect(screen.getByText(/"command": "ls -la"/)).toBeInTheDocument()
  })

  it('styles refusals with the danger token', () => {
    render(
      <ApprovalCard
        approvalId="ap-1"
        toolName="bash"
        summaryJson="{}"
        options={ONCE_ALWAYS_DENY}
        onRespond={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: /Deny/ }).className).toContain('text-danger')
  })

  it('humanizes underscored tool names', () => {
    render(
      <ApprovalCard
        approvalId="ap-1"
        toolName="Ari_delegation"
        summaryJson="{}"
        options={[
          { optionId: 'delegation_allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'delegation_deny', name: 'Deny', kind: 'reject_once' },
        ]}
        onRespond={vi.fn()}
      />,
    )
    expect(screen.getByText('Ari delegation')).toBeInTheDocument()
    expect(formatApprovalToolName('Ari_delegation')).toBe('Ari delegation')
  })

  it('prints the shortcut letter as the button title for pointer users', () => {
    render(
      <ApprovalCard
        approvalId="ap-1"
        toolName="bash"
        summaryJson="{}"
        options={[
          { optionId: 'acceptForSession', name: 'Allow for this session', kind: 'allow_always' },
        ]}
        onRespond={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: /Allow for this session/ })).toHaveAttribute(
      'title',
      'Allow for this session (A)',
    )
  })

  it('extracts a command headline for shell-like tools', () => {
    render(
      <ApprovalCard
        approvalId="ap-1"
        toolName="bash"
        summaryJson='{"command":"rm -rf dist","cwd":"/repo"}'
        options={ONCE_ALWAYS_DENY}
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
        options={ONCE_ALWAYS_DENY}
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
        options={ONCE_ALWAYS_DENY}
        position={1}
        total={3}
        onRespond={vi.fn()}
      />,
    )
    expect(screen.getByText('1/3')).toBeInTheDocument()

    rerender(
      <ApprovalCard
        approvalId="ap-1"
        toolName="bash"
        summaryJson="{}"
        options={ONCE_ALWAYS_DENY}
        position={1}
        total={1}
        onRespond={vi.fn()}
      />,
    )
    expect(screen.queryByText('1/1')).not.toBeInTheDocument()
  })
})

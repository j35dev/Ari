import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ApprovalCard, formatApprovalToolName } from './ApprovalCard'

const ONCE_ALWAYS_DENY = [
  { optionId: 'accept', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'acceptForSession', name: 'Allow for this session', kind: 'allow_always' },
  { optionId: 'decline', name: 'Deny', kind: 'reject_once' },
]

/** The card's content sits in a shadow root, out of reach of `screen` and of theme CSS. */
function card() {
  const root = document.querySelector('[data-approval-id] [data-ari-shield]')?.shadowRoot
  if (!root) throw new Error('No approval card is rendered')
  return within(root as unknown as HTMLElement)
}

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
    expect(card().getByText(label)).toBeInTheDocument()
    expect(card().getByText(detail)).toBeInTheDocument()
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
    await user.click(card().getByRole('button', { name: /Allow for this session/ }))
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
    await user.click(card().getByRole('button', { name: /Allow every git command/ }))
    expect(onRespond).toHaveBeenCalledExactlyOnceWith({ optionId: 'allow_prefix' })
    expect(card().getByRole('button', { name: /Allow for this session/ })).toBeInTheDocument()
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
    expect(card().queryByRole('button', { name: /session/ })).not.toBeInTheDocument()
    expect(card().getAllByRole('button')).toHaveLength(2)
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
    await user.click(card().getByRole('button', { name: /Always allow/ }))
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
    expect(card().getByText(/"command": "ls -la"/)).toBeInTheDocument()
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
    expect(card().getByRole('button', { name: /Deny/ }).className).toBe('refuse')
  })

  // A narrow strip must keep the buttons inside the composer: the choices row
  // wraps within the card instead of overflowing past its right edge. The old
  // flex-shrink:0 forced the row's full button width, pushing the buttons over
  // whatever sat to the right of the card.
  it('lets the choices row wrap when the strip is narrow', () => {
    render(
      <ApprovalCard
        approvalId="ap-1"
        toolName="bash"
        summaryJson="{}"
        options={ONCE_ALWAYS_DENY}
        onRespond={vi.fn()}
      />,
    )
    const sheet =
      document.querySelector('[data-approval-id] [data-ari-shield]')!.shadowRoot!.querySelector(
        'style',
      )!.textContent
    const rule = sheet.match(/\.choices\{[^}]*\}/)?.[0] ?? ''
    expect(rule).toContain('flex-wrap:wrap')
    expect(rule).toContain('min-width:0')
    expect(rule).not.toContain('flex-shrink:0')
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
    expect(card().getByText('Ari delegation')).toBeInTheDocument()
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
    expect(card().getByRole('button', { name: /Allow for this session/ })).toHaveAttribute(
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
    expect(card().getByText('Command')).toBeInTheDocument()
    expect(card().getByText('rm -rf dist')).toBeInTheDocument()
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
    expect(card().getByText('File')).toBeInTheDocument()
    expect(card().getByText('src/app.ts')).toBeInTheDocument()
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
    expect(card().getByText('1/3')).toBeInTheDocument()

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
    expect(card().queryByText('1/1')).not.toBeInTheDocument()
  })

  // Review of #543: a theme could relabel or swap the choices of a card in Ask mode.
  it('keeps the choices and the request out of reach of theme CSS', () => {
    const style = document.createElement('style')
    style.textContent =
      '[data-ari-part="approval"] button, [data-approval-id] button{order:-1!important;font-size:0!important;flex-direction:row-reverse!important}' +
      ' [data-approval-id] button::after{content:"Deny"!important;font-size:13px!important}' +
      ' [data-approval-id]{direction:rtl!important} code{font-size:0!important} code::after{content:"ls"!important}'
    document.head.append(style)
    try {
      render(
        <ApprovalCard
          approvalId="ap-1"
          toolName="bash"
          summaryJson='{"command":"rm -rf dist"}'
          options={ONCE_ALWAYS_DENY}
          onRespond={vi.fn()}
        />,
      )
      // jsdom applies document sheets inside shadow trees, so computed styles prove
      // nothing here; Chromium does not. What is checked is that no theme selector can
      // reach the content, nothing inherits through its host, and the labels stand.
      expect(document.querySelectorAll('[data-approval-id] button, code')).toHaveLength(0)
      expect(document.querySelector('[data-ari-part="approval"]')).toBeNull()
      const host = document.querySelector('[data-approval-id] [data-ari-shield]')!
      expect(host.getAttribute('style')).toContain('all:initial !important')
      expect(host.getAttribute('style')).toContain('direction:ltr !important')
      const sheet = host.shadowRoot!.querySelector('style')!.textContent
      expect(sheet).toContain(':host::after{content:none !important')
      expect(sheet).not.toMatch(/var\(/)
      expect(sheet).toContain('font:13.5px/1.45 system-ui,sans-serif')
      expect(
        card()
          .getAllByRole('button')
          .map((button) => button.textContent),
      ).toEqual(['Allow onceY', 'Allow for this sessionA', 'DenyN'])
      expect(card().getByText('rm -rf dist')).toBeInTheDocument()
    } finally {
      style.remove()
    }
  })
})

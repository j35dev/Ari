// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RemoteApproval, RemoteInput } from '@ari/contracts/remote'
import { AttentionDock } from './AttentionDock'

afterEach(cleanup)

const commit: RemoteApproval = {
  approvalId: 'ap_1',
  toolName: 'Bash',
  summaryJson: JSON.stringify({
    command: 'git commit -am "fix(ui): pair the installed app with a typed code"',
    description: 'Commit the pairing fix',
  }),
  options: [
    { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'always', name: 'Always allow git commit', kind: 'allow_always' },
    { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
  ],
}
const edit: RemoteApproval = {
  approvalId: 'ap_2',
  toolName: 'Edit',
  summaryJson: JSON.stringify({ file_path: 'apps/mobile/src/App.tsx' }),
  options: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' }],
}
const question: RemoteInput = { inputId: 'in_1', prompt: 'Which branch?', choicesJson: null }

function dock(
  approvals: RemoteApproval[],
  inputs: RemoteInput[] = [],
): { onApprove: ReturnType<typeof vi.fn>; onAnswer: ReturnType<typeof vi.fn> } {
  const handlers = {
    onApprove: vi.fn(async () => {}),
    onAnswer: vi.fn(async () => {}),
  }
  render(<AttentionDock approvals={approvals} inputs={inputs} {...handlers} />)
  return handlers
}

describe('what the agent is waiting on', () => {
  it('asks in plain words, showing the whole command it wants to run', () => {
    dock([commit])
    expect(screen.getByRole('heading', { name: 'Run this command?' })).toBeTruthy()
    expect(
      screen.getByText('git commit -am "fix(ui): pair the installed app with a typed code"'),
    ).toBeTruthy()
  })

  it('offers the provider’s own choices and sends back the one picked', async () => {
    const { onApprove } = dock([commit])
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(
      expect.arrayContaining(['Allow once', 'Always allow git commit', 'Deny']),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Always allow git commit' }))
    expect(onApprove).toHaveBeenCalledWith('ap_1', 'always')
    await waitFor(() =>
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Deny' }).disabled).toBe(false),
    )
  })

  it('locks the choices while one is being sent', () => {
    const handlers = { onApprove: vi.fn(() => new Promise<void>(() => {})), onAnswer: vi.fn() }
    render(<AttentionDock approvals={[commit]} inputs={[]} {...handlers} />)
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    expect(handlers.onApprove).toHaveBeenCalledOnce()
  })

  it('keeps the exact request one tap away', () => {
    dock([commit])
    expect(screen.queryByText(/"description": "Commit the pairing fix"/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show full request' }))
    expect(screen.getByText(/"description": "Commit the pairing fix"/)).toBeTruthy()
  })

  it('takes several requests one at a time, saying how many there are', () => {
    dock([commit, edit], [question])
    expect(screen.getByText('1 of 3')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Edit this file?' })).toBeNull()
  })

  it('names a tool it has no plain words for, rather than guessing from its name', () => {
    dock([
      {
        ...edit,
        toolName: 'mcp__deploy_preview',
        summaryJson: JSON.stringify({ path: 'apps/site' }),
      },
    ])
    expect(screen.getByRole('heading', { name: 'Allow mcp deploy preview?' })).toBeTruthy()
    expect(screen.getByText('apps/site')).toBeTruthy()
  })

  it('asks about a file edit in plain words', () => {
    dock([edit])
    expect(screen.getByRole('heading', { name: 'Edit this file?' })).toBeTruthy()
    expect(screen.getByText('apps/mobile/src/App.tsx')).toBeTruthy()
  })

  it('asks the agent’s question and sends a typed answer', () => {
    const { onAnswer } = dock([], [question])
    expect(screen.getByText('Which branch?')).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: 'Your answer' }), {
      target: { value: 'main' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }))
    expect(onAnswer).toHaveBeenCalledWith('in_1', 'main')
  })

  it('offers the agent’s own choices when it gave some', () => {
    const { onAnswer } = dock(
      [],
      [{ ...question, choicesJson: JSON.stringify(['main', 'release/0.3']) }],
    )
    fireEvent.click(screen.getByRole('button', { name: 'release/0.3' }))
    expect(onAnswer).toHaveBeenCalledWith('in_1', 'release/0.3')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('says why an answer did not go through and lets it be tried again', async () => {
    const handlers = {
      onApprove: vi.fn(async () => {
        throw new Error('Reconnect before answering.')
      }),
      onAnswer: vi.fn(),
    }
    render(<AttentionDock approvals={[commit]} inputs={[]} {...handlers} />)
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Reconnect before answering.')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Allow once' }).disabled).toBe(
      false,
    )
  })
})

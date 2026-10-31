import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { OnboardingChoice } from './onboarding-completion'
import { OnboardingFrame } from './OnboardingFrame'
import { OnboardingReady } from './OnboardingReady'

const choice: OnboardingChoice = {
  projects: [{ path: '/work/Ari', name: 'Ari', sources: ['claude'], lastUsedAt: null }],
  driverKind: 'claude',
  permissionMode: 'ask',
  createSession: true,
}

describe('onboarding review surface', () => {
  it('reviews only the selected folders and makes the empty session optional', () => {
    const onChange = vi.fn()
    render(<OnboardingReady choice={choice} disabled={false} onCreateSessionChange={onChange} />)
    expect(screen.getByText('Claude Code')).toBeInTheDocument()
    expect(screen.getByText('/work/Ari')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Open an empty session in Ari' }))
    expect(onChange).toHaveBeenCalledWith(false)
  })
  it('explains a skipped agent and project without offering a session that cannot be created', () => {
    render(
      <OnboardingReady
        choice={{ ...choice, projects: [], driverKind: null }}
        disabled={false}
        onCreateSessionChange={vi.fn()}
      />,
    )
    expect(screen.getByText('Choose later')).toBeInTheDocument()
    expect(screen.getByText(/Add your first folder/)).toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })
  it('exposes progress and permits leaving a failed attempt while locking its choices', () => {
    const onStep = vi.fn()
    const onDismiss = vi.fn()
    const { rerender } = render(
      <OnboardingFrame step={1} onStep={onStep} onDismiss={onDismiss} dismissLabel="Leave setup">
        Review
      </OnboardingFrame>,
    )
    expect(screen.getByRole('button', { name: 'Your projects' })).toHaveAttribute(
      'aria-current',
      'step',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Your agents' }))
    expect(onStep).toHaveBeenCalledWith(0)
    rerender(
      <OnboardingFrame
        step={1}
        navigationLocked
        onStep={onStep}
        onDismiss={onDismiss}
        dismissLabel="Leave setup"
      >
        Review
      </OnboardingFrame>,
    )
    expect(screen.getByRole('button', { name: 'Your agents' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Leave setup' }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })
})

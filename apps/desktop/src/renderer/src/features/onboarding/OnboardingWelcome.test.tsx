import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { OnboardingWelcome } from './OnboardingWelcome'

afterEach(cleanup)
const agent = (kind: string, authStatus = 'authenticated') => ({
  kind,
  installed: true,
  binaryPath: `/bin/${kind}`,
  version: '1.0.0',
  authStatus,
})

describe('onboarding welcome', () => {
  it('names each usable agent found, signed-in ones first', () => {
    render(
      <OnboardingWelcome
        detections={[
          agent('codex', 'unknown'),
          agent('claude'),
          { ...agent('pi'), installed: false },
        ]}
        scanning={false}
        headingRef={() => undefined}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Welcome to Ari' })).toBeInTheDocument()
    const lines = screen.getAllByRole('listitem').map((item) => item.textContent)
    expect(lines).toEqual(['Found Claude Code', 'Found Codex'])
  })

  it('says it is looking, then that it will help when nothing is installed', () => {
    const view = render(
      <OnboardingWelcome detections={null} scanning headingRef={() => undefined} />,
    )
    expect(screen.getByRole('status')).toHaveTextContent('Looking for coding agents')
    view.rerender(
      <OnboardingWelcome detections={[]} scanning={false} headingRef={() => undefined} />,
    )
    expect(screen.getByRole('status')).toHaveTextContent('Ari will help you get one')
  })
})

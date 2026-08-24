import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProvidersView } from './ProvidersView'

const { invokeFn } = vi.hoisted(() => ({ invokeFn: vi.fn() }))

vi.mock('../../lib/rpc', () => ({
  rpc: {
    invoke: invokeFn,
    subscribe: vi.fn(() => () => undefined),
  },
}))

interface DetectionFixture {
  kind: string
  installed: boolean
  binaryPath: string | null
  version: string | null
  authStatus: string
}

const DETECTIONS: DetectionFixture[] = [
  {
    kind: 'claude',
    installed: true,
    binaryPath: 'C:\\bin\\claude.exe',
    version: '2.1.0 (Claude Code)',
    authStatus: 'authenticated',
  },
  { kind: 'codex', installed: false, binaryPath: null, version: null, authStatus: 'unknown' },
  {
    kind: 'opencode',
    installed: true,
    binaryPath: '/usr/local/bin/opencode',
    version: '0.4.2',
    authStatus: 'unknown',
  },
  { kind: 'ari-core', installed: true, binaryPath: null, version: null, authStatus: 'authenticated' },
]

function cardFor(title: string): HTMLElement {
  const card = screen.getByText(title).closest('li')
  if (card === null) throw new Error(`No card found for ${title}`)
  return card
}

describe('ProvidersView', () => {
  beforeEach(() => {
    invokeFn.mockReset()
  })

  it('renders a card per detected provider with version, path, and auth badge', async () => {
    invokeFn.mockResolvedValueOnce(DETECTIONS)
    render(<ProvidersView />)

    expect(await screen.findByText('Claude')).toBeInTheDocument()
    expect(invokeFn).toHaveBeenCalledWith('providers.detect')

    const claudeCard = cardFor('Claude')
    expect(within(claudeCard).getByText('2.1.0 (Claude Code)')).toHaveClass(
      'font-mono',
      'text-2xs',
      'text-fg-subtle',
    )
    expect(screen.getByTitle('C:\\bin\\claude.exe')).toBeInTheDocument()
    expect(within(claudeCard).getByText('authenticated')).toHaveClass(
      'bg-success-subtle',
      'text-success',
    )

    const opencodeCard = cardFor('Opencode')
    expect(within(opencodeCard).getByText('unknown')).toHaveClass(
      'bg-surface-2',
      'text-fg-muted',
    )
  })

  it('styles missing binaries as not installed and special-cases ari-core', async () => {
    invokeFn.mockResolvedValueOnce(DETECTIONS)
    render(<ProvidersView />)

    await screen.findByText('Ari Core (built-in)')

    const codexCard = cardFor('Codex')
    expect(within(codexCard).getByText('not installed')).toHaveClass('text-danger')
    // A missing binary is never reported as logged out: install and auth are
    // independent axes, so the auth verdict stays honestly unknown.
    expect(within(codexCard).queryByText('unauthenticated')).toBeNull()
    expect(within(codexCard).getByText('unknown')).toHaveClass('bg-surface-2', 'text-fg-muted')

    const coreCard = cardFor('Ari Core (built-in)')
    expect(within(coreCard).getByText('authenticated')).toHaveClass(
      'bg-success-subtle',
      'text-success',
    )
    expect(
      within(coreCard).getByText(/manage them in the Endpoints section below/i),
    ).toBeInTheDocument()
  })

  it('explains unknown auth status via tooltip', async () => {
    invokeFn.mockResolvedValueOnce(DETECTIONS)
    const user = userEvent.setup()
    render(<ProvidersView />)

    await screen.findByText('Opencode')
    await user.hover(within(cardFor('Opencode')).getByText('unknown'))

    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip).toHaveTextContent('Ari could not verify - the CLI manages its own login')
  })

  it('re-scan refetches providers.detect and shows progress while scanning', async () => {
    invokeFn.mockResolvedValueOnce(DETECTIONS)
    let resolveRescan: (value: DetectionFixture[]) => void = () => undefined
    invokeFn.mockImplementationOnce(() => new Promise((resolve) => (resolveRescan = resolve)))
    const user = userEvent.setup()
    render(<ProvidersView />)

    await screen.findByText('Claude')

    await user.click(screen.getByRole('button', { name: 'Re-scan' }))
    const rescanButton = screen.getByRole('button', { name: 'Re-scan' })
    expect(rescanButton).toBeDisabled()
    expect(rescanButton.querySelector('.animate-spin')).not.toBeNull()

    resolveRescan([
      {
        kind: 'grok',
        installed: true,
        binaryPath: '/usr/bin/grok',
        version: '1.0.0',
        authStatus: 'unknown',
      },
    ])
    expect(await screen.findByText('Grok')).toBeInTheDocument()
    expect(invokeFn).toHaveBeenCalledTimes(2)
    expect(invokeFn).toHaveBeenNthCalledWith(2, 'providers.detect')
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Re-scan' })).toBeEnabled()
    })
  })
})

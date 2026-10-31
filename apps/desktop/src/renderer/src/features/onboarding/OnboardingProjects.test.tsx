import { StrictMode, useState } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiscoveredProject } from '@ari/contracts/project'
import { OnboardingProjects } from './OnboardingProjects'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('../../lib/rpc', () => ({ rpc: { invoke } }))
const ari: DiscoveredProject = {
  path: 'C:\\work\\Ari',
  name: 'Ari',
  sources: ['claude'],
  lastUsedAt: 123,
}
const docs: DiscoveredProject = {
  path: 'C:\\work\\Docs',
  name: 'Docs',
  sources: ['codex'],
  lastUsedAt: null,
}
const discovery = { projects: [ari, docs], truncated: false, warnings: [] }
function Picker() {
  const [selected, onChange] = useState<DiscoveredProject[]>([])
  return <OnboardingProjects selected={selected} onChange={onChange} />
}
beforeEach(() => {
  invoke.mockReset()
  invoke.mockImplementation(async (method: string) =>
    method === 'project.discover' ? discovery : { path: null },
  )
})

describe('onboarding projects', () => {
  it('requires explicit selection and never opens a folder while browsing suggestions', async () => {
    render(<Picker />)
    const checkbox = await screen.findByRole('checkbox', { name: /Add Ari/ })
    expect(checkbox).not.toBeChecked()
    fireEvent.click(screen.getByText('Ari'))
    expect(checkbox).toBeChecked()
    expect(invoke.mock.calls.every(([method]) => method === 'project.discover')).toBe(true)
  })

  it('selects only search matches and preserves selections outside the filter', async () => {
    render(<Picker />)
    fireEvent.click(await screen.findByRole('checkbox', { name: /Add Ari/ }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'docs' } })
    fireEvent.click(screen.getByRole('button', { name: 'Select matches' }))
    expect(screen.getByRole('status')).toHaveTextContent('2 selected')
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }))
    expect(screen.getByRole('status')).toHaveTextContent('1 selected')
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } })
    expect(screen.getByRole('checkbox', { name: /Add Ari/ })).toBeChecked()
  })

  it('deduplicates manual Windows paths against discoveries and retains manual choices on rescan', async () => {
    render(<Picker />)
    await screen.findByRole('checkbox', { name: /Add Ari/ })
    invoke.mockResolvedValueOnce({ path: 'c:/WORK/ari/' })
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }))
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /Add Ari/ })).toBeChecked())
    expect(screen.getAllByRole('checkbox')).toHaveLength(2)
    invoke.mockResolvedValueOnce({ projects: [], truncated: false, warnings: [] })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh projects' }))
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(1))
    expect(screen.getByRole('checkbox')).toBeChecked()
  })

  it('keeps current selections when a folder dialog answers after a refresh', async () => {
    render(<Picker />)
    await screen.findByRole('checkbox', { name: /Add Ari/ })
    let pick!: (value: { path: string }) => void
    invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          pick = resolve
        }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Add Docs/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh projects' }))
    await act(async () => {
      pick({ path: '/work/new' })
    })
    expect(screen.getByRole('checkbox', { name: /Add Docs/ })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /Add new/ })).toBeChecked()
    expect(screen.getByRole('button', { name: 'Choose folder' })).toBeEnabled()
  })

  it('treats picker cancellation as a no-op and offers retry after failure', async () => {
    render(<Picker />)
    await screen.findByRole('checkbox', { name: /Add Ari/ })
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Choose folder' })).toBeEnabled())
    expect(screen.getByRole('status')).toHaveTextContent('0 selected')
    invoke.mockRejectedValueOnce(new Error('dialog unavailable'))
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not open the folder picker')
  })

  it('offers browse and rescan after discovery fails', async () => {
    invoke.mockRejectedValueOnce(new Error('offline'))
    render(<Picker />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not find recent projects')
    expect(screen.getByRole('button', { name: 'Choose folder' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh projects' }))
    expect(await screen.findByRole('checkbox', { name: /Add Ari/ })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('ignores stale StrictMode scans and surfaces partial results', async () => {
    let first!: (value: typeof discovery) => void
    invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          first = resolve
        }),
    )
    invoke.mockResolvedValueOnce({
      ...discovery,
      truncated: true,
      warnings: ['Some metadata could not be read.'],
    })
    render(
      <StrictMode>
        <Picker />
      </StrictMode>,
    )
    await screen.findByText(/Showing a partial scan/)
    await act(async () => {
      first({ ...discovery, projects: [] })
    })
    expect(screen.getAllByRole('checkbox')).toHaveLength(2)
    expect(screen.getByText('Some metadata could not be read.')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'missing' } })
    expect(screen.getByText('No matching projects')).toBeInTheDocument()
  })

  it('does not apply a folder selected after leaving the step', async () => {
    const onChange = vi.fn()
    const { unmount } = render(<OnboardingProjects selected={[]} onChange={onChange} />)
    await screen.findByRole('checkbox', { name: /Add Ari/ })
    let pick!: (value: { path: string }) => void
    invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          pick = resolve
        }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }))
    unmount()
    await act(async () => {
      pick({ path: '/work/new' })
    })
    expect(onChange).not.toHaveBeenCalled()
  })
})

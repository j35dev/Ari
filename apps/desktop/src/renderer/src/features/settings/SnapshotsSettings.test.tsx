import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { defaultSettings } from '@ari/contracts/settings'
import { SnapshotsSettings } from './SnapshotsSettings'

const mocks = vi.hoisted(() => ({ update: vi.fn() }))
vi.mock('./useEngineSettings', () => ({
  useEngineSettings: () => ({ settings: defaultSettings, update: mocks.update }),
}))
beforeEach(() => {
  mocks.update.mockReset().mockResolvedValue(defaultSettings)
  vi.stubGlobal('ari', undefined)
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Win32' })
})
afterEach(() => vi.unstubAllGlobals())
it('starts disabled and enables capture with a usable default chord', async () => {
  render(<SnapshotsSettings />)
  expect(screen.getByRole('switch', { name: 'Enable SnapShots' })).toHaveAttribute(
    'aria-checked',
    'false',
  )
  fireEvent.click(screen.getByRole('switch', { name: 'Enable SnapShots' }))
  await waitFor(() =>
    expect(mocks.update).toHaveBeenCalledWith({
      snapshots: { enabled: true, shortcut: 'ctrl+alt+p' },
    }),
  )
})
it('records, validates and saves only after the user presses Save', async () => {
  render(<SnapshotsSettings />)
  fireEvent.click(screen.getByRole('button', { name: 'Record SnapShots shortcut' }))
  fireEvent.keyDown(window, { code: 'KeyK', key: 'k', ctrlKey: true })
  expect(screen.getByRole('alert')).toHaveTextContent('already used by Ari')
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  fireEvent.keyDown(window, { code: 'KeyP', key: 'p', ctrlKey: true, shiftKey: true })
  expect(mocks.update).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() =>
    expect(mocks.update).toHaveBeenCalledWith({ snapshots: { shortcut: 'ctrl+shift+p' } }),
  )
})
it('shows an OS registration refusal and keeps recording available', async () => {
  mocks.update.mockRejectedValue(new Error('This shortcut could not be registered.'))
  render(<SnapshotsSettings />)
  fireEvent.click(screen.getByRole('button', { name: 'Record SnapShots shortcut' }))
  fireEvent.keyDown(window, { code: 'F12', key: 'F12' })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('could not be registered')
  expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
})

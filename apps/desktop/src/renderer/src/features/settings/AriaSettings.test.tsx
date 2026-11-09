import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { defaultSettings } from '@ari/contracts/settings'
import { AriaSettings } from './AriaSettings'

const { update, state } = vi.hoisted(() => ({
  update: vi.fn(),
  state: { settings: {} as typeof defaultSettings },
}))
vi.mock('./useEngineSettings', () => ({
  useEngineSettings: () => ({ settings: state.settings, update }),
}))
vi.mock('../composer/ModelSelector', () => ({
  ModelSelector: ({ onChange }: { onChange: (next: unknown) => void }) => (
    <button onClick={() => onChange({ driverKind: 'claude', modelId: 'opus' })}>
      Choose provider and model
    </button>
  ),
}))
vi.mock('../session/SessionView', () => ({
  EffortChip: ({ onChange }: { onChange: (next: string) => void }) => (
    <button onClick={() => onChange('high')}>Choose effort</button>
  ),
  PermissionModeChip: ({ onChange }: { onChange: (next: string) => void }) => (
    <button onClick={() => onChange('allow-edits')}>Choose permission</button>
  ),
}))

beforeEach(() => {
  state.settings = {
    ...defaultSettings,
    aria: { driverKind: 'codex', modelId: 'gpt-6', effort: 'medium', permissionMode: 'ask' },
  }
  update.mockReset().mockResolvedValue(defaultSettings)
})

it('persists Aria provider, model, effort and permission choices and resets to null', async () => {
  render(<AriaSettings />)
  await userEvent.click(screen.getByRole('button', { name: 'Choose provider and model' }))
  expect(update).toHaveBeenLastCalledWith({
    aria: { driverKind: 'claude', modelId: 'opus', effort: null, permissionMode: 'ask' },
  })
  await userEvent.click(screen.getByRole('button', { name: 'Choose effort' }))
  expect(update).toHaveBeenLastCalledWith({ aria: { ...state.settings.aria, effort: 'high' } })
  await userEvent.click(screen.getByRole('button', { name: 'Choose permission' }))
  expect(update).toHaveBeenLastCalledWith({
    aria: { ...state.settings.aria, permissionMode: 'allow-edits' },
  })
  await userEvent.click(screen.getByRole('button', { name: 'Use session defaults' }))
  expect(update).toHaveBeenLastCalledWith({ aria: null })
})

it('starts unset and makes save failures visible', async () => {
  state.settings = defaultSettings
  update.mockRejectedValue(new Error('offline'))
  render(<AriaSettings />)
  expect(screen.getByRole('button', { name: 'Use session defaults' })).toBeDisabled()
  await userEvent.click(screen.getByRole('button', { name: 'Choose effort' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not save Aria settings')
})

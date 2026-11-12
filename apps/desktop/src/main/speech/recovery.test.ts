// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ show: vi.fn(), copy: vi.fn() }))
vi.mock('electron', () => ({
  dialog: { showMessageBox: mock.show },
  clipboard: { writeText: mock.copy },
}))
import { recoverDictation } from './recovery'

beforeEach(() => {
  mock.show.mockReset().mockResolvedValue({ response: 1 })
  mock.copy.mockReset()
})

it('keeps full speech available for review without automatically replacing the clipboard', async () => {
  const transcript = 'Please keep gpt-6-astra.\n\n1. Check useSpeech.\n2. Keep D:\\Projects\\Ari.'
  await recoverDictation(transcript)
  expect(mock.show).toHaveBeenCalledWith(
    expect.objectContaining({ detail: transcript, defaultId: 1, cancelId: 1 }),
  )
  expect(mock.copy).not.toHaveBeenCalled()
})

it('copies the full result only after the user selects Copy dictated text', async () => {
  mock.show.mockResolvedValue({ response: 0 })
  await recoverDictation('原文。\n\nKeep useSpeech.')
  expect(mock.copy).toHaveBeenCalledExactlyOnceWith('原文。\n\nKeep useSpeech.')
})

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '@ari/contracts/settings'
import { useEngineSettings } from './useEngineSettings'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('../../lib/rpc', () => ({
  rpc: { invoke },
}))

const baseSettings: Settings = {
  version: 1,
  appearance: { themeId: 'obsidian', reducedMotion: false },
  sessions: { defaultDriverKind: null, defaultPermissionMode: 'ask' },
  permissions: { allowlist: [] },
  window: null,
}

describe('useEngineSettings', () => {
  beforeEach(() => {
    invoke.mockReset()
    invoke.mockImplementation((method: string) => {
      if (method === 'settings.get') return Promise.resolve(baseSettings)
      throw new Error(`unexpected method: ${method}`)
    })
  })

  it('loads settings on mount via settings.get', async () => {
    const { result } = renderHook(() => useEngineSettings())
    expect(result.current.settings).toBeNull()
    await waitFor(() => expect(result.current.settings).toEqual(baseSettings))
    expect(invoke).toHaveBeenCalledWith('settings.get')
  })

  it('keeps settings null when the initial load fails', async () => {
    invoke.mockRejectedValue(new Error('engine unavailable'))
    const { result } = renderHook(() => useEngineSettings())
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('settings.get'))
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.settings).toBeNull()
  })

  it('update calls settings.update with the patch and syncs the local copy', async () => {
    const updated: Settings = {
      ...baseSettings,
      appearance: { themeId: 'ember', reducedMotion: true },
    }
    const { result } = renderHook(() => useEngineSettings())
    await waitFor(() => expect(result.current.settings).toEqual(baseSettings))
    invoke.mockResolvedValueOnce(updated)

    let returned: Settings | undefined
    await act(async () => {
      returned = await result.current.update({ appearance: { themeId: 'ember', reducedMotion: true } })
    })

    expect(invoke).toHaveBeenCalledWith('settings.update', {
      appearance: { themeId: 'ember', reducedMotion: true },
    })
    expect(returned).toEqual(updated)
    expect(result.current.settings).toEqual(updated)
  })

  it('update rejections propagate without changing local state', async () => {
    const { result } = renderHook(() => useEngineSettings())
    await waitFor(() => expect(result.current.settings).toEqual(baseSettings))
    invoke.mockRejectedValueOnce(new Error('invalid patch'))

    await expect(
      act(async () => {
        await result.current.update({ permissions: { allowlist: ['git status'] } })
      }),
    ).rejects.toThrow('invalid patch')
    expect(result.current.settings).toEqual(baseSettings)
  })
})

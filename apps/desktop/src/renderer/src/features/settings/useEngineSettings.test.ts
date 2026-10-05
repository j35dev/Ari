import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '@ari/contracts/settings'
import { delegationSettingsSchema } from '@ari/contracts/agent-control'
import { useEngineSettings } from './useEngineSettings'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('../../lib/rpc', () => ({
  rpc: { invoke },
}))

const baseSettings: Settings = {
  version: 1,
  delegation: delegationSettingsSchema.parse({}),
  appearance: {
    themeId: 'obsidian',
    mode: 'system',
    reducedMotion: false,
    wallpaper: 'none',
  },
  sessions: { defaultDriverKind: null, defaultPermissionMode: 'ask' },
  notifications: { settleSound: true },
  permissions: { allowlist: [] },
  remote: { enabled: false, port: 8787, allowedOrigins: [] },
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
      appearance: {
        themeId: 'obsidian',
        mode: 'system',
        reducedMotion: true,
        wallpaper: 'none',
      },
    }
    const { result } = renderHook(() => useEngineSettings())
    await waitFor(() => expect(result.current.settings).toEqual(baseSettings))
    invoke.mockResolvedValueOnce(updated)

    let returned: Settings | undefined
    await act(async () => {
      returned = await result.current.update({
        appearance: { themeId: 'obsidian', mode: 'system', reducedMotion: true },
      })
    })

    expect(invoke).toHaveBeenCalledWith('settings.update', {
      appearance: { themeId: 'obsidian', mode: 'system', reducedMotion: true },
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

  it('broadcasts motion preferences and ignores an older in-flight initial load', async () => {
    const first = renderHook(() => useEngineSettings())
    await waitFor(() => expect(first.result.current.settings).toEqual(baseSettings))
    let resolveLoad: ((value: Settings) => void) | undefined
    invoke.mockImplementationOnce(
      () =>
        new Promise<Settings>((resolve) => {
          resolveLoad = resolve
        }),
    )
    const second = renderHook(() => useEngineSettings())
    const updated = {
      ...baseSettings,
      appearance: { ...baseSettings.appearance, reducedMotion: true },
    }
    invoke.mockResolvedValueOnce(updated)
    await act(async () => {
      await first.result.current.update({ appearance: { reducedMotion: true } })
    })
    expect(second.result.current.settings?.appearance.reducedMotion).toBe(true)
    await act(async () => {
      resolveLoad?.(baseSettings)
    })
    expect(second.result.current.settings).toEqual(updated)
  })
})

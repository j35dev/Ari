import { describe, expect, it } from 'vitest'
import type { AppUpdateFrame } from '@ari/contracts/rpc'
import { reduceUpdateFrame, type AppUpdateState } from './use-app-update'

const IDLE: AppUpdateState = {
  currentVersion: '0.3.0',
  phase: 'idle',
  availableVersion: null,
  stagedVersion: null,
  progress: null,
  error: null,
}

function run(...frames: AppUpdateFrame[]): AppUpdateState {
  return frames.reduce(reduceUpdateFrame, IDLE)
}

describe('reduceUpdateFrame', () => {
  it('tracks the offered release and the version it was measured against', () => {
    const state = run(
      { type: 'checking', manual: true },
      { type: 'available', version: '0.4.0', currentVersion: '0.3.0' },
    )
    expect(state).toMatchObject({
      phase: 'available',
      availableVersion: '0.4.0',
      currentVersion: '0.3.0',
      error: null,
    })
  })

  it('reports being current without discarding the running version', () => {
    const state = run({ type: 'checking', manual: false }, { type: 'none', at: 1_700_000_000_000 })
    expect(state.phase).toBe('current')
    expect(state.currentVersion).toBe('0.3.0')
  })

  it('clears a stale error as soon as new work starts', () => {
    const state = run(
      { type: 'error', message: 'offline' },
      { type: 'checking', manual: true },
    )
    expect(state.error).toBeNull()
    expect(state.phase).toBe('checking')
  })

  it('walks download progress into a staged release', () => {
    const state = run(
      { type: 'available', version: '0.4.0', currentVersion: '0.3.0' },
      { type: 'download.started', version: '0.4.0' },
      { type: 'download.progress', percent: 42 },
      { type: 'downloaded', version: '0.4.0' },
    )
    expect(state).toMatchObject({
      phase: 'ready',
      stagedVersion: '0.4.0',
      availableVersion: null,
      progress: null,
    })
  })

  it('keeps the running version when a download fails', () => {
    const state = run(
      { type: 'available', version: '0.4.0', currentVersion: '0.3.0' },
      { type: 'download.started', version: '0.4.0' },
      { type: 'error', message: 'connection reset' },
    )
    expect(state.phase).toBe('error')
    expect(state.error).toBe('connection reset')
    expect(state.currentVersion).toBe('0.3.0')
  })
})

import { describe, expect, it, vi } from 'vitest'
import { trayTooltip, updateTrayStatus } from './tray-status'

describe('trayTooltip', () => {
  it('reports idle when nothing is running', () => {
    expect(trayTooltip(0)).toBe('Ari — idle')
  })

  it('reports the live running count otherwise', () => {
    expect(trayTooltip(1)).toBe('Ari — 1 running')
    expect(trayTooltip(2)).toBe('Ari — 2 running')
    expect(trayTooltip(12)).toBe('Ari — 12 running')
  })
})

describe('updateTrayStatus', () => {
  it('pushes the count through the sink and tolerates a missing tray', () => {
    const setStatus = vi.fn()
    updateTrayStatus({ setStatus }, 3)
    expect(setStatus).toHaveBeenCalledWith(3)
    expect(() => updateTrayStatus(null, 3)).not.toThrow()
  })
})

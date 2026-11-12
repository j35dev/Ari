// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { selectAutoHost, validateSelection, RESOURCE_FRESH_MS, type SelectionHost } from './machine-policy'
const now = 100_000
const host = (id: string, patch: Partial<SelectionHost> = {}): SelectionHost => ({
  id, name: id, connected: true, compatible: true, hasProject: true, usableCatalog: true,
  preference: 'normal', resources: { sampledAt: now, available: true, cpuUtilization: 0.3,
    availableMemoryBytes: 4 * 1024 ** 3, totalMemoryBytes: 16 * 1024 ** 3 }, ...patch,
})
describe('machine Auto policy', () => {
  it('orders preference tiers before CPU, then memory, then literal stable ID', () => {
    expect(selectAutoHost([host('local'), host('b', { preference: 'prefer' })], now).hostId).toBe('b')
    expect(selectAutoHost([host('z'), host('a')], now).hostId).toBe('a')
    const a = host('a'); const b = host('b'); b.resources!.cpuUtilization = 0.2
    expect(selectAutoHost([a, b], now).hostId).toBe('b')
    b.resources!.cpuUtilization = 0.3; b.resources!.availableMemoryBytes = 5 * 1024 ** 3
    expect(selectAutoHost([a, b], now).hostId).toBe('b')
  })
  it('excludes manual-only, disconnected, incompatible, missing project/catalog, stale and future samples', () => {
    const candidates = [host('manual', { preference: 'manual-only' }), host('offline', { connected: false }),
      host('version', { compatible: false }), host('project', { hasProject: false }),
      host('catalog', { usableCatalog: false }), host('missing', { resources: null })]
    const stale = host('stale'); stale.resources!.sampledAt = now - RESOURCE_FRESH_MS - 1
    const future = host('future'); future.resources!.sampledAt = now + 1
    expect(selectAutoHost([...candidates, stale, future], now).hostId).toBeNull()
  })
  it('requires manual selection for 85% CPU or insufficient memory and never switches during validation', () => {
    const busy = host('busy'); busy.resources!.cpuUtilization = 0.85
    const memory = host('memory'); memory.resources!.availableMemoryBytes = 1.49 * 1024 ** 3
    expect(selectAutoHost([busy, memory], now).hostId).toBeNull()
    expect(validateSelection(busy, true, now)).toContain('Busy')
    expect(validateSelection(busy, false, now)).toBeNull()
    expect(validateSelection(host('manual', { preference: 'manual-only' }), true, now)).toContain('manual')
    const stable = selectAutoHost([host('local')], now)
    expect(validateSelection(host('local'), true, now + RESOURCE_FRESH_MS + 1)).toContain('Fresh')
    expect(stable.hostId).toBe('local')
  })
})

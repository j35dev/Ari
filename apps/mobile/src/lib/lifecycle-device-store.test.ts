import { describe, expect, it, vi } from 'vitest'
import { LifecycleDeviceStore } from './lifecycle-device-store'
import { MemoryDeviceStore } from './device-key'
const record = { deviceId: 'phone', displayName: 'Phone', projectIds: [] }
describe('forgotten credential store generation', () => {
  it('rejects late writes without altering another origin', async () => {
    const base = new MemoryDeviceStore()
    const selected = base.forOrigin('https://one.tailnet.ts.net')
    const other = base.forOrigin('https://two.tailnet.ts.net')
    await other.saveRecord(record)
    const store = new LifecycleDeviceStore(selected)
    await store.clear()
    await expect(store.saveRecord(record)).rejects.toMatchObject({ name: 'AbortError' })
    expect(await selected.loadRecord()).toBeNull()
    expect(await other.loadRecord()).toEqual(record)
  })
  it('ignores a stale identity read that finishes after clear', async () => {
    const base = new MemoryDeviceStore()
    let resolve!: (value: typeof record) => void
    vi.spyOn(base, 'loadRecord').mockImplementation(() => new Promise((done) => { resolve = done }))
    const store = new LifecycleDeviceStore(base)
    const reading = store.loadRecord()
    await store.clear()
    resolve(record)
    expect(await reading).toBeNull()
  })
})

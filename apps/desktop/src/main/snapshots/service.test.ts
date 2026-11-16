// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SnapshotRectangle } from '../../shared/snapshots'
import { SettingsStore } from '@ari/engine/settings'

const electron = vi.hoisted(() => ({
  register: vi.fn<(...args: unknown[]) => boolean>(() => true),
  unregister: vi.fn(),
  handle: vi.fn<(...args: unknown[]) => void>(),
  removeHandler: vi.fn(),
  capture: vi.fn(),
  feedback: vi.fn(),
  main: {
    show: vi.fn(),
    restore: vi.fn(),
    focus: vi.fn(),
    isMinimized: () => true,
    isVisible: () => false,
  },
}))
vi.mock('electron', () => ({
  globalShortcut: { register: electron.register, unregister: electron.unregister },
  ipcMain: { handle: electron.handle, removeHandler: electron.removeHandler },
  BrowserWindow: { fromWebContents: () => electron.main },
}))
vi.mock('./capture', () => ({ captureForegroundWindow: electron.capture }))
vi.mock('./overlay', () => ({
  SnapshotOverlay: class {
    show = electron.feedback
    dispose = vi.fn()
    acknowledge = vi.fn()
    destination = vi.fn()
  },
  containsPoint: (rect: SnapshotRectangle, x: number, y: number) =>
    x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height,
}))
import { SnapshotsService } from './service'
import type { WebContents } from 'electron'
import { AttachmentStore } from '../attachments'

const dirs: string[] = []
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeEach(() => Object.defineProperty(process, 'platform', { value: 'win32' }))
afterEach(async () => {
  Object.defineProperty(process, 'platform', platformDescriptor)
  vi.clearAllMocks()
  electron.register.mockReturnValue(true)
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
it('reports unsupported platforms without registering or enabling capture', async () => {
  const { store, service } = await fixture()
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  await expect(service.updateSettings(store, { snapshots: { enabled: true } })).rejects.toThrow(
    'supports Windows',
  )
  expect(service.status()).toMatchObject({ supported: false, registered: false })
  expect(store.current.snapshots.enabled).toBe(false)
  expect(electron.register).not.toHaveBeenCalled()
  service.dispose()
})
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'ari-snapshot-service-'))
  dirs.push(dir)
  const store = new SettingsStore({ dir })
  await store.load()
  const contents = {
    once: vi.fn(),
    isDestroyed: () => false,
    send: vi.fn(),
    mainFrame: {},
  } as unknown as WebContents
  return {
    store,
    contents,
    service: new SnapshotsService(contents, dir, new AttachmentStore(join(dir, 'attachments'))),
  }
}
it('does not save an enabled preference when the OS refuses registration', async () => {
  const { store, service } = await fixture()
  service.initialize(store.current)
  electron.register.mockReturnValue(false)
  await expect(
    service.updateSettings(store, { snapshots: { enabled: true, shortcut: 'f19' } }),
  ).rejects.toThrow('could not be registered')
  expect(store.current.snapshots.enabled).toBe(false)
  expect(service.status().registered).toBe(false)
  service.dispose()
})
it('captures and persists in the background without restoring, showing or focusing Ari', async () => {
  const { store, contents, service } = await fixture()
  electron.capture.mockResolvedValue({
    bytes: Buffer.from('image'),
    windowTitle: 'External app',
    bounds: { x: 400, y: 100, width: 900, height: 600 },
  })
  await service.updateSettings(store, { snapshots: { enabled: true, shortcut: 'f19' } })
  const capture = electron.register.mock.calls[0]?.[1] as () => void
  capture()
  await vi.waitFor(() =>
    expect(contents.send).toHaveBeenCalledWith('ari:snapshots.event', { type: 'captured' }),
  )
  expect(electron.main.show).not.toHaveBeenCalled()
  expect(electron.main.restore).not.toHaveBeenCalled()
  expect(electron.main.focus).not.toHaveBeenCalled()
  expect(electron.feedback).toHaveBeenCalledWith(
    expect.objectContaining({ bounds: { x: 400, y: 100, width: 900, height: 600 } }),
    expect.anything(),
  )
  const pending = electron.handle.mock.calls.find(
    (call) => call[0] === 'ari:snapshots.pending',
  )?.[1] as (event: unknown) => Promise<unknown>
  expect(await pending({ sender: contents, senderFrame: contents.mainFrame })).toEqual([
    expect.objectContaining({ windowTitle: 'External app', desktopFeedback: true }),
  ])
  service.dispose()
})
it('keeps the active chord and saved preference when a replacement is refused', async () => {
  const { store, service } = await fixture()
  await service.updateSettings(store, { snapshots: { enabled: true, shortcut: 'f19' } })
  electron.register.mockReturnValue(false)
  await expect(service.updateSettings(store, { snapshots: { shortcut: 'f20' } })).rejects.toThrow(
    'could not be registered',
  )
  expect(store.current.snapshots.shortcut).toBe('f19')
  expect(service.status().registered).toBe(true)
  expect(electron.unregister).not.toHaveBeenCalled()
  service.dispose()
})
it('gates capture data and shortcut suppression to the top-level Ari renderer', async () => {
  const { contents, service } = await fixture()
  const handler = electron.handle.mock.calls.find(
    (call) => call[0] === 'ari:snapshots.suppress',
  )?.[1] as (event: unknown, value: unknown) => unknown
  expect(() => handler({ sender: {}, senderFrame: contents.mainFrame }, true)).toThrow('Untrusted')
  expect(() => handler({ sender: contents, senderFrame: {} }, true)).toThrow('Untrusted')
  expect(() => handler({ sender: contents, senderFrame: contents.mainFrame }, true)).not.toThrow()
  service.dispose()
})

// @vitest-environment node
import { EventEmitter } from 'node:events'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { observeLogs } from '@ari/shared/logger'
import { installCrashReporting, reportStartupFailure } from './crash-reporting'

const fixture = vi.hoisted(() => ({
  start: vi.fn(),
  showErrorBox: vi.fn(),
  flush: vi.fn(async () => undefined),
}))
vi.mock('electron', () => ({
  crashReporter: { start: fixture.start },
  dialog: { showErrorBox: fixture.showErrorBox },
}))
vi.mock('./triage/runtime', () => ({ triageLog: () => ({ flush: fixture.flush }) }))

const logged: { level: string; message: string; data: unknown }[] = []
const stop = observeLogs((level, _scope, message, data) => logged.push({ level, message, data }))
afterEach(() => {
  logged.length = 0
  vi.restoreAllMocks()
  vi.clearAllMocks()
})
afterAll(stop)

it('keeps crash dumps local and logs process-level failures without crashing on rejections', () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const target = new EventEmitter() as unknown as NodeJS.Process
  installCrashReporting(target)
  expect(fixture.start).toHaveBeenCalledWith({ uploadToServer: false })

  const rejection = new Error('nobody awaited this')
  expect(() => target.emit('unhandledRejection', rejection, Promise.resolve())).not.toThrow()
  const thrown = new Error('boom')
  target.emit('uncaughtExceptionMonitor', thrown, 'uncaughtException')
  expect(logged).toEqual([
    {
      level: 'error',
      message: 'unhandled promise rejection in the main process',
      data: { error: rejection },
    },
    {
      level: 'error',
      message: 'uncaught exception in the main process',
      data: { error: thrown, origin: 'uncaughtException' },
    },
  ])
})

it('records a startup failure, waits for the log, then explains it in a native dialog', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const order: string[] = []
  fixture.flush.mockImplementationOnce(async () => {
    order.push('flush')
  })
  fixture.showErrorBox.mockImplementationOnce(() => order.push('dialog'))
  const error = new Error('database is locked')
  await reportStartupFailure('Ari failed to start', error)
  expect(logged).toEqual([{ level: 'error', message: 'Ari failed to start', data: { error } }])
  expect(order).toEqual(['flush', 'dialog'])
  expect(fixture.showErrorBox).toHaveBeenCalledWith(
    'Ari could not start',
    expect.stringContaining('Ari failed to start.\n\ndatabase is locked'),
  )
})

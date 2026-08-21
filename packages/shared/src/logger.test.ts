import { describe, expect, it, vi } from 'vitest'
import { createLogger, type LogLevel } from './logger'

type Sink = (level: LogLevel, scope: string, message: string, data?: unknown) => void

describe('logger', () => {
  it('emits at or above the configured level', () => {
    const sink = vi.fn<Sink>()
    const log = createLogger('test', { level: 'warn', sink })
    log.debug('d')
    log.info('i')
    log.warn('w')
    log.error('e')
    expect(sink.mock.calls.map((c) => c[0])).toEqual(['warn', 'error'])
  })

  it('scopes child loggers with colon-separated names', () => {
    const sink = vi.fn<Sink>()
    const log = createLogger('engine', { level: 'info', sink })
    log.child('journal').info('appended')
    expect(sink).toHaveBeenCalledWith('info', 'engine:journal', 'appended', undefined)
  })

  it('passes structured data through to the sink', () => {
    const sink = vi.fn<Sink>()
    const log = createLogger('x', { level: 'debug', sink })
    log.error('failed', { code: 7 })
    expect(sink).toHaveBeenCalledWith('error', 'x', 'failed', { code: 7 })
  })
})

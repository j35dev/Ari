import { describe, expect, it } from 'vitest'
import { CONSOLE_BUFFER_MAX, CONSOLE_TEXT_MAX, ConsoleBuffer } from './browser-console'

describe('ConsoleBuffer', () => {
  it('maps Electron levels and keeps the source when there is one', () => {
    const buffer = new ConsoleBuffer()
    buffer.push({ level: 'info', message: 'info line' }, 10)
    buffer.push({ level: 'warning', message: 'warn line', sourceUrl: 'http://x/app.js' }, 20)
    buffer.push({ level: 'error', message: 'error line', sourceUrl: '   ' }, 30)

    expect(buffer.entries()).toEqual([
      { level: 'info', text: 'info line', timestamp: 10 },
      {
        level: 'warning',
        text: 'warn line',
        timestamp: 20,
        source: 'http://x/app.js',
      },
      { level: 'error', text: 'error line', timestamp: 30 },
    ])
  })

  it('accepts the older numeric levels and maps debug to verbose', () => {
    const buffer = new ConsoleBuffer()
    buffer.push({ level: 1, message: 'info' })
    buffer.push({ level: 9, message: 'unknown' })
    buffer.push({ level: 'debug', message: 'debug' })

    expect(buffer.entries().map((entry) => entry.level)).toEqual(['info', 'info', 'verbose'])
  })

  it('keeps only the newest entries when the cap is hit', () => {
    const buffer = new ConsoleBuffer()
    for (let i = 0; i < CONSOLE_BUFFER_MAX + 5; i++) {
      buffer.push({ level: 3, message: `error ${String(i)}` })
    }

    const entries = buffer.entries()
    expect(entries).toHaveLength(CONSOLE_BUFFER_MAX)
    expect(entries[0]?.text).toBe('error 5')
    expect(entries.at(-1)?.text).toBe(`error ${String(CONSOLE_BUFFER_MAX + 4)}`)
  })

  it('truncates a message longer than the text cap', () => {
    const buffer = new ConsoleBuffer()
    buffer.push({ level: 3, message: 'x'.repeat(CONSOLE_TEXT_MAX + 100) })

    const text = buffer.entries()[0]?.text ?? ''
    expect(text).toHaveLength(CONSOLE_TEXT_MAX)
    expect(text.endsWith('...')).toBe(true)
  })

  it('clears on navigation', () => {
    const buffer = new ConsoleBuffer()
    buffer.push({ level: 3, message: 'before' })
    buffer.clear()
    expect(buffer.entries()).toEqual([])
  })
})

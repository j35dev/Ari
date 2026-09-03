import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalPane } from './TerminalPane'

const { ctorOptions, invokeFn, writelnFn } = vi.hoisted(() => ({
  ctorOptions: [] as Record<string, unknown>[],
  invokeFn: vi.fn(),
  writelnFn: vi.fn(),
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown>
    cols = 80
    rows = 24
    constructor(options: Record<string, unknown>) {
      ctorOptions.push(options)
      this.options = { ...options }
    }
    loadAddon(): void {}
    open(): void {}
    write(): void {}
    writeln(data: string): void {
      writelnFn(data)
    }
    focus(): void {}
    dispose(): void {}
    onData(): { dispose: () => void } {
      return { dispose: () => undefined }
    }
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    activate(): void {}
    dispose(): void {}
    fit(): void {}
  },
}))

vi.mock('../../lib/rpc', () => ({
  rpc: { invoke: invokeFn, subscribe: vi.fn(() => () => undefined) },
}))

function mount(): Record<string, unknown> {
  render(<TerminalPane terminalId="term_1" cwd="/repo" active />)
  const options = ctorOptions[0]
  if (options === undefined) throw new Error('Terminal was never constructed')
  return options
}

describe('TerminalPane', () => {
  beforeEach(() => {
    ctorOptions.length = 0
    invokeFn.mockReset()
    invokeFn.mockResolvedValue(undefined)
    writelnFn.mockClear()
  })

  it('hands xterm a concrete font stack, never a CSS variable', () => {
    const fontFamily = String(mount()['fontFamily'])

    // xterm measures the character cell by assigning `ctx.font` on a canvas,
    // where `var(...)` is rejected outright — the grid would silently end up
    // measured against 10px sans-serif while the rows render in the real font.
    expect(fontFamily).not.toContain('var(')
    expect(fontFamily).toMatch(/monospace$/)
  })

  it('gives rows room to breathe at a legible size', () => {
    const options = mount()

    expect(options['fontSize']).toBe(13)
    expect(options['lineHeight']).toBeGreaterThan(1)
  })

  it('spawns the pty for its own id in the given cwd', () => {
    mount()

    expect(invokeFn).toHaveBeenCalledWith('terminal.create', { id: 'term_1', cwd: '/repo' })
  })

  it('stays idle until a cwd is known', () => {
    render(<TerminalPane terminalId="term_2" cwd={null} active={false} />)

    expect(ctorOptions).toHaveLength(0)
    expect(invokeFn).not.toHaveBeenCalled()
  })

  it('names a rejected create in the pane and reports it for retry', async () => {
    invokeFn.mockRejectedValueOnce(new Error('terminal backend unavailable'))
    const onError = vi.fn()
    render(<TerminalPane terminalId="term_3" cwd="/repo" active onError={onError} />)

    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith('terminal backend unavailable'))
    expect(writelnFn).toHaveBeenCalledOnce()
    expect(String(writelnFn.mock.calls[0]?.[0])).toContain('terminal backend unavailable')
  })
})

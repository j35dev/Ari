import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bindTerminalClipboard } from './terminal-clipboard'

const readText = vi.fn<() => Promise<string>>()
const writeText = vi.fn<(text: string) => Promise<void>>()

function setup() {
  let selectionChanged = (): void => undefined
  let handleKey = (_event: KeyboardEvent): boolean => true
  const term = {
    getSelection: vi.fn(() => ''),
    paste: vi.fn(),
    input: vi.fn(),
    onSelectionChange: (listener: () => void) => {
      selectionChanged = listener
      return { dispose: selectionDispose }
    },
    attachCustomKeyEventHandler: (handler: (event: KeyboardEvent) => boolean) => {
      handleKey = handler
    },
  }
  const selectionDispose = vi.fn()
  const reportError = vi.fn()
  const dispose = bindTerminalClipboard(term, reportError)
  return {
    term, dispose, selectionDispose, reportError,
    select: (text: string) => { term.getSelection.mockReturnValue(text); selectionChanged() },
    key: (key: string, modifiers: KeyboardEventInit = {}, type = 'keydown') => {
      const event = new KeyboardEvent(type, { key, cancelable: true, ...modifiers })
      return { forward: handleKey(event), event }
    },
  }
}

describe('terminal clipboard', () => {
  beforeEach(() => {
    readText.mockReset().mockResolvedValue('first line\nsecond line')
    writeText.mockReset().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { readText, writeText } })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('copies selections automatically without clearing the clipboard on deselection', () => {
    const terminal = setup()
    terminal.select('selected output')
    terminal.select('')
    expect(writeText).toHaveBeenCalledExactlyOnceWith('selected output')
  })

  it.each([
    ['v', { ctrlKey: true }],
    ['V', { ctrlKey: true, shiftKey: true }],
    ['v', { metaKey: true }],
    ['Insert', { shiftKey: true }],
  ])('pastes text through xterm for %s %j without forwarding the control key', async (key, modifiers) => {
    const terminal = setup()
    const result = terminal.key(key, modifiers)
    expect(result.forward).toBe(false)
    expect(result.event.defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(terminal.term.paste).toHaveBeenCalledExactlyOnceWith('first line\nsecond line'))
    terminal.key(key, modifiers, 'keyup')
    expect(readText).toHaveBeenCalledOnce()
  })

  it('copies with Ctrl+C when selected but preserves Ctrl+C interrupt otherwise', () => {
    const terminal = setup()
    expect(terminal.key('c', { ctrlKey: true }).forward).toBe(true)
    terminal.term.getSelection.mockReturnValue('selection')
    expect(terminal.key('c', { ctrlKey: true }).forward).toBe(false)
    expect(writeText).toHaveBeenCalledExactlyOnceWith('selection')
    expect(terminal.key('v', { ctrlKey: true, altKey: true }).forward).toBe(true)
    expect(terminal.key('x').forward).toBe(true)
  })

  it('reports clipboard failures without forwarding Ctrl+V to the CLI', async () => {
    readText.mockRejectedValue(new Error('Access denied'))
    const terminal = setup()
    expect(terminal.key('v', { ctrlKey: true }).forward).toBe(false)
    await vi.waitFor(() => expect(terminal.reportError).toHaveBeenCalledWith(expect.stringContaining('paste failed')))
    expect(terminal.term.paste).not.toHaveBeenCalled()
    writeText.mockRejectedValue(new Error('Access denied'))
    terminal.select('output')
    await vi.waitFor(() => expect(terminal.reportError).toHaveBeenCalledWith(expect.stringContaining('copy failed')))
  })

  it('preserves native CLI image paste on text-free Ctrl+V only', async () => {
    readText.mockResolvedValue('')
    const terminal = setup()
    terminal.key('v', { ctrlKey: true })
    await Promise.resolve()
    expect(terminal.term.paste).not.toHaveBeenCalled()
    expect(terminal.term.input).toHaveBeenCalledExactlyOnceWith('\x16', true)
    terminal.key('V', { ctrlKey: true, shiftKey: true })
    await Promise.resolve()
    expect(terminal.term.input).toHaveBeenCalledOnce()
  })

  it('disposes the selection listener and ignores a pending paste after unmount', async () => {
    let finish = (_text: string): void => undefined
    readText.mockReturnValue(new Promise<string>((resolve) => { finish = resolve }))
    const terminal = setup()
    terminal.key('v', { ctrlKey: true })
    terminal.dispose()
    finish('late paste')
    await Promise.resolve()
    expect(terminal.selectionDispose).toHaveBeenCalledOnce()
    expect(terminal.term.paste).not.toHaveBeenCalled()
  })
})

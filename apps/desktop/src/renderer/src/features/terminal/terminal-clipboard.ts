import type { Terminal } from '@xterm/xterm'
import { createLogger } from '@ari/shared/logger'

const log = createLogger('ui:terminal-clipboard')

/** Copies selections and handles clipboard shortcuts before xterm sends control bytes. */
export function bindTerminalClipboard(
  term: Pick<Terminal, 'getSelection' | 'onSelectionChange' | 'attachCustomKeyEventHandler' | 'paste' | 'input'>,
  reportError: (message: string) => void,
): () => void {
  let disposed = false
  const failed = (action: string, error: unknown): void => {
    log.warn(`clipboard ${action} failed`, { error: String(error) })
    if (!disposed) reportError(`Clipboard ${action} failed. Check clipboard access and try again.`)
  }
  const copy = async (): Promise<void> => {
    const text = term.getSelection()
    if (text.length === 0) return
    try {
      await navigator.clipboard.writeText(text)
    } catch (error) {
      failed('copy', error)
    }
  }
  const paste = async (cliPaste: boolean): Promise<void> => {
    try {
      const text = await navigator.clipboard.readText()
      if (disposed) return
      if (text.length > 0) term.paste(text)
      // A text-free Ctrl+V can still be the CLI's native image-paste shortcut.
      else if (cliPaste) term.input('\x16', true)
    } catch (error) {
      failed('paste', error)
    }
  }
  const selection = term.onSelectionChange(() => { void copy() })
  term.attachCustomKeyEventHandler((event) => {
    if (disposed || event.altKey) return true
    const key = event.key.toLowerCase()
    const modifier = event.ctrlKey || event.metaKey
    const isPaste = (modifier && key === 'v') || (event.shiftKey && key === 'insert')
    const isCopy = modifier && key === 'c' && (event.shiftKey || term.getSelection().length > 0)
    if (!isPaste && !isCopy) return true
    event.preventDefault()
    event.stopPropagation()
    if (event.type === 'keydown') {
      if (isPaste) void paste(event.ctrlKey && !event.shiftKey && !event.metaKey && key === 'v')
      else void copy()
    }
    return false
  })
  return () => {
    disposed = true
    selection.dispose()
  }
}

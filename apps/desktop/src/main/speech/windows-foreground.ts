import koffi from 'koffi'

const foreground = koffi.load('user32.dll').func('void* __stdcall GetForegroundWindow()')

/** Read before the asynchronous UI Automation request; never move focus. */
export function foregroundWindow(): string | null {
  const window: unknown = foreground()
  return window ? koffi.address(window).toString() : null
}

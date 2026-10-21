/** Pause after the first frame before background start-up work begins. */
export const STARTUP_SETTLE_MS = 750

/** Background work starts by this point even if no frame was ever reported. */
export const STARTUP_FALLBACK_MS = 8_000

/**
 * Resolves shortly after the window first paints (`ready-to-show`), or after
 * a fallback delay if it never does. Start-up work nobody waits on — session
 * recovery replays, the browser MCP server — goes behind it, so the renderer's
 * first RPCs are not queued behind it on the main process.
 */
export function afterFirstPaint(
  window: { once(event: 'ready-to-show', listener: () => void): unknown },
  settleMs = STARTUP_SETTLE_MS,
  fallbackMs = STARTUP_FALLBACK_MS,
): Promise<void> {
  return new Promise((resolve) => {
    const fallback = setTimeout(resolve, fallbackMs)
    fallback.unref?.()
    window.once('ready-to-show', () => {
      clearTimeout(fallback)
      setTimeout(resolve, settleMs).unref?.()
    })
  })
}

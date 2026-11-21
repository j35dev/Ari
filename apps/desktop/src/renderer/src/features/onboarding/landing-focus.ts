/**
 * True once nothing covers the composer: the new session can mount under the
 * home view it is replacing. The finished stage does not count, since it
 * ignores the pointer and so `elementFromPoint` looks through it.
 */
function onScreen(field: HTMLTextAreaElement): boolean {
  const box = field.getBoundingClientRect()
  if (box.width === 0 || box.height === 0) return false
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
  const shell = field.closest('.ari-composer-dock') ?? field
  return hit !== null && shell.contains(hit)
}

/**
 * Setup lands in a new session whose composer mounts a few frames later, deep
 * inside the draft pane. Puts the caret there once it exists, unless the user
 * has already focused something else, then reports the landing (also when it
 * gives up after `frames`) so the finished stage can zoom away onto it.
 */
export function focusComposerWhenReady(
  onReady: () => void = () => undefined,
  frames = 600,
): () => void {
  let handle = 0
  let left = frames
  const tick = (): void => {
    const field = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')
    const active = document.activeElement
    // Focus left in the finished stage as it zooms away does not count.
    const elsewhere =
      active instanceof HTMLElement &&
      active !== document.body &&
      active.closest('.ari-onboarding-exit') === null
    if (field && onScreen(field)) {
      if (!elsewhere) field.focus({ preventScroll: true })
      onReady()
      return
    }
    if (--left > 0) handle = requestAnimationFrame(tick)
    else onReady()
  }
  handle = requestAnimationFrame(tick)
  return () => cancelAnimationFrame(handle)
}

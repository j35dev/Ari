/** Track the visible viewport so the composer remains above a phone's software keyboard. */
export function trackViewport(): () => void {
  const viewport = window.visualViewport
  // The tallest the visible area has been at this width. iOS shrinks only the
  // visual viewport for the keyboard, but Android with `resizes-content`
  // shrinks the window too, so comparing the two would never see it open.
  let width = window.innerWidth
  let tallest = 0
  const update = (): void => {
    if (viewport != null && viewport.scale !== 1) return
    const root = document.documentElement
    const height = viewport?.height ?? window.innerHeight
    if (window.innerWidth !== width) {
      // Turning the phone changes what "full height" means.
      width = window.innerWidth
      tallest = 0
    }
    tallest = Math.max(tallest, height, window.innerHeight)
    root.style.setProperty('--ari-mobile-height', `${Math.round(height)}px`)
    root.style.setProperty('--ari-mobile-top', `${Math.round(viewport?.offsetTop ?? 0)}px`)
    root.dataset.keyboard = tallest - height > 120 ? 'open' : 'closed'
  }
  let settling: ReturnType<typeof setTimeout>[] = []
  const settle = (): void => {
    settling.forEach(clearTimeout)
    update()
    // Safari can publish the final geometry only after its keyboard animation.
    settling = [setTimeout(update, 100), setTimeout(update, 500)]
  }
  update()
  viewport?.addEventListener('resize', update)
  viewport?.addEventListener('scroll', update)
  window.addEventListener('resize', update)
  document.addEventListener('focusin', settle)
  document.addEventListener('focusout', settle)
  return () => {
    settling.forEach(clearTimeout)
    viewport?.removeEventListener('resize', update)
    viewport?.removeEventListener('scroll', update)
    window.removeEventListener('resize', update)
    document.removeEventListener('focusin', settle)
    document.removeEventListener('focusout', settle)
  }
}

/** Track the visible viewport so the composer remains above a phone's software keyboard. */
export function trackViewport(): () => void {
  const viewport = window.visualViewport
  const update = (): void => {
    if (viewport != null && viewport.scale !== 1) return
    const root = document.documentElement
    root.style.setProperty(
      '--ari-mobile-height',
      `${Math.round(viewport?.height ?? window.innerHeight)}px`,
    )
    root.style.setProperty('--ari-mobile-top', `${Math.round(viewport?.offsetTop ?? 0)}px`)
    root.dataset.keyboard =
      window.innerHeight - (viewport?.height ?? window.innerHeight) > 100 ? 'open' : 'closed'
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

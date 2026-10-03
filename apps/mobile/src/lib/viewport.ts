/** Track the visible viewport so the composer remains above a phone's software keyboard. */
export function trackViewport(): () => void {
  const viewport = window.visualViewport
  const update = (): void => {
    if (viewport !== null && viewport.scale !== 1) return
    document.documentElement.style.setProperty(
      '--ari-mobile-height',
      `${Math.round(viewport?.height ?? window.innerHeight)}px`,
    )
  }
  update()
  viewport?.addEventListener('resize', update)
  window.addEventListener('resize', update)
  return () => {
    viewport?.removeEventListener('resize', update)
    window.removeEventListener('resize', update)
  }
}

import { openOverlays, subscribeOverlays } from '@ari/ui/overlay-registry'

export interface SessionStartScope {
  spaceId: string
  paneId: string
  sessionId: string | null
}

export interface SessionStartIntent {
  readonly scope: SessionStartScope
  readonly wantsFocus: boolean
  isCurrent: () => boolean
  validate: () => void
  select: (sessionId: string) => boolean
  ready: (input: HTMLTextAreaElement) => void
  dispose: () => void
  cancel: () => void
}

/** Ownership lasts only from an explicit start to its ready editor. */
export function captureSessionStartIntent(
  readScope: () => SessionStartScope,
  panesVisible: () => boolean,
  onDispose: () => void,
): SessionStartIntent {
  const scope = readScope()
  let expected = scope
  const origin = document.activeElement
  const overlays = openOverlays()
  const startingOverlays = new Set(
    overlays.filter((overlay) => {
      const launcherSelector = '[role="dialog"][aria-label="New session"]'
      const launcher = overlay.matches(launcherSelector)
        ? overlay
        : overlay.querySelector(launcherSelector)
      const menu = overlay.matches('[role="menu"]')
        ? overlay
        : overlay.querySelector('[role="menu"]')
      return origin !== null && (launcher?.contains(origin) || menu?.contains(origin))
    }),
  )
  let stale = overlays.some((overlay) => !startingOverlays.has(overlay))
  let disposed = false
  let selected = false
  let wasVisible = panesVisible()
  let focusCancelled = origin?.closest('.xterm') != null
  let input: HTMLTextAreaElement | null = null
  let frame: number | null = null

  const isCurrent = (): boolean => {
    const current = readScope()
    const visible = panesVisible()
    if (
      (wasVisible && !visible) ||
      current.spaceId !== expected.spaceId ||
      current.paneId !== expected.paneId ||
      current.sessionId !== expected.sessionId
    )
      stale = true
    wasVisible ||= visible
    return !stale
  }
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    if (frame !== null) cancelAnimationFrame(frame)
    document.removeEventListener('focusin', onFocus, true)
    document.removeEventListener('pointerdown', onPointer, true)
    document.removeEventListener('keydown', onKey, true)
    unsubscribe()
    onDispose()
  }
  const tryFocus = (): void => {
    frame = null
    if (disposed || input === null) return
    if (
      !isCurrent() ||
      !panesVisible() ||
      focusCancelled ||
      !input.isConnected ||
      input.disabled ||
      input.closest('[hidden], [inert]') !== null
    ) {
      dispose()
      return
    }
    const overlays = openOverlays()
    if (overlays.some((overlay) => !startingOverlays.has(overlay))) {
      stale = true
      dispose()
      return
    }
    // The launching menu may still be exiting. Its registry removal, not a
    // guessed animation delay, releases the handoff.
    if (overlays.length > 0) return
    const active = document.activeElement
    if (active !== origin && active !== document.body && active !== null) {
      dispose()
      return
    }
    const editor = input
    dispose()
    editor.focus({ preventScroll: true })
  }
  const schedule = (): void => {
    if (!disposed && input !== null && frame === null) frame = requestAnimationFrame(tryFocus)
  }
  const onFocus = (event: FocusEvent): void => {
    if (event.target !== origin && event.target !== document.body) {
      focusCancelled = true
      if (selected) dispose()
    }
  }
  const onPointer = (event: PointerEvent): void => {
    if (!(event.target instanceof Node) || !origin?.contains(event.target)) {
      focusCancelled = true
      if (selected) dispose()
    }
  }
  const onKey = (event: KeyboardEvent): void => {
    if (!['Enter', 'Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) {
      focusCancelled = true
      if (selected) dispose()
    }
  }
  const unsubscribe = subscribeOverlays(() => {
    if (openOverlays().some((overlay) => !startingOverlays.has(overlay))) {
      stale = true
      if (selected) dispose()
    }
    schedule()
  })
  document.addEventListener('focusin', onFocus, true)
  document.addEventListener('pointerdown', onPointer, true)
  document.addEventListener('keydown', onKey, true)

  return {
    scope,
    get wantsFocus() {
      return !focusCancelled && !disposed
    },
    isCurrent,
    validate: () => {
      if (!isCurrent()) {
        focusCancelled = true
        if (selected) dispose()
      }
    },
    select: (sessionId) => {
      if (!isCurrent()) return false
      expected = { ...scope, sessionId }
      selected = true
      return true
    },
    ready: (editor) => {
      if (input !== null || disposed) return
      input = editor
      schedule()
    },
    dispose,
    cancel: () => {
      stale = true
      dispose()
    },
  }
}

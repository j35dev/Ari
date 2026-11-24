import { useCallback, useEffect, useRef, useState } from 'react'
import { animate, useMotionValue, type MotionValue } from 'motion/react'
import { durations, EASE_GLIDE } from '@ari/ui/motion'
import { projectDropTarget, type ProjectRowBox } from '../features/session/session-nav'

/** How far past the group's first/last row a release still counts as a drop. */
const DROP_SLOP_PX = 32
/** How far past the list's left/right edge a release still counts as a drop. */
const DROP_SIDE_SLOP_PX = 48
/** Pointer travel (px) before a header press becomes a drag, not a click. */
export const PROJECT_DRAG_SLOP_PX = 4
/** Scroll zone (px) inside the sidebar's edge that keeps the list moving. */
const AUTO_SCROLL_ZONE_PX = 36
/** One frame of continuous edge scroll. */
const AUTO_SCROLL_STEP_PX = 10

interface DragSession {
  id: string
  pointerId: number
  /** Transforms can enlarge scrollHeight; never chase the lifted row's overflow. */
  maxScroll: number
  /** Row ids in list order when the drag began. */
  order: string[]
  startClientY: number
  /** The dragged row's layout top at the press, in viewport px. */
  originalTop: number
  /** Pinned-row layout shift (edge auto-scroll) since the press. */
  cumShift: number
  /** Offset the row already carried when grabbed (mid-settle grab). */
  baseOffset: number
}

interface ArmingPress {
  pressY: number
  onMove: (event: PointerEvent) => void
  onRelease: (event: PointerEvent) => void
  onKey: (event: KeyboardEvent) => void
}

/** Read the rendered transform, which can lag a MotionValue until the next frame. */
function layoutTopOf(row: HTMLElement): number {
  const transform = getComputedStyle(row).transform
  const values = transform.match(/^matrix(3d)?\(([^)]+)\)$/)
  const translate = transform.match(/translateY\(([^)]+)\)|translate3d\([^,]+,\s*([^,]+)/)
  const offset = values
    ? Number(values[2]?.split(',')[values[1] ? 13 : 5] ?? 0)
    : parseFloat(translate?.[1] ?? translate?.[2] ?? '0')
  return row.getBoundingClientRect().top - offset
}

/**
 * Pointer-driven reordering for the sidebar's project groups.
 *
 * The dragged row is lifted by a plain `y` offset and never re-inserted into
 * the DOM until the drop commits. Framer's `Reorder` instead swaps DOM order
 * live, and that is the source of the jump-and-oscillate behaviour: its swap
 * test reads layout boxes from the last render through a pointer-velocity
 * gate, and each live swap moves the row's layout origin under a drag offset
 * that was measured at press time — so the row lurches off the pointer and
 * the next frame's threshold can flip the order back. With the row pinned to
 * its slot, the target is a pure function of the pointer
 * (`projectDropTarget`), the row tracks the pointer exactly (even while edge
 * auto-scroll moves the pinned rows under it, tracked via `cumShift`), and a
 * single commit lands it where the target bar indicated.
 *
 * The hook owns the pointer session:
 * - press arms a slop-gated press; travel converts it into a session and the
 *   arming listeners are removed, so a cancelled/unmounted press can never
 *   start a drag later;
 * - move pins the row under the pointer, resolves the target from live
 *   pinned-row boxes, and keeps a bounded rAF scroll loop alive while the
 *   pointer sits inside an edge zone (it stops at the content end or when
 *   the pointer leaves the zone);
 * - up commits only a drop inside the group's span; `pointercancel` and
 *   Escape never commit;
 * - `settleAfterCommit` runs in a layout effect after the committed
 *   re-render: the row keeps its transform binding through the settle, is
 *   re-based against the new layout before paint, and glides into its slot.
 */
export interface ProjectDrag {
  /** The row that is lifted, or null while idle. */
  draggingId: string | null
  /** Still elevated (transform bound) while its settle glide runs. */
  settlingId: string | null
  /** The slot the row will land in (index in the current order), or null. */
  targetIndex: number | null
  /** Binds to the dragged row's `style.y`; stays 0 while idle. */
  y: MotionValue<number>
  /** Begins a drag on a header press. */
  start: (id: string, event: React.PointerEvent) => void
  /** No-op unless a commit just re-rendered; re-bases and glides the row. */
  settleAfterCommit: () => void
}

export function useProjectDrag(options: {
  /** Latest rendered row ids, snapshotted at drag start. */
  order: readonly string[]
  rowAt: (id: string) => HTMLElement | null
  /** The scroll container hosting the rows (edge auto-scroll + drop bounds). */
  scrollRef: { current: HTMLElement | null }
  /** Persist the move: slot `id` before `beforeId` (null = last). */
  onCommit: (id: string, beforeId: string | null) => void
}): ProjectDrag {
  const { order, rowAt, scrollRef, onCommit } = options
  const latest = useRef({ order, rowAt, scrollRef, onCommit })
  latest.current = { order, rowAt, scrollRef, onCommit }

  const y = useMotionValue(0)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [settlingId, setSettlingId] = useState<string | null>(null)
  const settlingIdRef = useRef<string | null>(null)
  settlingIdRef.current = settlingId
  const [targetIndex, setTargetIndex] = useState<number | null>(null)
  const session = useRef<DragSession | null>(null)
  const arming = useRef<ArmingPress | null>(null)
  // A grab that stopped an in-flight settle: if the press never arms, the
  // interrupted settle must still complete.
  const settledByGrab = useRef<{ id: string; offset: number } | null>(null)
  // Set when a drop commits; settleAfterCommit consumes it once.
  const pendingSettle = useRef<{ id: string; oldLayoutTop: number; offset: number } | null>(null)
  // Live rAF handle of the edge scroll loop (0 = idle).
  const scrollRaf = useRef(0)
  const pointerY = useRef(0)
  // Keep the untransformed content extent through a settle/re-grab: the
  // floating tail row can temporarily enlarge scrollHeight here too.
  const scrollExtent = useRef<{ container: HTMLElement; maxScroll: number } | null>(null)
  // The in-flight settle animation; `stop` is present at runtime for value
  // animations but not on the typed Promise overload.
  const settlePlayback = useRef<{ stop?: () => void } | null>(null)
  const mounted = useRef(true)

  // The window listeners are registered once, per press/session, and must be
  // removable by the same identity: they wrap the latest logic in refs.
  const moveRef = useRef<(event: PointerEvent) => void>(() => {})
  const upRef = useRef<(event: PointerEvent) => void>(() => {})
  const cancelRef = useRef<(event: PointerEvent) => void>(() => {})
  const keyRef = useRef<(event: KeyboardEvent) => void>(() => {})
  const stableMove = useCallback((event: PointerEvent): void => moveRef.current(event), [])
  const stableUp = useCallback((event: PointerEvent): void => upRef.current(event), [])
  const stableCancel = useCallback((event: PointerEvent): void => cancelRef.current(event), [])
  const stableKey = useCallback((event: KeyboardEvent): void => keyRef.current(event), [])

  /** Live boxes of the pinned rows; the lifted row's box carries its offset, so it is skipped. */
  const boxesOf = (skipId: string | null): Map<string, ProjectRowBox> => {
    const map = new Map<string, ProjectRowBox>()
    for (const id of latest.current.order) {
      if (id === skipId) continue
      const el = latest.current.rowAt(id)
      if (el === null) continue
      const rect = el.getBoundingClientRect()
      map.set(id, { top: rect.top, height: rect.height })
    }
    return map
  }

  const targetFor = (active: DragSession, pinY: number): number | null => {
    const slot = projectDropTarget(active.order, active.id, pinY, boxesOf(active.id))
    return slot ? slot.targetIndex : active.order.indexOf(active.id)
  }

  /** Record how far edge auto-scroll has shifted the pinned rows. */
  const pinOffset = (active: DragSession): void => {
    const row = latest.current.rowAt(active.id)
    if (row === null) return
    const layoutTop = layoutTopOf(row)
    active.cumShift = layoutTop - active.originalTop
  }

  /** The row's visual top stays under the pointer: layout + offset, re-based. */
  const applyOffset = (active: DragSession, pinY: number): void => {
    const offset = active.baseOffset + (pinY - active.startClientY) - active.cumShift
    y.set(offset)
    // Scrolling changes layout immediately. Motion schedules its write for
    // a later render phase, so compensate the row in this frame as well.
    const row = latest.current.rowAt(active.id)
    if (row) row.style.transform = `translateY(${offset}px)`
  }

  const stopSettle = (): void => {
    const playback = settlePlayback.current
    settlePlayback.current = null
    playback?.stop?.()
  }

  /** Glide the shared offset home, releasing the settle binding on arrival. */
  const beginSettle = (duration: number): void => {
    stopSettle()
    const playback = animate(y, [y.get(), 0], { duration, ease: EASE_GLIDE }) as unknown as {
      stop?: () => void
      then: (onfulfilled: () => void) => Promise<unknown>
      catch: (onrejected: () => void) => Promise<unknown>
    }
    settlePlayback.current = playback
    const finish = (): void => {
      if (!mounted.current || settlePlayback.current !== playback) return
      settlePlayback.current = null
      settlingIdRef.current = null
      setSettlingId(null)
    }
    void playback.then(finish).catch(finish)
  }

  const stopScrollLoop = (): void => {
    if (scrollRaf.current !== 0) {
      cancelAnimationFrame(scrollRaf.current)
      scrollRaf.current = 0
    }
  }

  const releaseListeners = (): void => {
    window.removeEventListener('pointermove', stableMove)
    window.removeEventListener('pointerup', stableUp)
    window.removeEventListener('pointercancel', stableCancel)
    window.removeEventListener('keydown', stableKey)
    session.current = null
  }

  /**
   * One frame of bounded edge scrolling: while the pointer stays inside an
   * edge zone the list keeps moving (no further pointermove required). The
   * scroll shifts the pinned rows, so the offset is re-based and the target
   * re-resolved at the same pointer position; the loop stops when the
   * pointer leaves the zone or the content reaches its end.
   */
  const scrollTick = (): void => {
    scrollRaf.current = 0
    const active = session.current
    const scroller = latest.current.scrollRef.current
    if (active === null || scroller === null) return
    const bounds = scroller.getBoundingClientRect()
    const atTop = pointerY.current < bounds.top + AUTO_SCROLL_ZONE_PX
    const atBottom = pointerY.current > bounds.bottom - AUTO_SCROLL_ZONE_PX
    if (!atTop && !atBottom) return
    const before = scroller.scrollTop
    // A theme may enable smooth scrolling; drag compensation needs the
    // actual scroll displacement synchronously, in this frame.
    scroller.scrollTop = Math.max(
      0,
      Math.min(active.maxScroll, before + (atTop ? -AUTO_SCROLL_STEP_PX : AUTO_SCROLL_STEP_PX)),
    )
    if (scroller.scrollTop === before) return // content end: nothing moved
    pinOffset(active)
    applyOffset(active, pointerY.current)
    setTargetIndex(targetFor(active, pointerY.current))
    scrollRaf.current = requestAnimationFrame(scrollTick)
  }

  moveRef.current = (event: PointerEvent): void => {
    const active = session.current
    if (active === null || event.pointerId !== active.pointerId) return
    if (event.buttons === 0) {
      endSession(false)
      return
    }
    event.preventDefault()
    pointerY.current = event.clientY
    pinOffset(active)
    applyOffset(active, event.clientY)
    setTargetIndex(targetFor(active, event.clientY))
    const scroller = latest.current.scrollRef.current
    if (scroller === null) return
    const bounds = scroller.getBoundingClientRect()
    const inZone =
      event.clientY < bounds.top + AUTO_SCROLL_ZONE_PX ||
      event.clientY > bounds.bottom - AUTO_SCROLL_ZONE_PX
    if (inZone) {
      if (scrollRaf.current === 0) scrollRaf.current = requestAnimationFrame(scrollTick)
    } else {
      stopScrollLoop()
    }
  }

  keyRef.current = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    endSession(false)
  }

  upRef.current = (event: PointerEvent): void => {
    if (event.pointerId !== session.current?.pointerId) return
    endSession(true, event)
  }

  // pointercancel must never commit: it ends the session exactly like Escape.
  cancelRef.current = (event: PointerEvent): void => {
    if (event.pointerId !== session.current?.pointerId) return
    endSession(false)
  }

  const endSession = (commitAllowed: boolean, event?: PointerEvent): void => {
    const active = session.current
    if (active === null) return
    pinOffset(active)
    if (event) applyOffset(active, event.clientY)
    releaseListeners()
    stopScrollLoop()
    setTargetIndex(null)
    setDraggingId(null)
    // The row stays transform-bound (settling) until its glide completes, so
    // the cancel/no-op glides and the settle re-base all act on a bound value.
    settlingIdRef.current = active.id
    setSettlingId(active.id)
    if (!commitAllowed || event === undefined) {
      // Cancel (Escape, pointercancel, or a release outside the list):
      // nothing moved, glide the row home.
      beginSettle(durations.panel)
      return
    }
    const pinned = boxesOf(active.id)
    const scroller = latest.current.scrollRef.current
    // A drop only lands inside the group's own span (plus slop),
    // horizontally close to the list: releasing over the main view cancels
    // the move and glides the row back.
    if (pinned.size === 0 || scroller === null) {
      beginSettle(durations.panel)
      return
    }
    const tops = Array.from(pinned.values())
    const first = Math.min(...tops.map((b) => b.top))
    const lastBottom = Math.max(...tops.map((b) => b.top + b.height))
    const frame = scroller.getBoundingClientRect()
    const inside =
      event.clientY >= first - DROP_SLOP_PX &&
      event.clientY <= lastBottom + DROP_SLOP_PX &&
      event.clientY >= frame.top - DROP_SLOP_PX &&
      event.clientY <= frame.bottom + DROP_SLOP_PX &&
      event.clientX >= frame.left - DROP_SIDE_SLOP_PX &&
      event.clientX <= frame.right + DROP_SIDE_SLOP_PX
    if (!inside) {
      beginSettle(durations.panel)
      return
    }
    const slot = projectDropTarget(active.order, active.id, event.clientY, pinned)
    if (slot === null) {
      // Back on its own slot: settle in place, persist nothing.
      beginSettle(durations.fast)
      return
    }
    pendingSettle.current = {
      id: active.id,
      oldLayoutTop: active.originalTop + active.cumShift,
      offset: y.get(),
    }
    latest.current.onCommit(active.id, slot.beforeId)
  }

  const start = useCallback(
    (id: string, event: React.PointerEvent): void => {
      if (event.button !== 0 || session.current !== null || arming.current !== null) return
      const current = latest.current
      if (current.order.indexOf(id) === -1 || current.rowAt(id) === null) return
      const row = current.rowAt(id) as HTMLElement
      const pressY = event.clientY
      const pointerId = event.pointerId
      const originalTop = layoutTopOf(row)
      // Capture the rendered position before stopping playback. Its value
      // can already be one frame ahead of the transform the user sees.
      const rowOffset = row.getBoundingClientRect().top - originalTop
      const scrollContainer = current.scrollRef.current
      const maxScroll = scrollContainer
        ? settlingIdRef.current !== null && scrollExtent.current?.container === scrollContainer
          ? scrollExtent.current.maxScroll
          : Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight)
        : 0
      if (scrollContainer) scrollExtent.current = { container: scrollContainer, maxScroll }
      // A grab mid-settle continues from wherever the row currently floats,
      // so stop the glide without re-basing the shared offset; grabbing a
      // different row lands the settling one. The settle binding stays live
      // through the press so the grabbed row never unbinds for a frame.
      stopSettle()
      const grabbingSettling = settlingIdRef.current === id
      // Neighbours may still carry a layout-projection transform from the
      // last reorder. Hand that visible offset to the new drag as well.
      if (grabbingSettling) {
        y.set(rowOffset)
        row.style.transform = `translateY(${rowOffset}px)`
      }
      if (settlingIdRef.current !== null) {
        settledByGrab.current = {
          id: settlingIdRef.current,
          offset: grabbingSettling ? rowOffset : 0,
        }
        if (!grabbingSettling) y.set(0)
      }
      const onMove = (move: PointerEvent): void => {
        if (move.pointerId !== pointerId) return
        if (move.buttons === 0) {
          onRelease(move)
          return
        }
        if (Math.abs(move.clientY - pressY) < PROJECT_DRAG_SLOP_PX) return
        // Travel-armed: the session listeners take over; the slop watchers
        // (including pointercancel) are done and must not outlive the press.
        arming.current = null
        settledByGrab.current = null
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onRelease)
        window.removeEventListener('pointercancel', onRelease)
        window.removeEventListener('keydown', onKey)
        session.current = {
          id,
          pointerId,
          maxScroll,
          order: [...current.order],
          startClientY: pressY,
          originalTop,
          cumShift: 0,
          baseOffset: rowOffset,
        }
        setDraggingId(id)
        // The settle binding hands off to the drag in the same render, so the
        // grabbed row's transform never detaches.
        setSettlingId(null)
        settlingIdRef.current = null
        setTargetIndex(current.order.indexOf(id))
        window.addEventListener('pointermove', stableMove)
        window.addEventListener('pointerup', stableUp)
        window.addEventListener('pointercancel', stableCancel)
        window.addEventListener('keydown', stableKey)
        // Process the arming move itself so the first session frame already
        // carries the correct offset, target, and edge-scroll state.
        moveRef.current(move)
      }
      const disarm = (): void => {
        if (arming.current === null) return
        arming.current = null
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onRelease)
        window.removeEventListener('pointercancel', onRelease)
        window.removeEventListener('keydown', onKey)
        // The press never armed: let the interrupted settle finish, or simply
        // drop the shared offset back to the slot.
        const interrupted = settledByGrab.current
        if (interrupted !== null) {
          settledByGrab.current = null
          if (interrupted.offset === 0) {
            setSettlingId(null)
            settlingIdRef.current = null
          } else {
            beginSettle(durations.panel)
          }
        }
      }
      const onRelease = (release: PointerEvent): void => {
        if (release.pointerId === pointerId) disarm()
      }
      const onKey = (key: KeyboardEvent): void => {
        if (key.key === 'Escape') disarm()
      }
      arming.current = { pressY, onMove, onRelease, onKey }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onRelease)
      window.addEventListener('pointercancel', onRelease)
      window.addEventListener('keydown', onKey)
    },
    [stableCancel, stableKey, stableMove, stableUp, y],
  )

  /**
   * Runs in a layout effect after a committed re-render: the row now sits in
   * its new slot but still carries the release offset (its binding survives
   * through the settle). Keep it exactly where the pointer saw it, then
   * glide it the remaining distance into its slot.
   */
  const settleAfterCommit = useCallback((): void => {
    const pending = pendingSettle.current
    if (pending === null) return
    pendingSettle.current = null
    const row = latest.current.rowAt(pending.id)
    if (row === null) {
      setSettlingId(null)
      return
    }
    // The transform is applied at the committed render, so the measured top
    // includes the release offset; strip it to get the new layout top.
    const layoutTop = layoutTopOf(row)
    const offset = pending.offset + pending.oldLayoutTop - layoutTop
    y.set(offset)
    // MotionValue writes are frame-scheduled. Apply the rebase now so the
    // committed DOM cannot paint with the old slot's release transform.
    row.style.transform = `translateY(${offset}px)`
    beginSettle(durations.panel)
  }, [y])

  // A drag, a pending settle, or a still-armed press that outlives the
  // component (navigation, view switch) ends quietly: the teardown removes
  // every listener, scroll frame, and animation the live state had.
  useEffect(() => {
    mounted.current = true
    return (): void => {
      mounted.current = false
      const press = arming.current
      if (press !== null) {
        window.removeEventListener('pointermove', press.onMove)
        window.removeEventListener('pointerup', press.onRelease)
        window.removeEventListener('pointercancel', press.onRelease)
        window.removeEventListener('keydown', press.onKey)
        arming.current = null
      }
      releaseListeners()
      stopScrollLoop()
      stopSettle()
      settledByGrab.current = null
      pendingSettle.current = null
      scrollExtent.current = null
      y.set(0)
    }
  }, [stableCancel, stableKey, stableMove, stableUp, y])

  return { draggingId, settlingId, targetIndex, y, start, settleAfterCommit }
}

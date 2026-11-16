interface Point {
  x: number
  y: number
}

interface SnapshotFlight {
  from: Point
  to: Point
  width: number
  height: number
  destinationWidth: number
  destinationHeight: number
}

export const SNAPSHOT_FLIGHT_DURATION = 980

// Zero velocity and acceleration at each end keeps the reveal and landing soft.
function ease(value: number): number {
  const t = Math.min(1, Math.max(0, value))
  return t * t * t * (t * (t * 6 - 15) + 10)
}

function curve(from: number, first: number, second: number, to: number, t: number): number {
  const rest = 1 - t
  return rest ** 3 * from + 3 * rest ** 2 * t * first + 3 * rest * t ** 2 * second + t ** 3 * to
}

/** One continuous curved flight, with an overlapping handoff to the real image. */
export function snapshotFlightFrames(flight: SnapshotFlight): {
  flight: Keyframe[]
  crop: Keyframe[]
  handoff: Keyframe[]
} {
  const { from, to, width, height, destinationWidth, destinationHeight } = flight
  const endScale = destinationWidth / width
  const endHeight = destinationHeight / endScale
  const distanceX = to.x - from.x
  const distanceY = to.y - from.y
  const arc = Math.min(90, Math.hypot(distanceX, distanceY) * 0.16)
  const frames: Keyframe[] = []
  const crop: Keyframe[] = []
  const handoff: Keyframe[] = []
  for (let index = 0; index <= 64; index++) {
    const offset = index / 64
    const reveal = ease(offset / 0.18)
    const progress = ease((offset - 0.1) / 0.84)
    const landing = ease((offset - 0.86) / 0.14)
    const x = curve(from.x, from.x + distanceX * 0.18, to.x - distanceX * 0.22, to.x, progress)
    const y = curve(from.y, from.y - arc, to.y - arc, to.y, progress) - 10 * (1 - reveal)
    // Uniform scaling preserves the screenshot; the viewport crops into the
    // destination's shape instead of stretching the picture into a square.
    const scale = (0.97 + 0.03 * reveal) * (1 - progress) + endScale * progress
    const cropProgress = ease((offset - 0.3) / 0.58)
    const radius = (12 * (1 - progress) + 6 * progress) / scale
    frames.push({
      offset,
      transform: `translate3d(${x - from.x}px, ${y - from.y}px, 0) rotate(${-1.5 * (1 - progress)}deg) scale(${scale})`,
      opacity: reveal * (1 - landing),
    })
    crop.push({
      offset,
      height: `${height + (endHeight - height) * cropProgress}px`,
      borderRadius: `${radius}px`,
    })
    handoff.push({ offset, opacity: landing })
  }
  return { flight: frames, crop, handoff }
}

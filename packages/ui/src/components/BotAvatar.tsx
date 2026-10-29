import { memo, useId, useMemo } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import {
  BOT_SHAPE_DEFS,
  paletteHasDarkEyes,
  seedFraction,
  type BotCharacter,
  type BotShapeDef,
} from '../bot-character'

export type BotMood = 'idle' | 'working' | 'replying' | 'needs-you' | 'asleep' | 'error'

export interface BotAvatarProps {
  character: BotCharacter
  mood?: BotMood
  /** Rendered width and height in px. */
  size?: number
  /** Accessible name; without one the avatar is decoration and hidden from assistive tech. */
  label?: string
  className?: string
}

/** Below this the heavy layers go: no filters or effects, a thicker outline, bigger eyes. */
const TINY_BELOW = 30
/** Trails, sparkles and the sleepy "z z" only read at this size and up. */
const FX_FROM = 48
/** The film grain is invisible on small avatars and the costliest filter, so it waits for big ones. */
const GRAIN_FROM = 64

/** The longest idle cycle; each avatar starts somewhere inside it. */
const PHASE_SPREAD_S = 4.6

interface Detail {
  tiny: boolean
  fx: boolean
  grain: boolean
}

function detailFor(size: number): Detail {
  return { tiny: size < TINY_BELOW, fx: size >= FX_FROM, grain: size >= GRAIN_FROM }
}

function Silhouette({ shape }: { shape: BotShapeDef }) {
  if (shape.circles !== undefined) {
    return (
      <>
        {shape.circles.map(([cx, cy, r]) => (
          <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r} />
        ))}
      </>
    )
  }
  return <path d={shape.d} />
}

const TRAIL: readonly (readonly [number, number, number])[] = [
  [12, 62, 2.2],
  [6, 70, 1.6],
  [16, 74, 1.4],
  [3, 58, 1.1],
  [9, 80, 1],
]
const SPARKS: readonly (readonly [number, number, number])[] = [
  [86, 22, 3],
  [92, 36, 1.8],
  [80, 12, 1.6],
]

function sparkPath(x: number, y: number, r: number): string {
  const k = r * 1.8
  return `M${x} ${y - k}Q${x} ${y} ${x + k} ${y}Q${x} ${y} ${x} ${y + k}Q${x} ${y} ${x - k} ${y}Q${x} ${y} ${x} ${y - k}Z`
}

function Effects({ mood, light }: { mood: BotMood; light: string }) {
  if (mood === 'working') {
    return (
      <g className="ari-bot-trail" style={{ fill: light }}>
        {TRAIL.map(([cx, cy, r], index) => (
          <circle
            key={index}
            cx={cx}
            cy={cy}
            r={r}
            style={{ animationDelay: `${index * 0.25}s` }}
          />
        ))}
      </g>
    )
  }
  if (mood === 'replying' || mood === 'needs-you') {
    return (
      <g style={{ fill: light }}>
        {SPARKS.map(([x, y, r], index) => (
          <path
            key={index}
            className="ari-bot-spark"
            d={sparkPath(x, y, r)}
            style={{ animationDelay: `${index * 0.4}s` }}
          />
        ))}
      </g>
    )
  }
  const text: CSSProperties = { fill: light, fontFamily: 'var(--ari-font-ui)', fontWeight: 600 }
  if (mood === 'asleep') {
    return (
      <g>
        <text x={80} y={22} fontSize={13} opacity={0.9} style={text}>
          z
        </text>
        <text x={89} y={12} fontSize={9} opacity={0.6} style={text}>
          z
        </text>
      </g>
    )
  }
  if (mood === 'idle') {
    return (
      <g opacity={0.7} style={{ fill: light }}>
        <circle cx={88} cy={40} r={1.4} />
        <circle cx={84} cy={30} r={0.9} />
      </g>
    )
  }
  return null
}

function Eyes({
  shape,
  character,
  mood,
  tiny,
  color,
  fill,
}: {
  shape: BotShapeDef
  character: BotCharacter
  mood: BotMood
  tiny: boolean
  color: string
  fill: string
}): ReactNode {
  const [lx, rx, ey] = shape.eyes
  const stroke: CSSProperties = { stroke: color, fill: 'none' }
  // A cloud's resting face is already a smile; its eyes never sit open.
  if (mood === 'replying' || (character.shape === 'cloud' && mood === 'idle')) {
    return (
      <g className="ari-bot-eyes" strokeWidth={tiny ? 4 : 3} strokeLinecap="round" style={stroke}>
        <path d={`M${lx - 4.5} ${ey + 2}Q${lx} ${ey - 4} ${lx + 4.5} ${ey + 2}`} />
        <path d={`M${rx - 4.5} ${ey + 2}Q${rx} ${ey - 4} ${rx + 4.5} ${ey + 2}`} />
      </g>
    )
  }
  if (mood === 'asleep') {
    return (
      <g className="ari-bot-eyes" strokeWidth={tiny ? 4 : 3} strokeLinecap="round" style={stroke}>
        <path
          d={`M${lx - 4.5} ${ey + 1}Q${lx} ${ey + 4.5} ${lx + 4.5} ${ey + 1}M${rx - 4.5} ${ey + 1}Q${rx} ${ey + 4.5} ${rx + 4.5} ${ey + 1}`}
        />
      </g>
    )
  }
  if (mood === 'error') {
    return (
      <g
        className="ari-bot-eyes"
        strokeWidth={tiny ? 3.4 : 2.6}
        strokeLinecap="round"
        style={stroke}
      >
        <path
          d={`M${lx - 3.5} ${ey - 3.5}l7 7M${lx + 3.5} ${ey - 3.5}l-7 7M${rx - 3.5} ${ey - 3.5}l7 7M${rx + 3.5} ${ey - 3.5}l-7 7`}
        />
      </g>
    )
  }
  const k = mood === 'needs-you' ? 1.15 : 1
  const w = (tiny ? 8.5 : 7.2) * k
  const h = (tiny ? 14 : 13) * k
  return (
    <g className="ari-bot-eyes" style={{ fill }}>
      {[lx, rx].map((x) => (
        <rect
          key={x}
          className="ari-bot-eye"
          x={x - w / 2}
          y={ey - h / 2}
          width={w}
          height={h}
          rx={w / 2}
        />
      ))}
    </g>
  )
}

function Art({
  id,
  character,
  mood,
  detail,
}: {
  id: string
  character: BotCharacter
  mood: BotMood
  detail: Detail
}) {
  const shape = BOT_SHAPE_DEFS[character.shape]
  const v = (name: string): string => `var(--ari-bot-${character.palette}-${name})`
  const white = 'var(--ari-bot-white)'
  const { tiny } = detail
  const rich = !tiny
  const darkEyes = paletteHasDarkEyes(character.palette)
  const glow = rich && !darkEyes
  const [lx, rx, ey] = shape.eyes
  const cx = (lx + rx) / 2
  const hiX = cx - 13
  const hiY = ey - 20
  const url = (suffix: string): string => `url(#${id}-${suffix})`

  return (
    <>
      <defs>
        <radialGradient id={`${id}-f`} gradientUnits="userSpaceOnUse" cx={40} cy={34} r={64}>
          <stop offset={0} style={{ stopColor: v('top') }} />
          <stop offset={0.55} style={{ stopColor: v('base') }} />
          <stop offset={1} style={{ stopColor: v('shade') }} />
        </radialGradient>
        {darkEyes ? null : (
          <linearGradient id={`${id}-e`} x1={0} y1={0} x2={0} y2={1}>
            <stop offset={0} style={{ stopColor: v('eye') }} />
            <stop offset={1} style={{ stopColor: v('eye-low') }} />
          </linearGradient>
        )}
        {rich ? (
          <>
            <clipPath id={`${id}-c`}>
              <Silhouette shape={shape} />
            </clipPath>
            <filter id={`${id}-is`} x="-10%" y="-10%" width="120%" height="120%">
              <feGaussianBlur in="SourceAlpha" stdDeviation={5} />
              <feOffset dx={-4} dy={-5} result="o" />
              <feComposite in="SourceAlpha" in2="o" operator="out" result="e" />
              <feFlood floodOpacity={0.7} style={{ floodColor: v('inner-shadow') }} />
              <feComposite in2="e" operator="in" />
            </filter>
            <filter id={`${id}-ig`} x="-10%" y="-10%" width="120%" height="120%">
              <feGaussianBlur in="SourceAlpha" stdDeviation={3.5} />
              <feOffset dx={3} dy={4} result="o" />
              <feComposite in="SourceAlpha" in2="o" operator="out" result="e" />
              <feFlood floodOpacity={0.75} style={{ floodColor: v('inner-glow') }} />
              <feComposite in2="e" operator="in" />
            </filter>
            <filter id={`${id}-b4`} x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur stdDeviation={4} />
            </filter>
            <filter id={`${id}-b2`} x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation={2} />
            </filter>
          </>
        ) : null}
        {detail.grain ? (
          <filter id={`${id}-n`}>
            <feTurbulence type="fractalNoise" baseFrequency={1.1} numOctaves={2} />
            <feColorMatrix type="saturate" values="0" />
          </filter>
        ) : null}
        {glow ? (
          <filter id={`${id}-g`} x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur stdDeviation={2.6} result="b" />
            <feColorMatrix
              in="b"
              type="matrix"
              values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 .85 0"
              result="g"
            />
            <feMerge>
              <feMergeNode in="g" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        ) : null}
      </defs>

      {tiny ? null : (
        <ellipse cx={50} cy={95} rx={23} ry={3} filter={url('b2')} style={{ fill: v('floor') }} />
      )}
      {detail.fx ? <Effects mood={mood} light={v('light')} /> : null}

      <g className="ari-bot-body">
        <g transform={shape.rotate === undefined ? undefined : `rotate(${shape.rotate} 50 52)`}>
          <g
            strokeWidth={tiny ? 6.4 : 3.2}
            strokeLinejoin="round"
            style={{ fill: v('line'), stroke: v('line') }}
          >
            <Silhouette shape={shape} />
          </g>
          <g fill={url('f')}>
            <Silhouette shape={shape} />
          </g>
          {rich ? (
            <>
              <g clipPath={url('c')}>
                {/* Only the silhouette's alpha feeds these two filters, so the fill is moot. */}
                <g filter={url('is')} fill="currentColor">
                  <Silhouette shape={shape} />
                </g>
                <g filter={url('ig')} fill="currentColor">
                  <Silhouette shape={shape} />
                </g>
                <ellipse
                  cx={cx + 4}
                  cy={ey + 34}
                  rx={30}
                  ry={9}
                  filter={url('b4')}
                  style={{ fill: v('bounce') }}
                />
                {detail.grain ? (
                  <rect x={0} y={0} width={100} height={100} filter={url('n')} opacity={0.07} />
                ) : null}
              </g>
              <ellipse
                cx={hiX}
                cy={hiY}
                rx={13}
                ry={7.5}
                opacity={0.26}
                filter={url('b2')}
                transform={`rotate(-30 ${hiX} ${hiY})`}
                style={{ fill: white }}
              />
              <ellipse
                cx={hiX + 1}
                cy={hiY - 1}
                rx={6.5}
                ry={3.2}
                opacity={0.75}
                transform={`rotate(-30 ${hiX + 1} ${hiY - 1})`}
                style={{ fill: white }}
              />
              <circle cx={hiX + 10} cy={hiY - 5} r={1.7} opacity={0.8} style={{ fill: white }} />
            </>
          ) : null}
          <g filter={glow ? url('g') : undefined}>
            <Eyes
              shape={shape}
              character={character}
              mood={mood}
              tiny={tiny}
              color={v('eye')}
              fill={darkEyes ? v('eye') : url('e')}
            />
          </g>
        </g>
      </g>
    </>
  )
}

/**
 * A Hive bot's face: a soft glossy blob in its palette, with glowing capsule
 * eyes that carry its mood. One inline SVG; colours come from the
 * `--ari-bot-*` tokens and the motion from bot-avatar.css, so an avatar costs
 * no script once mounted. Small avatars drop the filters and effects.
 */
export const BotAvatar = memo(function BotAvatar({
  character,
  mood = 'idle',
  size = 32,
  label,
  className,
}: BotAvatarProps) {
  const reactId = useId()
  const id = `ari-bot-${reactId.replace(/[^A-Za-z0-9_-]/g, '')}`
  const { tiny, fx, grain } = detailFor(size)
  const { shape, palette } = character
  const art = useMemo(
    () => <Art id={id} character={{ shape, palette }} mood={mood} detail={{ tiny, fx, grain }} />,
    [id, shape, palette, mood, tiny, fx, grain],
  )
  const phase = useMemo(() => (seedFraction(reactId) * PHASE_SPREAD_S).toFixed(2), [reactId])

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role={label === undefined ? undefined : 'img'}
      aria-label={label}
      aria-hidden={label === undefined ? true : undefined}
      focusable="false"
      data-mood={mood}
      data-shape={shape}
      data-palette={palette}
      className={['ari-bot', `ari-bot--${mood}`, className].filter(Boolean).join(' ')}
      style={{ '--ari-bot-phase': `-${phase}s` } as CSSProperties}
    >
      {art}
    </svg>
  )
})

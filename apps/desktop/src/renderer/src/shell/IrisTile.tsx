import { motion } from 'motion/react'
import { IRIS_RING, irisHue, irisLetter, irisPattern } from './iris-tile'

const CHASE_DURATION_S = 1.2
const CELL_PX = 3.5

export interface IrisTileProps {
  /** Stable project id; empty string selects the letter fallback. */
  seed: string
  /** Existing 0–7 accent slot. */
  colorIndex?: number
  /** Ring chase — same motion as the working glyph. */
  running?: boolean
  /** Name used only for the letter fallback. */
  name?: string
}

/**
 * 20×20 project mark: a hue-tinted rounded tile with a unique 3×3 constellation.
 */
export function IrisTile({ seed, colorIndex = 0, running = false, name = '' }: IrisTileProps) {
  const hue = irisHue(colorIndex)
  const fallback = seed.length === 0
  const pattern = irisPattern(seed)
  const ring = IRIS_RING as readonly number[]

  return (
    <span
      aria-hidden
      data-iris-tile=""
      data-running={running ? '' : undefined}
      data-fallback={fallback ? '' : undefined}
      className="grid size-5 shrink-0 place-content-center rounded-md"
      style={{
        ['--iris-h' as string]: String(hue),
        background: 'oklch(0.22 0.07 var(--iris-h) / 0.72)',
        boxShadow: 'inset 0 0 0 1px oklch(0.7 0.12 var(--iris-h) / 0.22)',
        gridTemplateColumns: fallback ? undefined : `repeat(3, ${CELL_PX}px)`,
        gridTemplateRows: fallback ? undefined : `repeat(3, ${CELL_PX}px)`,
        gap: fallback ? undefined : 1.5,
      }}
    >
      {fallback ? (
        <span
          className="text-[11px] font-semibold leading-none tracking-tight"
          style={{ color: 'oklch(0.86 0.1 var(--iris-h))' }}
        >
          {irisLetter(name)}
        </span>
      ) : (
        pattern.map((lit, cell) => {
          const ringPosition = ring.indexOf(cell)
          const chasing = running && ringPosition >= 0
          const on = chasing || (!running && lit)
          return (
            <motion.span
              key={cell}
              className="block rounded-[1px]"
              style={{
                width: CELL_PX,
                height: CELL_PX,
                background: on
                  ? 'oklch(0.78 0.16 var(--iris-h))'
                  : 'oklch(0.42 0.05 var(--iris-h) / 0.35)',
                boxShadow: on ? '0 0 4px oklch(0.7 0.16 var(--iris-h) / 0.45)' : undefined,
              }}
              animate={{ opacity: chasing ? [0.2, 1, 0.2] : 1 }}
              transition={
                chasing
                  ? {
                      duration: CHASE_DURATION_S,
                      ease: 'linear',
                      repeat: Infinity,
                      delay: ringPosition * (CHASE_DURATION_S / ring.length),
                    }
                  : undefined
              }
            />
          )
        })
      )}
    </span>
  )
}

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { durations, menuInVariants, transitions } from './index'

const tokensCss = readFileSync(resolve(process.cwd(), 'src/tokens.css'), 'utf8')

function tokenMs(name: string): number {
  const match = new RegExp(`--ari-dur-${name}:\\s*(\\d+)ms`).exec(tokensCss)
  if (match === null) throw new Error(`missing --ari-dur-${name}`)
  return Number(match[1])
}

describe('motion standard', () => {
  it('keeps every named transition at or under the 200ms click-path ceiling', () => {
    for (const [name, transition] of Object.entries(transitions)) {
      const seconds = 'visualDuration' in transition ? transition.visualDuration : transition.duration
      expect(seconds, name).toBeLessThanOrEqual(0.2)
    }
  })

  it('closes menus faster than it opens them', () => {
    expect(transitions.menuOut.duration).toBeLessThan(transitions.menuIn.duration)
    expect(menuInVariants.exit).toMatchObject({ transition: transitions.menuOut })
  })

  it('mirrors the CSS duration tokens', () => {
    for (const [name, seconds] of Object.entries(durations)) {
      expect(tokenMs(name), name).toBe(Math.round(seconds * 1000))
    }
  })

  it('caps the CSS duration tokens at the same ceiling', () => {
    for (const name of ['instant', 'micro', 'fast', 'panel', 'base', 'slow']) {
      expect(tokenMs(name), name).toBeLessThanOrEqual(200)
    }
  })
})

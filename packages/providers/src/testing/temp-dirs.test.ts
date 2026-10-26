import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { useTempDirs } from './temp-dirs'

const tempDir = useTempDirs()
let made: string[] = []

describe('useTempDirs', () => {
  it('creates distinct dirs under the temp root', async () => {
    const first = await tempDir('ari-temp-dirs-')
    const second = await tempDir('ari-temp-dirs-')
    made = [first, second]

    expect(existsSync(first)).toBe(true)
    expect(existsSync(second)).toBe(true)
    expect(first).not.toBe(second)
    expect(first.startsWith(join(tmpdir(), 'ari-temp-dirs-'))).toBe(true)
    expect(second.startsWith(join(tmpdir(), 'ari-temp-dirs-'))).toBe(true)
  })

  // This test relies on vitest running tests in a file in order.
  it('removes them once the test that made them ends', () => {
    expect(made).toHaveLength(2)
    expect(existsSync(made[0]!)).toBe(false)
    expect(existsSync(made[1]!)).toBe(false)
  })
})

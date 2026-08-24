import { describe, expect, it } from 'vitest'
import { describeNpmExit, explainExitCode } from './exit-codes'

describe('describeNpmExit', () => {
  it('decodes npm 256−errno fatal exits', () => {
    expect(describeNpmExit(254)).toContain('ENOENT')
    expect(describeNpmExit(243)).toContain('EACCES')
    expect(describeNpmExit(220)).toContain('ENAMETOOLONG')
  })

  it('returns null outside the npm range', () => {
    expect(describeNpmExit(0)).toBeNull()
    expect(describeNpmExit(1)).toBeNull()
    expect(describeNpmExit(199)).toBeNull()
    expect(describeNpmExit(256)).toBeNull()
  })
})

describe('explainExitCode', () => {
  it('is empty for clean or unknown exits', () => {
    expect(explainExitCode(null, true)).toBe('')
    expect(explainExitCode(0, true)).toBe('')
  })

  it('decodes npm-style exits only for npx launches', () => {
    const viaNpx = explainExitCode(254, true)
    expect(viaNpx).toContain('exit 254')
    expect(viaNpx).toContain('npx failed before the agent started')
    // The same code from a directly-spawned CLI must not claim npm.
    expect(explainExitCode(254, false)).toBe(' (exit 254)')
  })

  it('passes through ordinary codes with the plain suffix', () => {
    expect(explainExitCode(1, false)).toBe(' (exit 1)')
    expect(explainExitCode(137, true)).toBe(' (exit 137)')
  })
})

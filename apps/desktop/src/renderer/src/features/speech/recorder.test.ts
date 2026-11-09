import { describe, expect, it } from 'vitest'
import { resampleMono } from './recorder'

describe('16 kHz mono resampling', () => {
  it('preserves duration and averages 48 kHz sample intervals', () => {
    const pcm = resampleMono(Float32Array.from([0, 0.3, 0.6, -0.3, -0.6, -0.9]), 48_000)
    expect(pcm).toHaveLength(2)
    expect(pcm[0]).toBeCloseTo(0.3)
    expect(pcm[1]).toBeCloseTo(-0.6)
  })
  it('handles fractional 44.1 kHz intervals and retains constant amplitude', () => {
    const pcm = resampleMono(new Float32Array(44_100).fill(0.25), 44_100)
    expect(pcm).toHaveLength(16_000)
    expect(pcm.every((value) => Math.abs(value - 0.25) < 0.00001)).toBe(true)
  })
  it('copies existing 16 kHz PCM and rejects invalid rates', () => {
    const input = new Float32Array([0.2, -0.2])
    expect(resampleMono(input, 16_000)).toEqual(input)
    expect(resampleMono(input, 16_000)).not.toBe(input)
    expect(() => resampleMono(input, 0)).toThrow('sample rate')
  })
})

import { describe, expect, it } from 'vitest'
import { probeHealth } from './health'

describe('probeHealth', () => {
  it('reports binary-not-found without probing', async () => {
    let probed = false
    const report = await probeHealth('claude', null, async () => {
      probed = true
      return { version: 'x', latencyMs: 1 }
    })
    expect(report.ok).toBe(false)
    expect(report.problems).toEqual(['binary not found'])
    expect(probed).toBe(false)
  })

  it('passes a fast healthy probe', async () => {
    const report = await probeHealth('codex', '/usr/bin/codex', async () => ({
      version: 'codex 1.0',
      latencyMs: 120,
    }))
    expect(report.ok).toBe(true)
    expect(report.version).toBe('codex 1.0')
    expect(report.problems).toHaveLength(0)
  })

  it('flags failed version probes', async () => {
    const report = await probeHealth('grok', '/bin/grok', async () => ({
      version: null,
      latencyMs: 40,
    }))
    expect(report.ok).toBe(false)
    expect(report.problems).toContain('version probe failed')
  })

  it('flags slow responses over 2s', async () => {
    const report = await probeHealth('pi', '/bin/pi', async () => ({
      version: 'pi 1.2',
      latencyMs: 2400,
    }))
    expect(report.ok).toBe(false)
    expect(report.problems.some((p) => p.includes('slow response'))).toBe(true)
  })

  it('measures and reports latency', async () => {
    const report = await probeHealth('hermes', '/bin/hermes', async () => ({
      version: 'h1',
      latencyMs: 555,
    }))
    expect(report.latencyMs).toBe(555)
    expect(report.ok).toBe(true)
  })
})

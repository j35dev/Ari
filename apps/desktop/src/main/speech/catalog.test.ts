// @vitest-environment node
import { expect, it } from 'vitest'
import { catalog } from './discovery'
import { engineRelease } from './engine'

it('ships five pinned GGUF models with one recommended multilingual default', () => {
  expect(catalog).toHaveLength(5)
  expect(new Set(catalog.map((model) => model.id)).size).toBe(5)
  expect(catalog.filter((model) => model.recommended).map((model) => model.id)).toEqual([
    'parakeet-tdt-0.6b-v3',
  ])
  for (const model of catalog) {
    expect(model.filename).toMatch(/\.gguf$/)
    expect(model.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(model.revision).toMatch(/^[a-f0-9]{40}$/)
    expect(model.size).toBeGreaterThan(0)
    expect(model.description).not.toBe('')
  }
})
it('pins engine checksums for every supported target and rejects unsupported targets', () => {
  for (const [platform, arch] of [
    ['win32', 'x64'],
    ['darwin', 'x64'],
    ['darwin', 'arm64'],
    ['linux', 'x64'],
    ['linux', 'arm64'],
  ] as const) {
    expect(engineRelease(platform, arch).sha256).toMatch(/^[a-f0-9]{64}$/)
  }
  expect(() => engineRelease('win32', 'arm64')).toThrow('not available')
})

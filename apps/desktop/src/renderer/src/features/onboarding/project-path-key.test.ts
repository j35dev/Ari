import { describe, expect, it } from 'vitest'
import { projectPathKey } from './project-path-key'

describe('onboarding project path keys', () => {
  it('deduplicates Windows drive and network path spellings', () => {
    expect(projectPathKey('C:\\Work\\Ari\\')).toBe(projectPathKey('c:/work/ari'))
    expect(projectPathKey('\\\\HOST\\Share\\Ari')).toBe(projectPathKey('\\\\host\\share\\ari\\'))
  })
  it('preserves case-sensitive POSIX paths and roots', () => {
    expect(projectPathKey('/work/Ari/')).toBe('/work/Ari')
    expect(projectPathKey('/work/Ari')).not.toBe(projectPathKey('/work/ari'))
    expect(projectPathKey('/')).toBe('/')
  })
})

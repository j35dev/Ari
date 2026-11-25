import { mkdir, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findBinaries } from '../detector'
import { useTempDirs } from '../testing/temp-dirs'
import type { DetectEnvironment } from '../types'
import { opencodeGeneration, opencodeTransportLabel } from './catalog'
import { classifyOpencodeVersion, findOpencode2Binaries } from './version'

const tempDir = useTempDirs()

describe('classifyOpencodeVersion', () => {
  it.each([
    ['1.19.6', 'v1', '1.19.6'],
    ['1.19.6\n', 'v1', '1.19.6'],
    ['v1.2.3', 'v1', '1.2.3'],
    ['2.4.1', 'v2', '2.4.1'],
    ['opencode v2.4.1', 'v2', '2.4.1'],
    ['opencode2 v0.0.0-beta-19242', 'v2', '0.0.0-beta-19242'],
    ['opencode v0.0.0-beta-1', 'v2', '0.0.0-beta-1'],
  ])('reads %j as %s', (output, generation, version) => {
    expect(classifyOpencodeVersion(output)).toMatchObject({ generation, version })
  })

  it('labels the generations the way the providers page shows them', () => {
    expect(classifyOpencodeVersion('opencode v2.4.1')?.label).toBe('OpenCode 2')
    expect(classifyOpencodeVersion('1.19.6')?.label).toBe('OpenCode')
  })

  it('returns null for output that names no version', () => {
    expect(classifyOpencodeVersion(null)).toBeNull()
    expect(classifyOpencodeVersion('')).toBeNull()
    expect(classifyOpencodeVersion('error: unknown flag')).toBeNull()
  })

  it('falls back to the launcher name when the probe did not answer', () => {
    expect(opencodeGeneration(null, 'C:\\npm\\opencode2.exe')).toBe('v2')
    expect(opencodeGeneration(null, '/usr/local/bin/opencode')).toBe('v1')
    expect(opencodeGeneration('opencode v2.4.1', '/usr/local/bin/opencode')).toBe('v2')
    expect(opencodeTransportLabel('1.19.6')).toBe('OpenCode server')
    expect(opencodeTransportLabel('opencode2 v0.0.0-beta-1')).toBe('OpenCode 2 server')
  })
})

describe('findOpencode2Binaries', () => {
  async function touch(path: string): Promise<void> {
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, '')
  }

  it('finds the binary inside a global npm package whose shim is missing', async () => {
    const root = await tempDir('ari-oc2-')
    const appData = join(root, 'Roaming')
    const exe = join(appData, 'npm', 'node_modules', '@opencode-ai', 'cli', 'bin', 'opencode2.exe')
    await touch(exe)
    const env: DetectEnvironment = { platform: 'win32', pathEnv: '', homeDir: root, appData }
    expect(findOpencode2Binaries(env)).toEqual([exe])
  })

  it('honors the npm prefix from the environment and PATH entries', async () => {
    const root = await tempDir('ari-oc2-')
    const onPath = join(root, 'bin', 'opencode2')
    const prefix = join(root, 'prefix')
    const packaged = join(prefix, 'lib', 'node_modules', '@opencode', 'cli', 'bin', 'opencode2')
    await touch(onPath)
    await touch(packaged)
    const env: DetectEnvironment = {
      platform: 'linux',
      pathEnv: join(root, 'bin'),
      homeDir: root,
      vars: { npm_config_prefix: prefix },
    }
    expect(findOpencode2Binaries(env)).toEqual([onPath, packaged])
  })

  it('makes detection prefer OpenCode 2 when both generations are installed', async () => {
    const root = await tempDir('ari-oc2-')
    const npm = join(root, 'npm')
    const classic = join(npm, 'opencode.cmd')
    const v2 = join(npm, 'opencode2.cmd')
    await touch(classic)
    await touch(v2)
    const env: DetectEnvironment = {
      platform: 'win32',
      pathEnv: [npm, join(root, 'other')].join(delimiter),
      homeDir: root,
    }
    expect(findBinaries('opencode', env)).toEqual([v2, classic])
  })
})

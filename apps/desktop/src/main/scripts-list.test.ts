import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listScripts } from './scripts-list'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ari-scripts-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('listScripts', () => {
  it('returns name/command pairs in package.json order', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'app',
        scripts: { dev: 'vite', build: 'tsc && vite build', test: 'vitest run' },
      }),
      'utf8',
    )
    const result = await listScripts(dir)
    expect(result.scripts).toEqual([
      { name: 'dev', command: 'vite' },
      { name: 'build', command: 'tsc && vite build' },
      { name: 'test', command: 'vitest run' },
    ])
  })

  it('returns empty for a folder without package.json', async () => {
    expect(await listScripts(dir)).toEqual({ scripts: [] })
  })

  it('tolerates missing or non-string script entries', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { ok: 'vite', broken: 42 } }),
      'utf8',
    )
    const result = await listScripts(dir)
    expect(result.scripts).toEqual([{ name: 'ok', command: 'vite' }])
  })

  it('tolerates corrupt json', async () => {
    await writeFile(join(dir, 'package.json'), '{not json', 'utf8')
    expect(await listScripts(dir)).toEqual({ scripts: [] })
  })

  it('handles a package.json without scripts at all', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'bare' }), 'utf8')
    expect(await listScripts(dir)).toEqual({ scripts: [] })
  })
})

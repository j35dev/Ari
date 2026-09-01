import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  listProviderConfigFiles,
  readProviderConfig,
  writeProviderConfig,
} from './provider-config'

/**
 * The manifest reads the real environment, so every case relocates pi's agent
 * dir into a temp directory via the vendor's own override.
 */
let dir = ''
const original = process.env['PI_CODING_AGENT_DIR']

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ari-pi-config-'))
  process.env['PI_CODING_AGENT_DIR'] = dir
})

afterEach(() => {
  if (original === undefined) delete process.env['PI_CODING_AGENT_DIR']
  else process.env['PI_CODING_AGENT_DIR'] = original
})

describe('listProviderConfigFiles', () => {
  it('reports which of the agent\'s files exist and how big they are', async () => {
    await writeFile(join(dir, 'settings.json'), '{"quietStartup":true}', 'utf8')
    const listed = await listProviderConfigFiles('pi')
    expect(listed.dir).toBe(dir)
    const settings = listed.files.find((f) => f.id === 'settings')
    expect(settings).toMatchObject({ exists: true, format: 'json', label: 'settings.json' })
    expect(settings?.size).toBeGreaterThan(0)
    // Optional files are listed as absent rather than hidden — that is how a
    // user discovers SYSTEM.md exists at all.
    expect(listed.files.find((f) => f.id === 'system')).toMatchObject({ exists: false, size: 0 })
  })

  it('answers an empty list for an agent Ari has no layout for', async () => {
    const listed = await listProviderConfigFiles('hermes')
    expect(listed).toEqual({ dir: null, files: [] })
  })
})

describe('readProviderConfig', () => {
  it('reads a file verbatim', async () => {
    await writeFile(join(dir, 'AGENTS.md'), '# Rules\nBe brief.\n', 'utf8')
    const read = await readProviderConfig('pi', 'agents')
    expect(read).toMatchObject({ exists: true, content: '# Rules\nBe brief.\n', truncated: false })
    expect(read.path).toBe(join(dir, 'AGENTS.md'))
  })

  it('reports an absent file as empty rather than failing', async () => {
    const read = await readProviderConfig('pi', 'system')
    expect(read).toMatchObject({ exists: false, content: '' })
  })

  it('refuses a file id that is not in the manifest', async () => {
    await expect(readProviderConfig('pi', '../../.ssh/id_rsa')).rejects.toThrow(/no config file/)
  })
})

describe('writeProviderConfig', () => {
  it('saves a settings file and reads back what it wrote', async () => {
    const result = await writeProviderConfig('pi', 'settings', '{\n  "quietStartup": true\n}\n')
    expect(result).toMatchObject({ ok: true })
    expect(await readFile(join(dir, 'settings.json'), 'utf8')).toBe('{\n  "quietStartup": true\n}\n')
  })

  it('creates a file the agent has never written', async () => {
    const result = await writeProviderConfig('pi', 'system', 'You are terse.\n')
    expect(result).toMatchObject({ ok: true })
    expect(await readFile(join(dir, 'SYSTEM.md'), 'utf8')).toBe('You are terse.\n')
  })

  it('refuses invalid JSON so a settings file cannot be silently lost', async () => {
    await writeFile(join(dir, 'settings.json'), '{"keep":"me"}', 'utf8')
    const result = await writeProviderConfig('pi', 'settings', '{ "quietStartup": tru')
    expect(result).toMatchObject({ ok: false })
    expect(result).toHaveProperty('error', expect.stringContaining('settings.json is not valid JSON'))
    // The file on disk is untouched.
    expect(await readFile(join(dir, 'settings.json'), 'utf8')).toBe('{"keep":"me"}')
  })

  it('accepts an empty payload as clearing a file', async () => {
    expect(await writeProviderConfig('pi', 'settings', '')).toMatchObject({ ok: true })
  })

  it('does not check syntax for markdown', async () => {
    expect(await writeProviderConfig('pi', 'agents', '{ not json at all')).toMatchObject({ ok: true })
  })

  it('answers with an error instead of throwing for an unknown file id', async () => {
    const result = await writeProviderConfig('pi', 'nope', 'x')
    expect(result).toMatchObject({ ok: false })
  })

  it('refuses a kind Ari has no layout for', async () => {
    expect(await writeProviderConfig('hermes', 'settings', 'x')).toMatchObject({ ok: false })
  })
})

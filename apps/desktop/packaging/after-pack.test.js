// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cliampBinaryName,
  cliampTargetKeys,
  expectedAdapterBinaries,
  expectedAdapterPackages,
  packageDir,
  platformPackageName,
  restoreAdapterPlatformPackages,
} from './after-pack.js'

describe('bundled ACP packaging manifest', () => {
  it('requires both adapter entrypoints and their platform runtimes', () => {
    const packages = expectedAdapterPackages('win32', 1)
    expect(packages).toEqual(
      expect.arrayContaining([
        '@agentclientprotocol/claude-agent-acp',
        '@agentclientprotocol/codex-acp',
        '@agentclientprotocol/sdk',
        '@anthropic-ai/claude-agent-sdk',
        '@anthropic-ai/claude-agent-sdk-win32-x64',
        '@anthropic-ai/sdk',
        '@modelcontextprotocol/sdk',
        '@openai/codex',
        '@openai/codex-win32-x64',
      ]),
    )
  })

  it('includes both native slices for universal macOS', () => {
    const packages = expectedAdapterPackages('darwin', 4)
    expect(packages).toContain(platformPackageName('claude', 'darwin', 'x64'))
    expect(packages).toContain(platformPackageName('claude', 'darwin', 'arm64'))
    expect(packages).toContain(platformPackageName('codex', 'darwin', 'x64'))
    expect(packages).toContain(platformPackageName('codex', 'darwin', 'arm64'))
  })

  it('checks native files inside each platform package', () => {
    expect(expectedAdapterBinaries('claude', 'win32', 1)).toEqual([
      join('@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe'),
    ])
    expect(expectedAdapterBinaries('codex', 'win32', 1)).toEqual([
      join('@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'),
      join(
        '@openai',
        'codex-win32-x64',
        'vendor',
        'x86_64-pc-windows-msvc',
        'bin',
        'codex-code-mode-host.exe',
      ),
      join(
        '@openai',
        'codex-win32-x64',
        'vendor',
        'x86_64-pc-windows-msvc',
        'codex-path',
        'rg.exe',
      ),
    ])
  })

  it('resolves scoped package paths without losing the namespace', () => {
    const nodeModules = join('resources', 'app.asar.unpacked', 'node_modules')
    expect(packageDir(nodeModules, '@openai/codex')).toBe(join(nodeModules, '@openai', 'codex'))
  })

  it('restores optional platform packages from beside their parent SDKs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ari-adapter-pack-'))
    const source = join(root, 'source')
    const target = join(root, 'target')
    for (const [parent, runtime] of [
      ['@anthropic-ai/claude-agent-sdk', '@anthropic-ai/claude-agent-sdk-win32-x64'],
      ['@openai/codex', '@openai/codex-win32-x64'],
    ]) {
      await mkdir(packageDir(source, parent), { recursive: true })
      await mkdir(packageDir(source, runtime), { recursive: true })
      await writeFile(join(packageDir(source, runtime), 'runtime.bin'), runtime)
    }

    restoreAdapterPlatformPackages(source, target, 'win32', 1)

    await expect(
      readFile(
        join(packageDir(target, '@anthropic-ai/claude-agent-sdk-win32-x64'), 'runtime.bin'),
        'utf8',
      ),
    ).resolves.toBe('@anthropic-ai/claude-agent-sdk-win32-x64')
    await expect(
      readFile(join(packageDir(target, '@openai/codex-win32-x64'), 'runtime.bin'), 'utf8'),
    ).resolves.toBe('@openai/codex-win32-x64')
  })
})

describe('bundled Cliamp music backend', () => {
  it('maps builds to manifest target keys, expanding universal macOS', () => {
    expect(cliampTargetKeys('win32', 1)).toEqual(['win32-x64'])
    expect(cliampTargetKeys('darwin', 4)).toEqual(['darwin-x64', 'darwin-arm64'])
    expect(cliampTargetKeys('linux', 1)).toEqual(['linux-x64'])
    expect(cliampTargetKeys('linux', 3)).toEqual(['linux-arm64'])
  })

  it('uses the exe name on Windows and the bare name elsewhere', () => {
    expect(cliampBinaryName('win32-x64')).toBe('cliamp.exe')
    expect(cliampBinaryName('darwin-arm64')).toBe('cliamp')
    expect(cliampBinaryName('linux-x64')).toBe('cliamp')
  })

  it('pins exactly the targets upstream publishes binaries for', async () => {
    const manifest = JSON.parse(
      await readFile(join(import.meta.dirname, '../resources/cliamp/cliamp.json'), 'utf8'),
    )
    expect(manifest.version).toMatch(/^v\d+\.\d+\.\d+$/)
    expect(new Set(Object.keys(manifest.targets))).toEqual(
      new Set(['win32-x64', 'linux-x64', 'linux-arm64']),
    )
    for (const entry of Object.values(manifest.targets)) {
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })
})

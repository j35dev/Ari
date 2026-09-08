// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  expectedAdapterBinaries,
  expectedAdapterPackages,
  packageDir,
  platformPackageName,
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
      join('@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex-code-mode-host.exe'),
      join('@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'codex-path', 'rg.exe'),
    ])
  })

  it('resolves scoped package paths without losing the namespace', () => {
    const nodeModules = join('resources', 'app.asar.unpacked', 'node_modules')
    expect(packageDir(nodeModules, '@openai/codex')).toBe(
      join(nodeModules, '@openai', 'codex'),
    )
  })
})

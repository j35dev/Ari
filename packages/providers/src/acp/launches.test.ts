import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acpAdapterSpec, findNpxCommand, probeLaunch, resolveAcpLaunch } from './launches'
import type { DetectEnvironment } from '../types'

const ENV: DetectEnvironment = {
  platform: process.platform === 'win32' ? 'win32' : 'linux',
  pathEnv: '/usr/local/bin:/usr/bin',
  homeDir: '/home/tester',
}

describe('resolveAcpLaunch', () => {
  it('prefers a packaged Claude adapter without requiring npx', async () => {
    const runtime = await makeBundledRuntime('claude')
    const launch = resolveAcpLaunch(
      'claude',
      { cliBinaryPath: join(runtime.nodeModulesDir, 'claude'), bundledRuntime: runtime },
      { ...ENV, pathEnv: '' },
    )
    expect(launch).toMatchObject({
      command: runtime.executable,
      args: [
        join(
          runtime.nodeModulesDir,
          '@agentclientprotocol',
          'claude-agent-acp',
          'dist',
          'index.js',
        ),
      ],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      viaBundled: true,
    })
    expect(launch?.viaNpx).toBeUndefined()
  })

  it('passes the detected Codex CLI path to the packaged Codex adapter', async () => {
    const runtime = await makeBundledRuntime('codex')
    const cliBinaryPath = join(runtime.nodeModulesDir, 'CLI with spaces', 'codex.cmd')
    const launch = resolveAcpLaunch(
      'codex',
      { cliBinaryPath, bundledRuntime: runtime },
      { ...ENV, pathEnv: '' },
    )
    expect(launch?.command).toBe(runtime.executable)
    expect(launch?.env).toEqual({ ELECTRON_RUN_AS_NODE: '1', CODEX_PATH: cliBinaryPath })
    expect(probeLaunch(launch!).args).toEqual(launch?.args)
    expect(probeLaunch(launch!).env).toEqual(launch?.env)
  })

  it('propagates both packaged module roots to Electron Node mode', async () => {
    const runtime = await makeBundledRuntime('claude')
    const modulePaths = [runtime.nodeModulesDir, join(runtime.nodeModulesDir, 'app.asar', 'node_modules')]
    const launch = resolveAcpLaunch(
      'claude',
      { cliBinaryPath: '/usr/bin/claude', bundledRuntime: { ...runtime, modulePaths } },
      { ...ENV, pathEnv: '' },
    )
    expect(launch?.env).toMatchObject({
      ELECTRON_RUN_AS_NODE: '1',
      NODE_PATH: modulePaths.join(delimiter),
    })
  })

  it('uses an explicit adapter override through npx even when bundled assets exist', async () => {
    const runtime = await makeBundledRuntime('claude')
    const npxPath = await makeFakeNpx()
    process.env['ARI_ACP_ADAPTER_CLAUDE'] = 'my-fork/claude-acp'
    try {
      const launch = resolveAcpLaunch(
        'claude',
        { cliBinaryPath: join(runtime.nodeModulesDir, 'claude'), bundledRuntime: runtime },
        { ...ENV, pathEnv: dirname(npxPath) },
      )
      expect(launch?.viaNpx).toBe(true)
      expect(launch?.command).toBe(npxPath)
      expect(launch?.args).toEqual(['-y', 'my-fork/claude-acp'])
    } finally {
      delete process.env['ARI_ACP_ADAPTER_CLAUDE']
    }
  })

  it('reports no ACP launch when the packaged entrypoint is missing and npx is unavailable', () => {
    expect(
      resolveAcpLaunch(
        'claude',
        {
          cliBinaryPath: '/usr/bin/claude',
          bundledRuntime: {
            executable: '/opt/Ari/Ari',
            nodeModulesDir: '/opt/Ari/resources/app.asar/node_modules',
          },
        },
        { ...ENV, pathEnv: '' },
      ),
    ).toBeNull()
  })

  it('launches npx adapters at a pinned version for kinds that need one', async () => {
    const npxPath = await makeFakeNpx()
    const env: DetectEnvironment = { ...ENV, pathEnv: dirname(npxPath) }
    const launch = resolveAcpLaunch('claude', { cliBinaryPath: join(dirname(npxPath), 'claude') }, env)
    expect(launch).not.toBeNull()
    expect(launch?.command).toContain('npx')
    // Pinned, not bare: two users on one Ari build must run the same adapter.
    expect(launch?.args).toEqual(['-y', acpAdapterSpec('claude')])
    expect(launch?.args[1]).toMatch(/^@agentclientprotocol\/claude-agent-acp@\d+\.\d+\.\d+$/)
    expect(launch?.label).toContain(acpAdapterSpec('claude') as string)
  })

  it('launches native ACP servers with their own binary', () => {
    const opencode = resolveAcpLaunch('opencode', { cliBinaryPath: '/usr/bin/opencode' }, ENV)
    expect(opencode).toEqual({ label: 'opencode (native ACP)', command: '/usr/bin/opencode', args: ['acp'] })
    const hermes = resolveAcpLaunch('hermes', { cliBinaryPath: '/usr/bin/hermes' }, ENV)
    expect(hermes?.args).toEqual(['acp'])
    const grok = resolveAcpLaunch('grok', { cliBinaryPath: '/usr/bin/grok' }, ENV)
    expect(grok?.args).toEqual(['agent', 'stdio'])
  })

  it('uses the detected Codex for both ACP sessions and background probes', async () => {
    const npxPath = await makeFakeNpx()
    const cliBinaryPath = join(dirname(npxPath), 'CLI with spaces', 'codex.cmd')
    const launch = resolveAcpLaunch('codex', { cliBinaryPath }, { ...ENV, pathEnv: dirname(npxPath) })
    expect(launch?.env).toEqual({ CODEX_PATH: cliBinaryPath })
    expect(probeLaunch(launch!).env).toEqual({ CODEX_PATH: cliBinaryPath })
    const claude = resolveAcpLaunch('claude', { cliBinaryPath: '/bin/claude' }, { ...ENV, pathEnv: dirname(npxPath) })
    expect(claude?.env).toBeUndefined()
  })

  it('returns null when the CLI itself is not installed', () => {
    expect(resolveAcpLaunch('claude', { cliBinaryPath: null }, ENV)).toBeNull()
    expect(resolveAcpLaunch('opencode', { cliBinaryPath: null }, ENV)).toBeNull()
  })

  it('returns null when ACP is disabled via env override', () => {
    expect(
      resolveAcpLaunch('claude', { cliBinaryPath: '/usr/local/bin/claude', envOverride: '0' }, ENV),
    ).toBeNull()
    process.env['ARI_ACP'] = '0'
    try {
      expect(resolveAcpLaunch('codex', { cliBinaryPath: '/usr/bin/codex' }, ENV)).toBeNull()
    } finally {
      delete process.env['ARI_ACP']
    }
  })

  it('pins a single kind onto its legacy driver via ARI_ACP_<KIND>', () => {
    process.env['ARI_ACP_OPENCODE'] = '0'
    try {
      expect(resolveAcpLaunch('opencode', { cliBinaryPath: '/usr/bin/opencode' }, ENV)).toBeNull()
      // Neighbours are untouched — the override is per kind, not global.
      expect(resolveAcpLaunch('hermes', { cliBinaryPath: '/usr/bin/hermes' }, ENV)).not.toBeNull()
    } finally {
      delete process.env['ARI_ACP_OPENCODE']
    }
  })

  it('returns null for kinds without an ACP transport story (ari-core)', () => {
    expect(resolveAcpLaunch('ari-core', { cliBinaryPath: '/x' }, ENV)).toBeNull()
  })
})

describe('probeLaunch', () => {
  it('drops npx consent so --no-install cannot be overridden', () => {
    const probe = probeLaunch({
      label: 'pi (ACP adapter pi-acp@0.0.33)',
      command: 'npx',
      args: ['-y', 'pi-acp@0.0.33'],
      viaNpx: true,
    })
    expect(probe.args).toEqual(['--no-install', 'pi-acp@0.0.33'])
    expect(probe.args).not.toContain('-y')
  })

  it('leaves native launches exactly as they are', () => {
    const native = { label: 'opencode (native ACP)', command: '/usr/bin/opencode', args: ['acp'] }
    expect(probeLaunch(native)).toEqual(native)
  })
})

describe('acpAdapterSpec', () => {
  it('pins every npx adapter to an exact version', () => {
    for (const kind of ['claude', 'codex', 'pi'] as const) {
      expect(acpAdapterSpec(kind, {})).toMatch(/@\d+\.\d+\.\d+$/)
    }
  })

  it('answers null for kinds that need no adapter', () => {
    expect(acpAdapterSpec('opencode', {})).toBeNull()
    expect(acpAdapterSpec('ari-core', {})).toBeNull()
  })

  it('reads a bare override as a version and a qualified one as a whole spec', () => {
    expect(acpAdapterSpec('claude', { ARI_ACP_ADAPTER_CLAUDE: '0.71.0' })).toBe(
      '@agentclientprotocol/claude-agent-acp@0.71.0',
    )
    expect(acpAdapterSpec('claude', { ARI_ACP_ADAPTER_CLAUDE: 'latest' })).toBe(
      '@agentclientprotocol/claude-agent-acp@latest',
    )
    expect(acpAdapterSpec('pi', { ARI_ACP_ADAPTER_PI: 'my-fork/pi-acp' })).toBe('my-fork/pi-acp')
    expect(acpAdapterSpec('pi', { ARI_ACP_ADAPTER_PI: 'pi-acp@0.0.34' })).toBe('pi-acp@0.0.34')
  })

  it('ignores a blank override rather than building a dangling spec', () => {
    expect(acpAdapterSpec('pi', { ARI_ACP_ADAPTER_PI: '   ' })).toBe(acpAdapterSpec('pi', {}))
  })
})

describe('findNpxCommand', () => {
  it('finds npx on the PATH when present', async () => {
    const npxPath = await makeFakeNpx()
    const found = findNpxCommand({
      platform: ENV.platform,
      pathEnv: dirname(npxPath),
      homeDir: ENV.homeDir,
    })
    expect(found).not.toBeNull()
  })

  it('returns null when nowhere to look', () => {
    // win32 well-known dirs are gated on localAppData; omitting it plus an
    // empty PATH is empty on every host (linux CI still has /usr/bin/npx).
    expect(
      findNpxCommand({ platform: 'win32', pathEnv: '', homeDir: '/nonexistent-home' }),
    ).toBeNull()
  })
})

/** Creates a temp dir containing a fake npx so resolution has a real hit. */
async function makeFakeNpx(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ari-npx-'))
  const name = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  const path = join(dir, name)
  await writeFile(path, '@echo off\n', 'utf8')
  return path
}

async function makeBundledRuntime(kind: 'claude' | 'codex') {
  const root = await mkdtemp(join(tmpdir(), 'ari-acp-runtime-'))
  const packageName = kind === 'claude' ? 'claude-agent-acp' : 'codex-acp'
  const entry = join(root, '@agentclientprotocol', packageName, 'dist', 'index.js')
  await mkdir(dirname(entry), { recursive: true })
  await writeFile(entry, '// fixture entrypoint\n', 'utf8')
  return {
    executable: join(root, 'Electron with spaces.exe'),
    nodeModulesDir: root,
  }
}

afterEach(() => {
  delete process.env['ARI_ACP']
  delete process.env['ARI_ACP_ADAPTER_CLAUDE']
  delete process.env['ARI_ACP_ADAPTER_CODEX']
})

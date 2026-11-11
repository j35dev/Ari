// @vitest-environment node
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { rpcParams } from '@ari/contracts/rpc'
import { TailscaleServe, type TailscaleRunner } from './tailscale'
import { useTempDirs } from './testing/temp-dirs'

const tempDir = useTempDirs()
type Handler = { Proxy: string } | { Path: string } | { Text: string }

/**
 * Serve configuration is a shared resource: the user may already be serving
 * something else on this machine. These drive the fake CLI through the states
 * a real one produces, including the ones where the honest answer is "I did
 * not touch it".
 */

const PORT = 8787

interface Reply {
  code?: number
  stdout?: string
  stderr?: string
}

/** A `tailscale serve status --json` body listing `<https port>: <proxy>`. */
function serveStatus(
  mappings: Record<string, string>,
  paths: Record<string, Record<string, Handler>> = {},
  tcp: Record<string, unknown> = {},
): string {
  const web: Record<string, unknown> = {}
  const listeners: Record<string, unknown> = {}
  for (const port of new Set([...Object.keys(mappings), ...Object.keys(paths)])) {
    web[`ari.tailnet.ts.net:${port}`] = {
      Handlers: {
        ...paths[port],
        ...(mappings[port] === undefined ? {} : { '/': { Proxy: mappings[port] } }),
      },
    }
    listeners[port] = { HTTPS: true }
  }
  return JSON.stringify({ TCP: { ...listeners, ...tcp }, Web: web, AllowFunnel: {} })
}

function statusJson(backendState = 'Running'): string {
  return JSON.stringify({
    Self: { DNSName: 'ari.tailnet.ts.net.', BackendState: backendState },
    BackendState: backendState,
  })
}

interface FakeTailscale {
  runner: TailscaleRunner
  calls: string[][]
  /** The mappings the fake CLI currently knows about, by HTTPS port. */
  web: Record<string, string>
  paths: Record<string, Record<string, Handler>>
}

/**
 * A fake `tailscale` binary: `status` and `serve status` answer from the
 * scripted state, a serve command rewrites it, and every call is recorded so
 * a test can prove nothing else was touched.
 */
function fakeTailscale(options: {
  status?: Reply
  web?: Record<string, string>
  serveCommand?: Reply
  paths?: Record<string, Record<string, Handler>>
  tcp?: Record<string, unknown>
  configuration?: unknown
  onRead?: (
    count: number,
    web: Record<string, string>,
    paths: Record<string, Record<string, Handler>>,
  ) => void
}): FakeTailscale {
  const calls: string[][] = []
  const web = { ...options.web }
  const paths = structuredClone(options.paths ?? {})
  let reads = 0
  const status = options.status ?? { code: 0, stdout: statusJson() }
  const runner: TailscaleRunner = async (args) => {
    calls.push(args)
    const joined = args.join(' ')
    if (joined === 'status --json') {
      return { code: status.code ?? 0, stdout: status.stdout ?? '', stderr: status.stderr ?? '' }
    }
    if (joined === 'serve status --json') {
      options.onRead?.(++reads, web, paths)
      return {
        code: 0,
        stdout:
          options.configuration === undefined
            ? serveStatus(web, paths, options.tcp)
            : JSON.stringify(options.configuration),
        stderr: '',
      }
    }
    if (joined === 'serve status') {
      return { code: 0, stdout: '', stderr: '' }
    }
    if (options.serveCommand !== undefined && args[0] === 'serve' && args[1] !== 'status') {
      const failure = options.serveCommand
      if ((failure.code ?? 0) !== 0)
        return { code: failure.code ?? 1, stdout: '', stderr: failure.stderr ?? '' }
    }
    if (args[0] === 'serve' && args.includes('--bg')) {
      const httpsPort = args.find((arg) => arg.startsWith('--https='))?.slice('--https='.length)
      if (httpsPort === undefined || !args.includes('--set-path=/'))
        throw new Error('expected an explicit root mount')
      if (args.at(-1) === 'off') {
        delete web[httpsPort]
        if (paths[httpsPort] !== undefined) {
          delete paths[httpsPort]!['/']
          if (Object.keys(paths[httpsPort]!).length === 0) delete paths[httpsPort]
        }
      } else {
        web[httpsPort] = args.at(-1)!
      }
      return { code: 0, stdout: '', stderr: '' }
    }
    throw new Error(`unexpected tailscale arguments: ${joined}`)
  }
  return { runner, calls, web, paths }
}

function serve(
  runner: TailscaleRunner,
  profileDir?: string,
  gatewayPort = () => PORT,
): TailscaleServe {
  return new TailscaleServe({
    runner,
    port: gatewayPort,
    profileDir,
    listening: async (target) => target !== 'http://127.0.0.1:3773',
  })
}

describe('tailscale serve detection', () => {
  it('reports a machine without Tailscale instead of failing', async () => {
    const fake = fakeTailscale({ status: { code: 127, stderr: 'tailscale was not found on PATH' } })
    const state = await serve(fake.runner).status()

    expect(state).toMatchObject({
      installed: false,
      dnsName: null,
      origin: null,
      serving: false,
      error: 'Tailscale is not installed on this computer.',
    })
  })

  it('reports an installed Tailscale that is not running', async () => {
    const stopped = fakeTailscale({ status: { code: 0, stdout: statusJson('Stopped') } })
    const state = await serve(stopped.runner).status()

    expect(state.installed).toBe(true)
    expect(state.dnsName).toBe('ari.tailnet.ts.net')
    expect(state.origin).toBe('https://ari.tailnet.ts.net')
    expect(state.serving).toBe(false)
    expect(state.error).toMatch(/not running/)
  })

  it('reads the daemon state from the top level, where the real CLI puts it', async () => {
    // The real `tailscale status --json` reports BackendState beside Self, not
    // inside it. A fixture carrying both shapes passed while the panel showed
    // "could not read Tailscale's status output" on a running machine.
    const realShape = fakeTailscale({
      status: {
        code: 0,
        stdout: JSON.stringify({
          BackendState: 'Running',
          Self: { DNSName: 'ari.tailnet.ts.net.' },
        }),
      },
    })
    const state = await serve(realShape.runner).status()

    expect(state).toMatchObject({
      installed: true,
      dnsName: 'ari.tailnet.ts.net',
      origin: 'https://ari.tailnet.ts.net',
      serving: false,
      error: null,
    })
  })

  it('keeps a refusal that names an admin page actionable with its link', async () => {
    const runner: TailscaleRunner = async (args) => {
      if (args.join(' ') === 'status --json') return { code: 0, stdout: statusJson(), stderr: '' }
      if (args.join(' ') === 'serve status --json') {
        return { code: 0, stdout: serveStatus({}), stderr: '' }
      }
      return {
        code: 1,
        stdout: '',
        stderr:
          'Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=n123\n',
      }
    }
    const state = await serve(runner).enable(PORT)

    expect(state.serving).toBe(false)
    expect(state.error).toContain('Serve is not enabled on your tailnet.')
    expect(state.error).toContain('https://login.tailscale.com/f/serve?node=n123')
  })

  it('keeps the CLI refusal as the readable reason', async () => {
    const refused = fakeTailscale({
      status: { code: 1, stderr: 'Tailscale is stopped.\n' },
    })
    const state = await serve(refused.runner).status()

    expect(state.installed).toBe(true)
    expect(state.error).toBe('Tailscale is stopped.')
  })

  it('reports a running Tailscale with nothing served yet', async () => {
    const fake = fakeTailscale({})
    const state = await serve(fake.runner).status()

    expect(state).toMatchObject({
      installed: true,
      dnsName: 'ari.tailnet.ts.net',
      origin: 'https://ari.tailnet.ts.net',
      serving: false,
      error: null,
    })
  })

  it('leaves an unrelated mapping alone and does not claim to be serving', async () => {
    const fake = fakeTailscale({ web: { '8443': 'http://127.0.0.1:9000' } })
    const state = await serve(fake.runner).status()

    expect(state.serving).toBe(false)
    expect(state.error).toBeNull()
    expect(fake.web['8443']).toBe('http://127.0.0.1:9000')
  })

  it('refuses to guess when the Serve configuration cannot be parsed', async () => {
    const runner: TailscaleRunner = async (args) => {
      if (args.join(' ') === 'status --json') return { code: 0, stdout: statusJson(), stderr: '' }
      return { code: 0, stdout: 'a serve listing this version of Ari cannot read', stderr: '' }
    }
    const state = await serve(runner).status()

    expect(state.serving).toBe(false)
    expect(state.error).toMatch(/could not understand/)
  })

  it('fails closed on a successful but empty Serve status response', async () => {
    const calls: string[][] = []
    const runner: TailscaleRunner = async (args) => {
      calls.push(args)
      return {
        code: 0,
        stdout: args[0] === 'status' ? statusJson() : '',
        stderr: '',
      }
    }
    expect((await serve(runner).enable(PORT)).error).toMatch(/could not understand/)
    expect(calls.every((args) => args[0] === 'status' || args[1] === 'status')).toBe(true)
  })

  it('falls back to the plain status on a CLI with no JSON flag', async () => {
    const calls: string[][] = []
    const runner: TailscaleRunner = async (args) => {
      calls.push(args)
      if (args.join(' ') === 'status --json') return { code: 0, stdout: statusJson(), stderr: '' }
      if (args.join(' ') === 'serve status --json') {
        return { code: 1, stdout: '', stderr: 'unknown flag: --json' }
      }
      return { code: 0, stdout: 'No serve config', stderr: '' }
    }
    const state = await serve(runner).status()

    expect(state.error).toBeNull()
    expect(state.serving).toBe(false)
    expect(calls).toContainEqual(['serve', 'status'])
  })
})

describe('tailscale serve changes', () => {
  it('enables Serve for our port without touching anything else', async () => {
    const fake = fakeTailscale({ web: { '8443': 'http://127.0.0.1:9000' } })
    const state = await serve(fake.runner).enable(PORT)

    expect(state.serving).toBe(true)
    expect(state.origin).toBe('https://ari.tailnet.ts.net')
    expect(state.error).toBeNull()
    expect(fake.web['8443']).toBe('http://127.0.0.1:9000')
    const mutations = fake.calls.filter((args) => args[0] === 'serve' && args[1] !== 'status')
    expect(mutations).toEqual([
      [`serve`, '--bg', '--https=443', '--set-path=/', `http://127.0.0.1:${PORT}`],
    ])
  })

  it('chooses a free port when 443 belongs to a live application', async () => {
    const fake = fakeTailscale({ web: { '443': 'http://127.0.0.1:9000' } })
    const state = await serve(fake.runner).enable(PORT)

    expect(state.serving).toBe(true)
    expect(state.httpsPort).toBe(8443)
    expect(state.origin).toBe('https://ari.tailnet.ts.net:8443')
    expect(fake.web['443']).toBe('http://127.0.0.1:9000')
    expect(fake.web['8443']).toBe(`http://127.0.0.1:${PORT}`)
  })

  it('is already done when our saved mapping exists, and runs nothing', async () => {
    const fake = fakeTailscale({})
    const instance = serve(fake.runner)
    await instance.enable(PORT)
    fake.calls.length = 0
    const state = await instance.enable(PORT)

    expect(state.serving).toBe(true)
    expect(fake.calls.some((args) => args[1] === '--bg')).toBe(false)
  })

  it('reports a refused enable as a state with a readable error', async () => {
    const fake = fakeTailscale({
      serveCommand: { code: 1, stderr: 'error: something is already serving on port 443' },
    })
    const state = await serve(fake.runner).enable(PORT)

    expect(state.serving).toBe(false)
    expect(state.error).toMatch(/already served/)
  })

  it('does not add ours when the Serve configuration is unreadable', async () => {
    const runner: TailscaleRunner = async (args) => {
      if (args.join(' ') === 'status --json') return { code: 0, stdout: statusJson(), stderr: '' }
      return { code: 0, stdout: 'unreadable listing', stderr: '' }
    }
    const state = await serve(runner).enable(PORT)

    expect(state.serving).toBe(false)
    expect(state.error).toMatch(/could not understand/)
  })

  it('disables only our mapping', async () => {
    const fake = fakeTailscale({
      web: { '8443': 'http://127.0.0.1:9000' },
    })
    const instance = serve(fake.runner)
    await instance.enable(PORT)
    fake.calls.length = 0
    const state = await instance.disable()

    expect(state.serving).toBe(false)
    expect(state.error).toBeNull()
    expect(fake.web['8443']).toBe('http://127.0.0.1:9000')
    const mutations = fake.calls.filter((args) => args[0] === 'serve' && args[1] !== 'status')
    expect(mutations).toEqual([['serve', '--bg', '--https=443', '--set-path=/', 'off']])
  })

  it('leaves a mapping that is not ours in place when asked to disable', async () => {
    const fake = fakeTailscale({ web: { '443': 'http://127.0.0.1:9000' } })
    const state = await serve(fake.runner).disable()

    expect(state.serving).toBe(false)
    expect(fake.web['443']).toBe('http://127.0.0.1:9000')
    expect(fake.calls.some((args) => args.includes('off'))).toBe(false)
  })

  it('never throws when the runner itself fails', async () => {
    const runner: TailscaleRunner = async () => {
      throw new Error('spawn failed')
    }
    const state = await serve(runner).enable(PORT)

    expect(state.serving).toBe(false)
    expect(state.error).toMatch(/could not check Tailscale/)
  })
})

function mutations(fake: FakeTailscale): string[][] {
  return fake.calls.filter((args) => args[0] === 'serve' && args[1] !== 'status')
}
function replacement(target = 'http://127.0.0.1:3773') {
  return {
    origin: 'https://ari.tailnet.ts.net',
    mountPath: '/' as const,
    target,
    kind: 'proxy' as const,
  }
}

describe('Tailscale recovery and ownership', () => {
  it('reports a dead 443 -> 3773 target, then serves Ari on 8443 without touching it', async () => {
    const fake = fakeTailscale({ web: { '443': 'http://127.0.0.1:3773' } })
    const instance = serve(fake.runner)
    expect(await instance.status()).toMatchObject({
      httpsPort: 443,
      target: 'http://127.0.0.1:3773',
      targetListening: false,
      owned: false,
      serving: false,
      suggestedHttpsPort: 8443,
      conflicts: [{ ...replacement(), httpsPort: 443, listening: false }],
    })
    expect(mutations(fake)).toEqual([])
    expect(await instance.enable(PORT)).toMatchObject({
      origin: 'https://ari.tailnet.ts.net:8443',
      httpsPort: 8443,
      owned: true,
      serving: true,
    })
    expect(fake.web['443']).toBe('http://127.0.0.1:3773')
    expect(mutations(fake)[0]).not.toContain('--yes')
  })

  it('does not infer ownership even when a foreign root has Ari’s exact target', async () => {
    const fake = fakeTailscale({ web: { '443': `http://127.0.0.1:${PORT}` } })
    const instance = serve(fake.runner)
    expect(await instance.status()).toMatchObject({ serving: false, owned: false })
    await instance.disable()
    expect(mutations(fake)).toEqual([])
    expect(await instance.enable(PORT)).toMatchObject({ httpsPort: 8443, serving: true })
  })

  it('refuses an explicitly selected foreign port without exact replacement', async () => {
    const fake = fakeTailscale({ web: { '443': 'http://127.0.0.1:3773' } })
    const result = await serve(fake.runner).enable(PORT, { httpsPort: 443 })
    expect(result.error).toMatch(/different HTTPS port.*exact replacement/)
    expect(mutations(fake)).toEqual([])
  })

  it('replaces the exact observed root without prompting and preserves all other mounts', async () => {
    const fake = fakeTailscale({
      web: { '443': 'http://127.0.0.1:3773', '8443': 'http://127.0.0.1:9000' },
      paths: {
        '443': {
          '/app/': { Proxy: 'http://127.0.0.1:9001' },
          '/files/': { Path: 'D:/served' },
          '/notice': { Text: 'Hello' },
        },
      },
    })
    const preserved = structuredClone(fake.paths)
    expect(await serve(fake.runner).enable(PORT, { replace: replacement() })).toMatchObject({
      serving: true,
      httpsPort: 443,
    })
    expect(fake.paths).toEqual(preserved)
    expect(fake.web['8443']).toBe('http://127.0.0.1:9000')
    expect(mutations(fake)).toEqual([
      ['serve', '--bg', '--https=443', '--set-path=/', '--yes', `http://127.0.0.1:${PORT}`],
    ])
    const mutationIndex = fake.calls.findIndex((args) => args.includes('--yes'))
    expect(fake.calls[mutationIndex - 1]).toEqual(['serve', 'status', '--json'])
  })

  it.each(['path', 'text'] as const)('can explicitly replace an observed %s root', async (kind) => {
    const target = kind === 'path' ? 'D:/foreign' : 'Foreign service'
    const fake = fakeTailscale({
      paths: { '443': { '/': kind === 'path' ? { Path: target } : { Text: target } } },
    })
    expect(
      await serve(fake.runner).enable(PORT, { replace: { ...replacement(target), kind } }),
    ).toMatchObject({ serving: true })
  })

  it('can confirm replacement of an empty text root through the RPC contract', async () => {
    const fake = fakeTailscale({ paths: { '443': { '/': { Text: '' } } } })
    const options = rpcParams['remote.tailscale.enable'].parse({
      replace: { ...replacement(''), kind: 'text' },
    })
    expect(await serve(fake.runner).enable(PORT, options)).toMatchObject({ serving: true })
    expect(mutations(fake)[0]).toContain('--yes')
  })

  it.each([
    { origin: 'https://other.tailnet.ts.net' },
    { target: 'http://127.0.0.1:9000' },
    { kind: 'path' as const },
  ])('rejects confirmation for a different observed mapping: %j', async (change) => {
    const fake = fakeTailscale({ web: { '443': 'http://127.0.0.1:3773' } })
    expect(
      (await serve(fake.runner).enable(PORT, { replace: { ...replacement(), ...change } })).error,
    ).toMatch(/exact current|mapping changed/)
    expect(mutations(fake)).toEqual([])
  })

  it('rejects a selected port that differs from the confirmation origin', async () => {
    const fake = fakeTailscale({ web: { '443': 'http://127.0.0.1:3773' } })
    expect(
      (await serve(fake.runner).enable(PORT, { httpsPort: 8443, replace: replacement() })).error,
    ).toMatch(/exact current/)
    expect(mutations(fake)).toEqual([])
  })

  it('fails CAS when the confirmed root changes just before mutation', async () => {
    const fake = fakeTailscale({
      web: { '443': 'http://127.0.0.1:3773' },
      onRead: (count, web) => {
        if (count === 2) web['443'] = 'http://127.0.0.1:9000'
      },
    })
    expect((await serve(fake.runner).enable(PORT, { replace: replacement() })).error).toMatch(
      /changed before/,
    )
    expect(mutations(fake)).toEqual([])
    expect(fake.web['443']).toBe('http://127.0.0.1:9000')
  })

  it('fails closed if a supposedly free alternate port becomes occupied', async () => {
    const fake = fakeTailscale({
      web: { '443': 'http://127.0.0.1:3773' },
      onRead: (count, web) => {
        if (count === 2) web['8443'] = 'http://127.0.0.1:9000'
      },
    })
    expect((await serve(fake.runner).enable(PORT)).error).toMatch(/changed before/)
    expect(mutations(fake)).toEqual([])
  })

  it('rechecks root kind even when the replacement target string is unchanged', async () => {
    const target = 'Foreign service'
    const fake = fakeTailscale({
      paths: { '443': { '/': { Text: target } } },
      onRead: (count, _web, paths) => {
        if (count === 2) paths['443']!['/'] = { Path: target }
      },
    })
    expect(
      (await serve(fake.runner).enable(PORT, { replace: { ...replacement(target), kind: 'text' } }))
        .error,
    ).toMatch(/changed before/)
    expect(mutations(fake)).toEqual([])
  })

  it('uses a wholly free port when 8443 has a sibling mount or TCP forwarding', async () => {
    const fake = fakeTailscale({
      web: { '443': 'http://127.0.0.1:3773' },
      paths: { '8443': { '/other': { Text: 'Other' } } },
      tcp: { '10000': { TCPForward: '127.0.0.1:9000' } },
    })
    expect(await serve(fake.runner).enable(PORT)).toMatchObject({ httpsPort: 10443, serving: true })
    expect(fake.paths['8443']).toEqual({ '/other': { Text: 'Other' } })
  })

  it('permits an explicitly chosen free root beside another mount', async () => {
    const fake = fakeTailscale({ paths: { '8443': { '/other': { Text: 'Other' } } } })
    expect(await serve(fake.runner).enable(PORT, { httpsPort: 8443 })).toMatchObject({
      httpsPort: 8443,
      serving: true,
    })
    expect(fake.paths['8443']).toEqual({ '/other': { Text: 'Other' } })
  })

  it('repairs an owned stale target across restart without prompting the user', async () => {
    const dir = tempDir('tailscale-owned-')
    const fake = fakeTailscale({})
    let gatewayPort = PORT
    await serve(fake.runner, dir, () => gatewayPort).enable(gatewayPort)
    gatewayPort = 9999
    const restarted = serve(fake.runner, dir, () => gatewayPort)
    expect(await restarted.status()).toMatchObject({
      target: `http://127.0.0.1:${PORT}`,
      owned: true,
      serving: false,
    })
    fake.calls.length = 0
    expect(await restarted.resume(gatewayPort)).toMatchObject({
      serving: true,
      target: 'http://127.0.0.1:9999',
    })
    expect(mutations(fake)).toEqual([
      ['serve', '--bg', '--https=443', '--set-path=/', '--yes', 'http://127.0.0.1:9999'],
    ])
    expect(JSON.parse(await readFile(join(dir, 'tailscale-serve.json'), 'utf8'))).toMatchObject({
      version: 1,
      httpsPort: 443,
      target: 'http://127.0.0.1:9999',
      enabled: true,
    })
  })

  it('remembers a selected non-443 origin and disables only its saved root after restart', async () => {
    const dir = tempDir('tailscale-port-')
    const fake = fakeTailscale({
      web: { '443': 'http://127.0.0.1:3773' },
      paths: { '8443': { '/other': { Text: 'Other' } } },
    })
    await serve(fake.runner, dir).enable(PORT, { httpsPort: 8443 })
    const restarted = serve(fake.runner, dir, () => 9999)
    expect(await restarted.status()).toMatchObject({
      httpsPort: 8443,
      origin: 'https://ari.tailnet.ts.net:8443',
      owned: true,
    })
    fake.calls.length = 0
    expect(await restarted.disable()).toMatchObject({
      serving: false,
      owned: false,
      httpsPort: 8443,
    })
    expect(mutations(fake)).toEqual([['serve', '--bg', '--https=8443', '--set-path=/', 'off']])
    expect(fake.web['443']).toBe('http://127.0.0.1:3773')
    expect(fake.paths['8443']).toEqual({ '/other': { Text: 'Other' } })
    fake.calls.length = 0
    expect(await serve(fake.runner, dir).resume(PORT)).toMatchObject({
      serving: false,
      httpsPort: 8443,
    })
    expect(mutations(fake)).toEqual([])
    expect(await serve(fake.runner, dir).enable(PORT)).toMatchObject({
      httpsPort: 8443,
      serving: true,
    })
  })

  it('retains a free selected port after disabling, including across a second restart', async () => {
    const dir = tempDir('tailscale-selection-')
    const fake = fakeTailscale({})
    const initial = serve(fake.runner, dir)
    await initial.enable(PORT, { httpsPort: 11443 })
    await initial.disable()
    expect(await serve(fake.runner, dir).enable(PORT)).toMatchObject({
      httpsPort: 11443,
      serving: true,
    })
  })

  it('restores a missing owned root beside a surviving sibling at the saved port', async () => {
    const dir = tempDir('tailscale-missing-root-')
    const fake = fakeTailscale({ paths: { '8443': { '/other': { Text: 'Other' } } } })
    await serve(fake.runner, dir).enable(PORT, { httpsPort: 8443 })
    delete fake.web['8443']
    expect(await serve(fake.runner, dir, () => 9999).resume(9999)).toMatchObject({
      httpsPort: 8443,
      target: 'http://127.0.0.1:9999',
      serving: true,
    })
    expect(fake.paths['8443']).toEqual({ '/other': { Text: 'Other' } })
  })

  it('refuses to mutate when the profile cannot be written', async () => {
    const dir = tempDir('tailscale-profile-error-')
    const file = join(dir, 'not-a-directory')
    await writeFile(file, 'preserve')
    const fake = fakeTailscale({})
    expect((await serve(fake.runner, file).enable(PORT)).error).not.toBeNull()
    expect(mutations(fake)).toEqual([])
    expect(await readFile(file, 'utf8')).toBe('preserve')
  })

  it('does not remove or repair a saved address that now belongs to another application', async () => {
    const dir = tempDir('tailscale-replaced-')
    const fake = fakeTailscale({})
    await serve(fake.runner, dir).enable(PORT)
    fake.web['443'] = 'http://127.0.0.1:9000'
    fake.calls.length = 0
    const restarted = serve(fake.runner, dir)
    expect((await restarted.resume(PORT)).error).toMatch(/now used by another/)
    expect((await restarted.disable()).error).toMatch(/saved Ari mount changed/)
    expect(mutations(fake)).toEqual([])
  })

  it('fails CAS on disable when the owned root is changed after its initial read', async () => {
    const dir = tempDir('tailscale-disable-race-')
    let changeOnRead = false
    let reads = 0
    const fake = fakeTailscale({
      onRead: (_count, web) => {
        if (changeOnRead && ++reads === 2) web['443'] = 'http://127.0.0.1:9000'
      },
    })
    const instance = serve(fake.runner, dir)
    await instance.enable(PORT)
    changeOnRead = true
    fake.calls.length = 0
    expect((await instance.disable()).error).toMatch(/changed before/)
    expect(mutations(fake)).toEqual([])
  })

  it('serializes concurrent enable and disable operations within one desktop', async () => {
    const fake = fakeTailscale({})
    const instance = serve(fake.runner)
    const [enabled, disabled] = await Promise.all([instance.enable(PORT), instance.disable()])
    expect(enabled.serving).toBe(true)
    expect(disabled.serving).toBe(false)
    expect(fake.web['443']).toBeUndefined()
  })

  it('requires disabling before moving a still owned live root to another port', async () => {
    const fake = fakeTailscale({})
    const instance = serve(fake.runner)
    await instance.enable(PORT)
    fake.calls.length = 0
    expect((await instance.enable(PORT, { httpsPort: 8443 })).error).toMatch(/Disable Ari/)
    expect(mutations(fake)).toEqual([])
  })

  it('never probes nonlocal proxy targets, files or text', async () => {
    const fake = fakeTailscale({
      web: { '443': 'http://example.com:80' },
      paths: { '8443': { '/files': { Path: 'D:/served' }, '/text': { Text: 'Hello' } } },
    })
    const listening = vi.fn(async () => true)
    const state = await new TailscaleServe({
      runner: fake.runner,
      port: () => PORT,
      listening,
    }).status()
    expect(listening).not.toHaveBeenCalled()
    expect(state.conflicts?.every((mapping) => mapping.listening === null)).toBe(true)
  })

  it('bounds diagnostics to sixteen loopback targets with at most two probes in flight', async () => {
    const web = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [
        String(12000 + index),
        `http://127.0.0.1:${13000 + index}`,
      ]),
    )
    let active = 0
    let maximum = 0
    const listening = vi.fn(async () => {
      maximum = Math.max(maximum, ++active)
      await new Promise((resolve) => setTimeout(resolve, 1))
      active--
      return false
    })
    const state = await new TailscaleServe({
      runner: fakeTailscale({ web }).runner,
      port: () => PORT,
      listening,
    }).status()
    expect(listening).toHaveBeenCalledTimes(16)
    expect(maximum).toBe(2)
    expect(state.conflicts).toHaveLength(20)
    expect(state.conflicts?.filter((mapping) => mapping.listening === false)).toHaveLength(16)
    expect(state.conflicts?.filter((mapping) => mapping.listening === null)).toHaveLength(4)
  })

  it('reports a dead owned gateway as offline while retaining its ownership', async () => {
    const fake = fakeTailscale({})
    let alive = true
    const instance = new TailscaleServe({
      runner: fake.runner,
      port: () => PORT,
      listening: async () => alive,
    })
    await instance.enable(PORT)
    alive = false
    expect(await instance.status()).toMatchObject({
      owned: true,
      serving: false,
      targetListening: false,
    })
  })

  it.each([
    { Web: 'unknown' },
    { Web: { 'ari.tailnet.ts.net:443': { Handlers: { '/': { Unknown: 'service' } } } } },
    { Web: { 'ari.tailnet.ts.net:443': { Handlers: { '/': { Proxy: 3773 } } } } },
    {
      Web: { 'ari.tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3773' } } } },
    },
    { TCP: { '443': { Unknown: true } } },
    { Services: { foreign: {} } },
    { Foreground: { foreign: {} } },
    { FutureListeners: {} },
  ])('fails closed on unknown configuration: %j', async (configuration) => {
    const fake = fakeTailscale({ configuration })
    const instance = serve(fake.runner)
    expect((await instance.enable(PORT)).error).toMatch(/could not understand/)
    expect((await instance.disable()).error).toMatch(/could not understand/)
    expect(mutations(fake)).toEqual([])
  })

  it('never exposes Ari on an existing Funnel port', async () => {
    const fake = fakeTailscale({
      configuration: {
        TCP: { '443': { HTTPS: true } },
        Web: {
          'ari.tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3773' } } },
        },
        AllowFunnel: { 'ari.tailnet.ts.net:443': true },
      },
    })
    expect((await serve(fake.runner).enable(PORT, { replace: replacement() })).error).toMatch(
      /Funnel/,
    )
    expect(mutations(fake)).toEqual([])
  })

  it.each([{ HTTP: true }, { TCPForward: '127.0.0.1:9000' }])(
    'refuses an explicitly selected incompatible listener: %j',
    async (listener) => {
      const fake = fakeTailscale({ tcp: { '8443': listener } })
      expect((await serve(fake.runner).enable(PORT, { httpsPort: 8443 })).error).toMatch(
        /HTTP, TCP/,
      )
      expect(mutations(fake)).toEqual([])
    },
  )

  it('leaves corrupt ownership intact and refuses mutation', async () => {
    const dir = tempDir('tailscale-corrupt-')
    await writeFile(join(dir, 'tailscale-serve.json'), '{broken')
    const fake = fakeTailscale({})
    expect((await serve(fake.runner, dir).enable(PORT)).error).toMatch(/saved Serve ownership/)
    expect(mutations(fake)).toEqual([])
    expect(await readFile(join(dir, 'tailscale-serve.json'), 'utf8')).toBe('{broken')
  })
})

describe('Tailscale RPC input contract', () => {
  it('accepts existing callers, alternate ports and exact root confirmations', () => {
    const schema = rpcParams['remote.tailscale.enable']
    expect(schema.safeParse(undefined).success).toBe(true)
    expect(schema.safeParse({ httpsPort: 8443 }).success).toBe(true)
    expect(schema.safeParse({ replace: replacement() }).success).toBe(true)
    for (const value of [
      { httpsPort: 0 },
      { httpsPort: 65536 },
      { httpsPort: 8443.5 },
      { replace: { ...replacement(), mountPath: '/other' } },
      { replace: { ...replacement(), kind: 'tcp' } },
      { replace: { ...replacement(), extra: true } },
      { replace: replacement('') },
    ])
      expect(schema.safeParse(value).success).toBe(false)
  })
})

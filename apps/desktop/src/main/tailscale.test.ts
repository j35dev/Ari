import { describe, expect, it } from 'vitest'
import { TailscaleServe, type TailscaleRunner } from './tailscale'

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
function serveStatus(mappings: Record<string, string>): string {
  const web: Record<string, unknown> = {}
  for (const [port, proxy] of Object.entries(mappings)) {
    web[`ari.tailnet.ts.net:${port}`] = { Handlers: { '/': { Proxy: proxy } } }
  }
  return JSON.stringify({ TCP: {}, Web: web, AllowFunnel: {} })
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
}): FakeTailscale {
  const calls: string[][] = []
  const web = { ...options.web }
  const status = options.status ?? { code: 0, stdout: statusJson() }
  const runner: TailscaleRunner = async (args) => {
    calls.push(args)
    const joined = args.join(' ')
    if (joined === 'status --json') {
      return { code: status.code ?? 0, stdout: status.stdout ?? '', stderr: status.stderr ?? '' }
    }
    if (joined === 'serve status --json') {
      return { code: 0, stdout: serveStatus(web), stderr: '' }
    }
    if (joined === 'serve status') {
      return { code: 0, stdout: '', stderr: '' }
    }
    if (options.serveCommand !== undefined && args[0] === 'serve' && args[1] !== 'status') {
      const failure = options.serveCommand
      if ((failure.code ?? 0) !== 0)
        return { code: failure.code ?? 1, stdout: '', stderr: failure.stderr ?? '' }
    }
    if (joined === `serve --bg --https=443 http://127.0.0.1:${PORT}`) {
      web['443'] = `http://127.0.0.1:${PORT}`
      return { code: 0, stdout: '', stderr: '' }
    }
    if (joined === 'serve --https=443 off') {
      delete web['443']
      return { code: 0, stdout: '', stderr: '' }
    }
    throw new Error(`unexpected tailscale arguments: ${joined}`)
  }
  return { runner, calls, web }
}

function serve(runner: TailscaleRunner): TailscaleServe {
  return new TailscaleServe({ runner, port: () => PORT })
}

describe('tailscale serve detection', () => {
  it('reports a machine without Tailscale instead of failing', async () => {
    const fake = fakeTailscale({ status: { code: 127, stderr: 'tailscale was not found on PATH' } })
    const state = await serve(fake.runner).status()

    expect(state).toEqual({
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

    expect(state).toEqual({
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
    expect(mutations).toEqual([[`serve`, '--bg', '--https=443', `http://127.0.0.1:${PORT}`]])
  })

  it('reports the existing 443 mapping rather than overwriting it', async () => {
    const fake = fakeTailscale({ web: { '443': 'http://127.0.0.1:9000' } })
    const state = await serve(fake.runner).enable(PORT)

    expect(state.serving).toBe(false)
    expect(state.error).toMatch(/already served at https:\/\/ari\.tailnet\.ts\.net/)
    expect(fake.web['443']).toBe('http://127.0.0.1:9000')
    expect(fake.calls.some((args) => args[1] === '--bg')).toBe(false)
  })

  it('is already done when our mapping exists, and runs nothing', async () => {
    const fake = fakeTailscale({ web: { '443': `http://127.0.0.1:${PORT}` } })
    const state = await serve(fake.runner).enable(PORT)

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
      web: { '443': `http://127.0.0.1:${PORT}`, '8443': 'http://127.0.0.1:9000' },
    })
    const state = await serve(fake.runner).disable()

    expect(state.serving).toBe(false)
    expect(state.error).toBeNull()
    expect(fake.web['8443']).toBe('http://127.0.0.1:9000')
    const mutations = fake.calls.filter((args) => args[0] === 'serve' && args[1] !== 'status')
    expect(mutations).toEqual([['serve', '--https=443', 'off']])
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

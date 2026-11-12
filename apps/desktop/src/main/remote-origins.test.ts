// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { TailscaleState } from '@ari/contracts/rpc'
import { RemoteOrigins } from './remote-origins'

const TAILNET = 'https://ari.tailnet.ts.net'
const CONNECT = 'https://connect.example.com'

function state(overrides: Partial<TailscaleState> = {}): TailscaleState {
  return {
    installed: true,
    dnsName: 'ari.tailnet.ts.net',
    origin: TAILNET,
    serving: true,
    error: null,
    ...overrides,
  }
}

function origins(options: {
  status: TailscaleState
  configured?: string[]
  remember?: (origin: string) => Promise<void>
}) {
  const remember = options.remember ?? vi.fn(async () => undefined)
  const configured = options.configured ?? [CONNECT]
  const store = { configured }
  const instance = new RemoteOrigins({
    status: async () => options.status,
    configured: () => store.configured,
    remember: async (origin) => {
      await remember(origin)
      store.configured = [...store.configured, origin]
    },
  })
  return { instance, remember, store }
}

describe('RemoteOrigins', () => {
  it('offers no address and the configured origins while Serve is off', async () => {
    const { instance, remember } = origins({ status: state({ serving: false }) })
    await instance.refresh()

    expect(instance.clientOrigin()).toBeNull()
    expect(instance.allowedOrigins()).toEqual([CONNECT])
    expect(remember).not.toHaveBeenCalled()
  })

  it('offers the tailnet address and allows it while Serve is on', async () => {
    const { instance } = origins({ status: state() })
    await instance.refresh()

    expect(instance.clientOrigin()).toBe(TAILNET)
    expect(instance.allowedOrigins()).toEqual([CONNECT, TAILNET])
  })

  it('writes the tailnet origin through once, so it survives a restart', async () => {
    const { instance, remember } = origins({ status: state() })
    await instance.refresh()
    await instance.refresh()

    // A refresh happens on every Tailscale RPC and on remote enable; the
    // settings file must only be written the first time.
    expect(remember).toHaveBeenCalledTimes(1)
    expect(remember).toHaveBeenCalledWith(TAILNET)
  })

  it('does not rewrite an origin the settings already hold', async () => {
    const { instance, remember } = origins({ status: state(), configured: [TAILNET] })
    await instance.refresh()

    expect(remember).not.toHaveBeenCalled()
    expect(instance.allowedOrigins()).toEqual([TAILNET])
  })

  it('keeps serving when the origin cannot be persisted', async () => {
    const { instance } = origins({
      status: state(),
      remember: async () => {
        throw new Error('disk is full')
      },
    })

    await expect(instance.refresh()).resolves.toEqual(state())
    expect(instance.clientOrigin()).toBe(TAILNET)
    expect(instance.allowedOrigins()).toContain(TAILNET)
  })

  it('reports a machine without Tailscale as nothing special', async () => {
    const { instance } = origins({
      status: state({
        installed: false,
        dnsName: null,
        origin: null,
        serving: false,
        error: 'Tailscale is not installed on this computer.',
      }),
    })
    await instance.refresh()

    expect(instance.clientOrigin()).toBeNull()
    expect(instance.allowedOrigins()).toEqual([CONNECT])
    expect(instance.state().error).toMatch(/not installed/)
  })

  it('uses and persists the exact alternate HTTPS origin across restart', async () => {
    const alternate = `${TAILNET}:8443`
    const first = origins({ status: state({ origin: alternate, httpsPort: 8443 }) })
    await first.instance.refresh()
    expect(first.instance.clientOrigin()).toBe(alternate)
    expect(first.instance.allowedOrigins()).toEqual([CONNECT, alternate])
    expect(first.instance.allowedOrigins()).not.toContain(TAILNET)
    expect(first.remember).toHaveBeenCalledWith(alternate)
    const restarted = origins({
      status: state({ origin: alternate, httpsPort: 8443 }),
      configured: first.store.configured,
    })
    await restarted.instance.refresh()
    expect(restarted.instance.clientOrigin()).toBe(alternate)
    expect(restarted.instance.allowedOrigins()).toEqual([CONNECT, alternate])
    expect(restarted.remember).not.toHaveBeenCalled()
  })

  it('never advertises a foreign or stale selected root as a pairing address', async () => {
    const alternate = `${TAILNET}:8443`
    const { instance, remember } = origins({
      status: state({
        origin: alternate,
        serving: false,
        owned: false,
        target: 'http://127.0.0.1:3773',
      }),
    })
    await instance.refresh()
    expect(instance.clientOrigin()).toBeNull()
    expect(instance.allowedOrigins()).toEqual([CONNECT])
    expect(remember).not.toHaveBeenCalled()
  })

  it('retries a failed origin write on the next refresh', async () => {
    const remember = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk is full'))
      .mockResolvedValue(undefined)
    const { instance } = origins({ status: state({ origin: `${TAILNET}:8443` }), remember })
    await instance.refresh()
    await instance.refresh()
    await instance.refresh()
    expect(remember).toHaveBeenCalledTimes(2)
    expect(instance.clientOrigin()).toBe(`${TAILNET}:8443`)
  })
})

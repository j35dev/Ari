// @vitest-environment node
import { generateKeyPairSync, sign } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionStore } from '@ari/engine/session-store'
import type { Engine } from './engine'
import { RemoteService } from './remote'
import { RemoteOrigins } from './remote-origins'
import { TailscaleServe, type TailscaleRunner } from './tailscale'
import { useTempDirs } from './testing/temp-dirs'

const tempDir = useTempDirs()
const services: RemoteService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.stop()
})

async function post(
  origin: string,
  publicOrigin: string,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: publicOrigin },
    body: JSON.stringify(body),
  })
  expect(response.status).toBe(200)
  return ((await response.json()) as { result: Record<string, unknown> }).result
}

describe('alternate-port Tailscale pairing origin', () => {
  it('keeps PWA, pairing and authenticated reconnect on the selected address after gateway restart', async () => {
    const profile = tempDir('tailscale-pairing-')
    const webRoot = tempDir('tailscale-web-')
    await writeFile(join(webRoot, 'index.html'), '<html>Ari test PWA</html>')
    const dnsName = 'ari.tailnet.ts.net'
    const publicOrigin = `https://${dnsName}:8443`
    const roots: Record<string, string> = { '443': 'http://127.0.0.1:3773' }
    const runner: TailscaleRunner = async (args) => {
      if (args[0] === 'status')
        return {
          code: 0,
          stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${dnsName}.` } }),
          stderr: '',
        }
      if (args[1] === 'status')
        return {
          code: 0,
          stdout: JSON.stringify({
            TCP: Object.fromEntries(Object.keys(roots).map((port) => [port, { HTTPS: true }])),
            Web: Object.fromEntries(
              Object.entries(roots).map(([port, target]) => [
                `${dnsName}:${port}`,
                { Handlers: { '/': { Proxy: target } } },
              ]),
            ),
          }),
          stderr: '',
        }
      const port = args.find((arg) => arg.startsWith('--https='))?.slice(8)
      if (port === undefined || !args.includes('--set-path=/'))
        throw new Error('unexpected Serve arguments')
      roots[port] = args.at(-1)!
      return { code: 0, stdout: '', stderr: '' }
    }
    let remote: RemoteService
    const gatewayPort = () => Number(new URL(remote.state().origin!).port)
    const createService = () => {
      const tailscale = new TailscaleServe({
        runner,
        port: gatewayPort,
        profileDir: profile,
        listening: async (target) => target !== 'http://127.0.0.1:3773',
      })
      const configured: string[] = []
      const origins = new RemoteOrigins({
        status: () => tailscale.status(),
        configured: () => configured,
        remember: async (origin) => {
          configured.push(origin)
        },
      })
      remote = new RemoteService(
        {
          engine: {} as Engine,
          store: {} as SessionStore,
          dir: join(profile, 'remote'),
          driverKinds: () => [],
          defaultPermissionMode: () => 'ask',
          defaultDriverKind: () => null,
          hasProject: async () => false,
          listProjects: async () => [],
          listModels: async () => [],
          mintSessionId: () => 'sess_test',
          clientOrigin: () => origins.clientOrigin(),
          allowedOrigins: () => origins.allowedOrigins(),
          webRoot: () => webRoot,
        },
        { port: 0 },
      )
      services.push(remote)
      return { remote, tailscale, origins }
    }
    const first = createService()
    await first.remote.start()
    expect(first.remote.running).toBe(true)
    expect(await first.tailscale.enable(gatewayPort())).toMatchObject({
      httpsPort: 8443,
      serving: true,
    })
    await first.origins.refresh()
    const invited = first.remote.invite()
    expect(invited.clientUrl).toBe(publicOrigin)
    expect(new URL(invited.invitation!.url).origin).toBe(publicOrigin)
    expect(new URL(invited.invitation!.url).hash).toMatch(/^#pair=inv_/)
    const response = await fetch(`${invited.origin}/`, { headers: { Origin: publicOrigin } })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Ari test PWA')
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const signedNonce = (nonce: string) =>
      sign('sha256', Buffer.from(nonce), { key: privateKey, dsaEncoding: 'der' }).toString('base64')
    const invitationId = invited.invitation!.invitationId
    const registered = await post(invited.origin!, publicOrigin, '/pair/request', {
      invitationId,
      displayName: 'Test phone',
      publicKey: publicKey.export({ format: 'jwk' }),
    })
    expect(registered['confirmationCode']).toBe(first.remote.state().pending?.confirmationCode)
    first.remote.approve(invitationId, registered['confirmationCode'] as string, [])
    const redeemed = await post(invited.origin!, publicOrigin, '/pair/redeem', {
      invitationId,
      nonce: registered['nonce'],
      signature: signedNonce(registered['nonce'] as string),
    })
    const deviceId = redeemed['deviceId'] as string
    expect(typeof redeemed['token']).toBe('string')
    expect(first.remote.state().devices[0]?.deviceId).toBe(deviceId)
    await first.remote.stop()
    const restarted = createService()
    await restarted.remote.start()
    expect(restarted.remote.running).toBe(true)
    // New OS-selected ports are repaired using the saved ownership record.
    expect(await restarted.tailscale.resume(gatewayPort())).toMatchObject({
      httpsPort: 8443,
      serving: true,
    })
    await restarted.origins.refresh()
    const newInvitation = restarted.remote.invite()
    expect(newInvitation.clientUrl).toBe(publicOrigin)
    expect(new URL(newInvitation.invitation!.url).origin).toBe(publicOrigin)
    expect(roots['443']).toBe('http://127.0.0.1:3773')
    expect(roots['8443']).toBe(`http://127.0.0.1:${gatewayPort()}`)
    expect(restarted.origins.allowedOrigins()).toEqual([publicOrigin])
    expect(restarted.remote.state().devices[0]?.deviceId).toBe(deviceId)
    const challenge = await post(newInvitation.origin!, publicOrigin, '/device/challenge', {
      deviceId,
    })
    const authorized = await post(newInvitation.origin!, publicOrigin, '/device/authorize', {
      deviceId,
      nonce: challenge['nonce'],
      signature: signedNonce(challenge['nonce'] as string),
    })
    expect(authorized['deviceId']).toBe(deviceId)
    expect(typeof authorized['token']).toBe('string')
    expect(authorized['token']).not.toBe(redeemed['token'])
    const rejected = await fetch(`${newInvitation.origin}/api/info`, {
      headers: { Origin: `https://${dnsName}` },
    })
    expect(rejected.status).toBe(403)
  })
})

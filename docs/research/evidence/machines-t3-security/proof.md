# Independent Machines route lifecycle proof

This is reviewer evidence, not runtime code. The script below loads immutable
Git objects through Node's module hooks. Zod/ws are read from the existing D:
integration dependencies; no dependency installation or checkout edit occurs.
Its sealed-key box is an AES-GCM fixture, not an OS
keyring claim. Its route walk uses a deterministic fake transport and real
MachinesService, registry, client, crypto and PairingService source. No real
Serve, app/profile, provider, network discovery or command execution is used.
Fixture profiles remain under the security worktree's existing `.review-temp`.

Extract the code block to `.review-temp/t3-route-proof.mjs`. Run only through
the shared resource runner after committing the review checkpoint. The commit
argument selects source; the optional second argument is `fixed` for a closure
run that requires both lifecycle gaps to be rejected.

```javascript
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { registerHooks, stripTypeScriptTypes, createRequire } from 'node:module'
import { createCipheriv, createDecipheriv, generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { join, posix, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const cwd = process.cwd()
const sha = process.argv[2] ?? '494566a5cf957c52c1a2b386c5e62034eaaa40c1'
const dependencyRoot = 'D:/Projects/Ari-machines'
const require = createRequire(pathToFileURL(join(dependencyRoot, 'package.json')))
const virtual = pathToFileURL(resolve(cwd, '.review-temp/t3-virtual')).href + '/'
const sourceCache = new Map()
const source = (path) => {
  if (!sourceCache.has(path)) sourceCache.set(path, execFileSync('git', ['show', `${sha}:${path}`], {
    cwd, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
  }))
  return sourceCache.get(path)
}
const exists = (path) => {
  try { execFileSync('git', ['cat-file', '-e', `${sha}:${path}`], { cwd, windowsHide: true, stdio: 'ignore' }); return true }
  catch { return false }
}
const sourceUrl = (path) => virtual + path
registerHooks({
  resolve(specifier, context, next) {
    let path = null
    if (specifier.startsWith(virtual)) return { url: specifier, shortCircuit: true }
    if (specifier.startsWith('@ari/')) {
      const match = /^@ari\/([^/]+)(.*)$/.exec(specifier)
      const root = `packages/${match[1]}`
      const manifest = JSON.parse(source(`${root}/package.json`))
      const exported = typeof manifest.exports === 'string' ? manifest.exports : manifest.exports[match[2] ? `.${match[2]}` : '.']
      assert.equal(typeof exported, 'string', `Missing source export ${specifier}`)
      path = posix.normalize(`${root}/${exported}`)
    } else if (specifier.startsWith('.') && context.parentURL?.startsWith(virtual)) {
      path = posix.normalize(posix.join(posix.dirname(context.parentURL.slice(virtual.length)), specifier))
      if (!/\.[mc]?[jt]sx?$/.test(path)) path = exists(`${path}.ts`) ? `${path}.ts` : `${path}/index.ts`
    } else if (!specifier.startsWith('node:') && context.parentURL?.startsWith(virtual)) {
      return { url: pathToFileURL(require.resolve(specifier, { paths: [dependencyRoot,
        join(dependencyRoot, 'packages/remote-client'), join(dependencyRoot, 'apps/desktop')] })).href, shortCircuit: true }
    }
    if (path) return { url: sourceUrl(path), shortCircuit: true }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith(virtual)) return { format: 'module',
      source: stripTypeScriptTypes(source(url.slice(virtual.length)), { mode: 'transform', sourceMap: false }), shortCircuit: true }
    return next(url, context)
  },
})

const { MachinesRegistry, DesktopMachineCredential } = await import(sourceUrl('apps/desktop/src/main/machines-registry.ts'))
const { MachinesService } = await import(sourceUrl('apps/desktop/src/main/machines.ts'))
const { MachineNetwork } = await import(sourceUrl('apps/desktop/src/main/machines-network.ts'))
const { createHostRouteSigner, ownedRouteAudience } = await import(sourceUrl('packages/remote-gateway/src/route-auth.ts'))
const { PairingService } = await import(sourceUrl('packages/remote-gateway/src/pairing.ts'))
const { verifyHostManifest, verifyRoute, authorizeRoute } = await import(sourceUrl('packages/remote-client/src/route-auth.ts'))
const { GatewayClient } = await import(sourceUrl('packages/remote-client/src/gateway-client.ts'))
const { hostRouteManifestSchema } = await import(sourceUrl('packages/contracts/src/route-auth.ts'))

const directory = resolve(cwd, '.review-temp')
mkdirSync(directory, { recursive: true })
const profile = mkdtempSync(join(directory, 't3-proof-'))
assert.ok(profile.startsWith(directory + '\\') || profile.startsWith(directory + '/'))
const encryptionKey = randomBytes(32)
const box = {
  encrypt(plain) {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv)
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64')
  },
  decrypt(value) {
    try {
      const bytes = Buffer.from(value, 'base64')
      const cipher = createDecipheriv('aes-256-gcm', encryptionKey, bytes.subarray(0, 12))
      cipher.setAuthTag(bytes.subarray(12, 28))
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8')
    } catch { return null }
  },
}
const a = 'http://127.0.0.1:8123'
const b = 'http://127.0.0.1:8124'
const signer = createHostRouteSigner('fixture_host', generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey)
const identity = { machineId: signer.hostId, name: 'Fixture', ariVersion: 'fixture', protocolVersion: 1,
  capabilities: ['gateway.info', 'project.list', 'device.revoke'], routeIdentity: { version: 1 } }
const pin = { hostId: signer.hostId, publicKey: signer.publicKey, credentialOrigin: a }
const manifest = (routes, issuedAt, revision = 1) => {
  const candidate = { kind: 'ari.routes.v1', hostId: signer.hostId, publicKey: signer.publicKey,
    issuedAt, expiresAt: issuedAt + 5 * 60_000, routes }
  if ('revision' in hostRouteManifestSchema.shape) candidate.revision = revision
  const payload = hostRouteManifestSchema.parse(candidate)
  return { payload, signature: signer.sign(payload) }
}

const registry = new MachinesRegistry(join(profile, 'machines.json'))
const row = registry.add('Fixture', { kind: 'loopback', origin: a }, identity)
const t = Date.now()
const older = manifest([a, b], t - 1000, 1)
const newer = manifest([a], t, 2)
registry.learn(row.id, await verifyHostManifest(newer, a, signer.hostId, pin), [{ kind: 'loopback', origin: a }])
assert.equal(registry.get(row.id).routes.some((route) => route.origin === b), false)
let oldReportRejected = false
try {
  registry.learn(row.id, await verifyHostManifest(older, a, signer.hostId, pin),
    [{ kind: 'loopback', origin: a }, { kind: 'loopback', origin: b }])
} catch { oldReportRejected = true }
const restoredDisappearedRoute = registry.get(row.id).routes.some((route) => route.origin === b)

const credential = new DesktopMachineCredential(row.id, registry, () => box)
const pairing = new PairingService()
const invitation = pairing.begin(a)
const pending = pairing.request(invitation.invitationId, { displayName: 'Fixture device', publicKey: await credential.publicKey() })
assert.equal(pending.ok, true)
assert.equal(pairing.approve(invitation.invitationId, pending.pending.confirmationCode, ['project'], true).ok, true)
const redemption = pairing.redeem(invitation.invitationId, { nonce: pending.nonce, signature: await credential.sign(pending.nonce) })
assert.equal(redemption.ok, true)
await credential.remember({ deviceId: redemption.device.deviceId, displayName: 'Fixture device', projectIds: ['project'] })
registry.update(row.id, { routes: [{ kind: 'loopback', origin: a, source: 'manual' },
  { kind: 'loopback', origin: b, source: 'manual', credentialOrigin: a }], hostKey: { hostId: signer.hostId, publicKey: signer.publicKey } })

const calls = []
let releaseLookup
let lookupStarted
const started = new Promise((resolve) => { lookupStarted = resolve })
const lookup = new Promise((resolve) => { releaseLookup = resolve })
let delayFirst = true
class Network extends MachineNetwork {
  async clientOptions(route) {
    if (delayFirst && route.origin === a) { delayFirst = false; lookupStarted(); await lookup }
    return { origin: route.origin, fetch: async (input, init) => {
      const path = new URL(input).pathname
      const body = JSON.parse(init.body)
      calls.push({ origin: route.origin, path, hasAuthorization: new Headers(init.headers).has('authorization') })
      let result
      if (path === '/info') result = identity
      else if (path === '/routes/proof') {
        const issuedAt = Date.now()
        const payload = { kind: 'ari.route-proof.v1', hostId: signer.hostId, audience: route.origin,
          nonce: body.nonce, issuedAt, expiresAt: issuedAt + 30_000, protocolVersion: 1 }
        result = { payload, signature: signer.sign(payload) }
      } else if (path === '/routes/challenge') {
        const payload = pairing.routeChallenge({ kind: 'ari.route-challenge.v1', hostId: signer.hostId,
          audience: route.origin, deviceId: body.deviceId, clientNonce: body.clientNonce })
        result = { payload, signature: signer.sign(payload) }
      } else if (path === '/routes/authorize') {
        const authorization = pairing.authorizeRoute(body.deviceId, body.audience, body)
        assert.equal(authorization.ok, true)
        result = { deviceId: authorization.device.deviceId, token: authorization.token,
          projectIds: authorization.device.projectIds, allProjects: authorization.device.allProjects,
          allowTerminal: authorization.device.allowTerminal }
      } else if (path === '/routes/manifest') result = manifest([a, b], Date.now(), 3)
      else throw new Error(`Unexpected fixture request ${path}`)
      return Response.json({ ok: true, result })
    } }
  }
}
const publication = []
const network = new Network()
const machines = new MachinesService({ dir: profile, allowLoopback: true, secretBox: () => box,
  network, precheckIntervalMs: 60 * 60_000, onChange: (views) => publication.push(structuredClone(views)) })
const walk = machines.connect(row.id)
await started
const removal = machines.removeRoute(row.id, a)
assert.equal(removal.routes.some((route) => route.origin === a), false)
const afterRemoval = calls.length
releaseLookup()
let walkError = null
try { await walk } catch (error) { walkError = error.message }
const publishedRemovedRoute = publication.some((views) => views.some((view) =>
  view.status === 'connected' && view.effectiveRoute === a && !view.routes.some((route) => route.origin === a)))
const proofToRemovedRoute = calls.slice(afterRemoval).some((call) => call.origin === a && call.path === '/routes/authorize')
machines.dispose()

// Independent grant checks: exact audience token, single-use challenge, revocation, no reverse device.
const freshNetwork = new Network()
const clientB = new GatewayClient(await freshNetwork.clientOptions({ kind: 'loopback', origin: b }))
const authorization = await authorizeRoute(clientB, pin, credential, credential.deviceId)
assert.ok(pairing.authenticate(authorization.token, b))
assert.equal(pairing.authenticate(authorization.token, a), undefined)
const last = calls.findLast((call) => call.path === '/routes/authorize')
assert.ok(last)
const challenge = pairing.routeChallenge({ kind: 'ari.route-challenge.v1', hostId: signer.hostId,
  audience: b, deviceId: credential.deviceId, clientNonce: 'fresh-nonce-which-is-at-least-32-chars' })
const { routeSigningText } = await import(sourceUrl('packages/contracts/src/route-auth.ts'))
const proof = { nonce: challenge.nonce, signature: await credential.sign(routeSigningText(challenge)) }
assert.equal(pairing.authorizeRoute(credential.deviceId, b, proof).ok, true)
assert.equal(pairing.authorizeRoute(credential.deviceId, b, proof).ok, false)
pairing.revoke(credential.deviceId)
assert.equal(pairing.authenticate(authorization.token, b), undefined)
assert.equal(new PairingService().devices().length, 0)
assert.equal(ownedRouteAudience({ signer, servedOrigins: () => [a], audience: () => b }), null)

// Wrong audience must fail before device identity/signature and must omit any cached bearer.
const rejectedCalls = []
const wrongClient = new GatewayClient({ origin: b, fetch: async (_input, init) => {
  rejectedCalls.push({ body: JSON.parse(init.body), authorization: new Headers(init.headers).get('authorization') })
  const issuedAt = Date.now()
  const payload = { kind: 'ari.route-proof.v1', hostId: signer.hostId, audience: a,
    nonce: rejectedCalls.at(-1).body.nonce, issuedAt, expiresAt: issuedAt + 30_000, protocolVersion: 1 }
  return Response.json({ ok: true, result: { payload, signature: signer.sign(payload) } })
} })
wrongClient.token = 'fixture-cached-bearer'
await assert.rejects(authorizeRoute(wrongClient, pin, credential, 'fixture_device'), { code: 'invalid_signature' })
assert.equal(rejectedCalls.length, 1)
assert.equal(rejectedCalls[0].authorization, null)
assert.equal('deviceId' in rejectedCalls[0].body, false)
assert.equal('signature' in rejectedCalls[0].body, false)

if (process.argv[3] === 'fixed') {
  assert.equal(oldReportRejected, true, 'Older report must be rejected')
  assert.equal(restoredDisappearedRoute, false, 'Disappeared learned route must stay removed')
  assert.equal(publishedRemovedRoute, false, 'Removed route must not publish')
  assert.equal(proofToRemovedRoute, false, 'Removed pending route must not receive device proof')
}
console.log(JSON.stringify({ source: sha, profile, oldReportRejected, restoredDisappearedRoute,
  publishedRemovedRoute, proofToRemovedRoute, walkError,
  routeTokenAudience: true, singleUseChallenge: true, revocation: true, noReverseGrant: true,
  unownedAudienceDenied: true, proofBeforeCredentials: true, success: true }, null, 2))
```

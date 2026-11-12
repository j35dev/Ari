# Independent execution of the combined normal-client proof

The builder below reuses the immutable Git module loader from `replay-proof.md`,
removes its IPC/inventory/action mocks, and executes the exact authored
`machines-normal-loopback.test.ts` at the selected SHA. A minimal assertion/spy
adapter replaces the Vitest runner only. Actual Engine, SessionStore, RemoteHost,
gateway HTTP/WebSocket, MachineNetwork DNS/TCP, MachinesService, RPC registry,
renderer IPC facade, SessionClient, inventory epochs, history and transcript stores
are loaded from that immutable source. The authored test itself injects an IPC
preload bridge, in-memory localStorage, fixture AES-GCM storage, provider runner,
CPU/memory counters and reachability controls. It uses actual loopback listeners;
no real TLS/Tailscale/OS keyring/provider process or React DOM is claimed.

Extract to `.review-temp/t3-combined-builder.mjs`, run the builder without source
execution, commit WIP, then execute `.review-temp/t3-combined-proof.mjs SHA` only
through the shared below-normal runner. Test temporary directories inherit the
runner's D: task cache. The test's cleanup verifies its absolute fixture root and
removes only that fixture; existing `.review-temp/` remains intact.

```javascript
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
let script = readFileSync('docs/research/evidence/machines-t3-security/replay-proof.md', 'utf8')
  .match(/```javascript\r?\n([\s\S]*?)\r?\n```/)[1].replaceAll('\r\n', '\n')
const start = script.indexOf('const fixtures = new Map([')
const end = script.indexOf('const sourceCache = new Map()', start)
assert.ok(start >= 0 && end > start)
script = script.slice(0, start) + `const fixtures = new Map([['review-fixture-vitest.js',
  'export const expect = globalThis.reviewExpect; export const vi = globalThis.reviewVi; export const afterEach = globalThis.reviewAfterEach; export const it = globalThis.reviewIt;']])\n` + script.slice(end)
const resolvePoint = '    let path = null\n'
assert.equal(script.split(resolvePoint).length, 2)
script = script.replace(resolvePoint, resolvePoint + `    if (specifier === 'vitest') return { url: virtual + 'review-fixture-vitest.js', shortCircuit: true }\n`)
const testStart = script.indexOf('globalThis.reviewEpoch = 0')
assert.ok(testStart > 0)
script = script.slice(0, testStart) + `
const restores = []
const globals = []
const after = []
let selectedTest = null
function partial(actual, expected) {
  if (expected && typeof expected === 'object') {
    assert.ok(actual && typeof actual === 'object')
    for (const [key, value] of Object.entries(expected)) partial(actual[key], value)
  } else assert.deepEqual(actual, expected)
}
globalThis.reviewExpect = function expect(value) {
  const build = (negated) => {
    const check = (assertion) => {
      if (!negated) { assertion(); return }
      let failed = false
      try { assertion() } catch (error) { if (error instanceof assert.AssertionError) failed = true; else throw error }
      assert.equal(failed, true, 'Negated assertion unexpectedly matched')
    }
    const matchers = {
      toBe: (expected) => check(() => assert.equal(value, expected)),
      toEqual: (expected) => check(() => assert.deepEqual(value, expected)),
      toHaveLength: (expected) => check(() => assert.equal(value.length, expected)),
      toMatchObject: (expected) => check(() => partial(value, expected)),
      toBeDefined: () => check(() => assert.notEqual(value, undefined)),
      toBeNull: () => check(() => assert.equal(value, null)),
      toBeGreaterThan: (expected) => check(() => assert.ok(value > expected)),
      toContain: (expected) => check(() => assert.ok(value.includes(expected))),
      toHaveBeenCalled: () => check(() => assert.ok(value.mock.calls.length > 0)),
    }
    Object.defineProperty(matchers, 'not', { get: () => build(!negated) })
    Object.defineProperty(matchers, 'rejects', { get: () => ({
      toThrow: async () => { await assert.rejects(Promise.resolve(value)) },
    }) })
    return matchers
  }
  return build(false)
}
globalThis.reviewVi = {
  spyOn(target, name) {
    const descriptor = Object.getOwnPropertyDescriptor(target, name)
    const original = target[name]
    const calls = []
    function spy(...args) { calls.push(args); return Reflect.apply(original, this, args) }
    spy.mock = { calls }
    target[name] = spy
    restores.push(() => descriptor ? Object.defineProperty(target, name, descriptor) : delete target[name])
    return spy
  },
  async waitFor(check, options = {}) {
    const start = Date.now()
    for (;;) {
      try { return await check() } catch (error) {
        if (Date.now() - start >= (options.timeout ?? 1000)) throw error
        await new Promise((done) => setTimeout(done, 20))
      }
    }
  },
  stubGlobal(name, value) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name)
    globals.push(() => descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name])
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })
  },
  restoreAllMocks() { for (const restore of restores.splice(0).reverse()) restore() },
  unstubAllGlobals() { for (const restore of globals.splice(0).reverse()) restore() },
}
globalThis.reviewAfterEach = (callback) => after.push(callback)
globalThis.reviewIt = (name, callback, timeout) => {
  assert.equal(selectedTest, null, 'This harness expects exactly one combined test')
  selectedTest = { name, callback, timeout }
}
await import(virtual + 'apps/desktop/src/main/machines-normal-loopback.test.ts')
assert.ok(selectedTest)
let timer
let failure = null
const runtimeStart = Date.now()
try {
  await Promise.race([selectedTest.callback(), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Combined source proof timed out')), selectedTest.timeout)
  })])
} catch (error) { failure = error }
finally {
  clearTimeout(timer)
  for (const callback of after) await callback()
}
if (failure) throw failure
console.log(JSON.stringify({ source: sha, exactAuthoredTest: selectedTest.name,
  runtimeMs: Date.now() - runtimeStart, initialJournalRows: 2406, initialMessageRows: 2405,
  normalClientFullResumeLive: true, signedRouteFallbackAndMoveBack: true,
  immutableOwnerAndSingleTurnDispatch: true, distinctRouteToken: true,
  noReverseAuthorization: true, repositoryGrouping: true, autoAndManualOnly: true,
  revokePurgesWatchedTranscript: true, otherHostRetainsAccess: true,
  preloadAndStorageAreFixtures: true, success: true }, null, 2))
`
writeFileSync('.review-temp/t3-combined-proof.mjs', script, 'utf8')
console.log('Prepared exact-source combined proof with standalone assertions.')
```

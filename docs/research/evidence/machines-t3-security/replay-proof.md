# Independent SessionClient replay reconnection proof

Load the actual immutable SessionClient and actual contract schemas. Only the
IPC transport, machine inventory, and unused action transport are fixtures.
No React DOM or real host is claimed. Existing D integration dependencies are
read-only. Extract this code block to `.review-temp/t3-replay-proof.mjs`, commit
the checkpoint and use the shared below-normal runner. The first argument is
the reviewed commit; the optional second argument `fixed` requires closure.

```javascript
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { registerHooks, stripTypeScriptTypes, createRequire } from 'node:module'
import { join, posix, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const cwd = process.cwd()
const sha = process.argv[2] ?? '47d32aba0a705b9738fcbafcb9c8f62585df2f0a'
const dependencyRoot = 'D:/Projects/Ari-machines'
const require = createRequire(pathToFileURL(join(dependencyRoot, 'package.json')))
const ts = require('typescript')
const virtual = pathToFileURL(resolve(cwd, '.review-temp/replay-virtual')).href + '/'
const fixtures = new Map([
  ['apps/desktop/src/renderer/src/lib/rpc.ts', `export const rpc = {
    invoke: async () => [], subscribe: (name, params, callback) => {
      globalThis.reviewStream = callback; return () => { globalThis.reviewStream = null }
    }
  }`],
  ['apps/desktop/src/renderer/src/features/session/session-machine-access.ts', `
    export const assertMachineOperation = async () => globalThis.reviewEpoch;
    export const machineEpoch = () => globalThis.reviewEpoch;
    export const sessionMachine = () => ({status:'connected'});
    export const machineCapabilityReason = () => null;
    export const observeMachineInventory = () => () => {};
    export const machineInventoryRevision = () => 0;
    export const refreshMachineInventory = async () => {};
  `],
  ['apps/desktop/src/renderer/src/features/machines/remote-client.ts', `
    export const remoteQuery = async () => undefined;
    export const sendRemote = async () => undefined;
    export const readReceipt = () => null;
    export const resolveReceipt = async () => undefined;
  `],
])
const sourceCache = new Map()
const source = (path) => {
  if (fixtures.has(path)) return fixtures.get(path)
  if (!sourceCache.has(path)) sourceCache.set(path, execFileSync('git', ['show', `${sha}:${path}`], {
    cwd, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
  }))
  return sourceCache.get(path)
}
const exists = (path) => {
  if (fixtures.has(path)) return true
  try { execFileSync('git', ['cat-file', '-e', `${sha}:${path}`], { cwd, windowsHide: true, stdio: 'ignore' }); return true }
  catch { return false }
}
registerHooks({
  resolve(specifier, context, next) {
    let path = null
    if (specifier.startsWith(virtual)) return { url: specifier, shortCircuit: true }
    if (specifier.startsWith('@ari/')) {
      const match = /^@ari\/([^/]+)(.*)$/.exec(specifier)
      const root = `packages/${match[1]}`
      const manifest = JSON.parse(source(`${root}/package.json`))
      const exported = typeof manifest.exports === 'string' ? manifest.exports : manifest.exports[match[2] ? `.${match[2]}` : '.']
      assert.equal(typeof exported, 'string')
      path = posix.normalize(`${root}/${exported}`)
    } else if (specifier.startsWith('.') && context.parentURL?.startsWith(virtual)) {
      path = posix.normalize(posix.join(posix.dirname(context.parentURL.slice(virtual.length)), specifier))
      if (!/\.[mc]?[jt]sx?$/.test(path)) path = exists(`${path}.ts`) ? `${path}.ts` : exists(`${path}.tsx`) ? `${path}.tsx` : `${path}/index.ts`
    } else if (!specifier.startsWith('node:') && context.parentURL?.startsWith(virtual)) {
      return { url: pathToFileURL(require.resolve(specifier, { paths: [dependencyRoot,
        join(dependencyRoot, 'apps/desktop')] })).href, shortCircuit: true }
    }
    if (path) return { url: virtual + path, shortCircuit: true }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith(virtual)) {
      const path = url.slice(virtual.length)
      const text = source(path)
      return { format: 'module', source: path.endsWith('.tsx') ? ts.transpileModule(text, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
      }).outputText : stripTypeScriptTypes(text, { mode: 'transform', sourceMap: false }), shortCircuit: true }
    }
    return next(url, context)
  },
})
globalThis.reviewEpoch = 0
const { createSessionClient } = await import(virtual + 'apps/desktop/src/renderer/src/features/session/session-client.tsx')
const scope = { kind: 'remote', machineId: 'fixture_machine', sessionId: 'sess_fixture' }
const client = createSessionClient(scope)
const frames = []
const close = client.subscribe('session.events', { sessionId: scope.sessionId }, (frame) => frames.push(frame))
await new Promise((done) => setImmediate(done))
assert.equal(typeof globalThis.reviewStream, 'function')
const emit = (frame) => globalThis.reviewStream({ machineId: scope.machineId,
  message: { type: 'events.desktop.frame', sessionId: scope.sessionId, frame } })
const event = (seq) => ({ type: 'session.updated', sessionId: scope.sessionId, seq, at: seq + 1, title: `Title ${seq}` })
emit({ kind: 'start', replayMode: 'full', fromSeq: null, throughSeq: 2099 })
for (let seq = 0; seq < 2100; seq += 128) emit({ kind: 'chunk',
  events: Array.from({ length: Math.min(128, 2100 - seq) }, (_, offset) => event(seq + offset)) })
emit({ kind: 'terminal', replayOutcome: 'complete', seq: 2099, liveTurnId: null, reason: null })
assert.equal(frames.flatMap((frame) => frame.events ?? []).length, 2100)
assert.equal(frames.at(-1).replayOutcome, 'complete')
const beforeResume = frames.length
emit({ kind: 'start', replayMode: 'resume', fromSeq: 2099, throughSeq: 2100 })
emit({ kind: 'chunk', events: [event(2100)] })
emit({ kind: 'terminal', replayOutcome: 'complete', seq: 2100, liveTurnId: 'turn_live', reason: null })
emit({ kind: 'live', event: event(2101) })
const resumed = frames.slice(beforeResume)
const resumeRejected = resumed.some((frame) => frame.replayOutcome === 'incomplete')
const resumeDelivered = resumed.some((frame) => frame.events?.some((row) => row.seq === 2100))
const liveDelivered = resumed.some((frame) => frame.event?.seq === 2101)
const beforeRevoke = frames.length
globalThis.reviewEpoch = 1
emit({ kind: 'live', event: event(2102) })
assert.equal(frames.length, beforeRevoke)
close()
if (process.argv[3] === 'fixed') {
  assert.equal(resumeRejected, false, 'Valid replay restart after completed history must be accepted')
  assert.equal(resumeDelivered, true, 'Resumed row must reach normal SessionClient')
  assert.equal(liveDelivered, true, 'Live rows after route replacement must continue')
}
console.log(JSON.stringify({ source: sha, initialRows: 2100, seqZero: true, initialComplete: true,
  resumeRejected, resumeDelivered, liveDelivered, epochFenced: true, success: true }, null, 2))
```

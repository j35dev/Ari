# Independent route closure proof preparation

The historical harness in `proof.md` requires a thrown rejection for an older
report. A silent durable no-op is also valid. The builder below extracts that
unchanged historical code and creates `.review-temp/t3-route-closure-proof.mjs`.
It adds initial learning, registry reload, byte-for-byte stale-report nonmutation,
equal-time narrowing across reload, and original credential-slot preservation.
The deterministic pending-DNS removal and grant/crypto checks remain unchanged.
This is review evidence only; no runtime source is edited. Use the shared runner
after committing the preparation, with the reviewed immutable SHA and `fixed`.

Extract this block to `.review-temp/t3-route-closure-builder.mjs` and run the builder
in the security worktree. The builder has no network or source-runtime execution.

```javascript
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
let text = readFileSync('docs/research/evidence/machines-t3-security/proof.md', 'utf8')
  .match(/```javascript\r?\n([\s\S]*?)\r?\n```/)[1].replaceAll('\r\n', '\n')
const replace = (before, after) => {
  assert.equal(text.split(before).length, 2, `Expected one historical match: ${before}`)
  text = text.replace(before, after)
}
replace("import { mkdirSync, mkdtempSync } from 'node:fs'",
  "import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'")
replace("const registry = new MachinesRegistry(join(profile, 'machines.json'))",
  "let registry = new MachinesRegistry(join(profile, 'machines.json'))")
replace("registry.learn(row.id, await verifyHostManifest(newer, a, signer.hostId, pin), [{ kind: 'loopback', origin: a }])",
  `registry.learn(row.id, await verifyHostManifest(older, a, signer.hostId, pin),
    [{ kind: 'loopback', origin: a }, { kind: 'loopback', origin: b }])
registry.learn(row.id, await verifyHostManifest(newer, a, signer.hostId, pin), [{ kind: 'loopback', origin: a }])
const durableBeforeReplay = readFileSync(join(profile, 'machines.json'), 'utf8')
registry = new MachinesRegistry(join(profile, 'machines.json'))`)
replace("const restoredDisappearedRoute = registry.get(row.id).routes.some((route) => route.origin === b)",
  `const restoredDisappearedRoute = registry.get(row.id).routes.some((route) => route.origin === b)
const ignoredStaleHighWater = readFileSync(join(profile, 'machines.json'), 'utf8') === durableBeforeReplay &&
  registry.get(row.id).manifest.payload.issuedAt === newer.payload.issuedAt
const equalTimeWide = manifest([a, b], t + 1, 3)
const equalTimeNarrow = manifest([a], t + 1, 3)
registry.learn(row.id, await verifyHostManifest(equalTimeWide, a, signer.hostId, pin),
  [{ kind: 'loopback', origin: a }, { kind: 'loopback', origin: b }])
registry.learn(row.id, await verifyHostManifest(equalTimeNarrow, a, signer.hostId, pin), [{ kind: 'loopback', origin: a }])
registry = new MachinesRegistry(join(profile, 'machines.json'))
registry.learn(row.id, await verifyHostManifest(equalTimeWide, a, signer.hostId, pin),
  [{ kind: 'loopback', origin: a }, { kind: 'loopback', origin: b }])
const equalTimeRemovalPreserved = !registry.get(row.id).routes.some((route) => route.origin === b)`)
replace("const walk = machines.connect(row.id)",
  "const cipherBeforeRemoval = registry.get(row.id).credentialCipher\nconst walk = machines.connect(row.id)")
replace("const afterRemoval = calls.length",
  `const savedAfterRemoval = new MachinesRegistry(join(profile, 'machines.json')).get(row.id)
const credentialSlotPreserved = savedAfterRemoval.credentialOrigin === a &&
  savedAfterRemoval.credentialCipher === cipherBeforeRemoval && savedAfterRemoval.hostKey.hostId === signer.hostId
const afterRemoval = calls.length`)
replace("assert.equal(oldReportRejected, true, 'Older report must be rejected')",
  `assert.equal(ignoredStaleHighWater, true, 'Stale report must not mutate durable state')
  assert.equal(equalTimeRemovalPreserved, true, 'Equal-time wider report must not restore a learned route after reload')
  assert.equal(credentialSlotPreserved, true, 'Removing an origin must preserve its original credential slot')`)
replace("publishedRemovedRoute, proofToRemovedRoute, walkError,",
  "publishedRemovedRoute, proofToRemovedRoute, walkError, ignoredStaleHighWater, equalTimeRemovalPreserved, credentialSlotPreserved,")
writeFileSync('.review-temp/t3-route-closure-proof.mjs', text, 'utf8')
console.log('Prepared independent route closure harness from historical evidence.')
```

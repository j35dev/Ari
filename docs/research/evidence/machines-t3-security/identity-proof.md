# Independent identity recovery proof

This builder copies the immutable Git-source loader from the combined proof,
then loads the exact machine-ID and host-signing implementation at the given
SHA. It uses real files and independent Node processes in the shared runner's
D: temporary directory. Only sealed storage is fixture AES-GCM. It checks fresh
publication, separate recovery storage, restart/missing/empty recovery, legacy
ID and sealed-key continuity, invalid-file preservation and concurrent fresh,
legacy, missing-primary and empty-primary initializers. No OS keyring, process
crash or power-loss durability claim is made. Source audit covers fsync and
no-replace publication; Windows directory fsync is explicitly unavailable.

Extract this builder to `.review-temp/t3-identity-builder.mjs`, run it to prepare
the wrapper, commit WIP, and execute the generated `.review-temp/t3-identity-proof.mjs`
through run-heavy only. It removes only its checked absolute fixture roots.

```javascript
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
const combined = readFileSync('.review-temp/t3-combined-proof.mjs', 'utf8')
const split = combined.indexOf('const restores = []')
assert.ok(split > 0)
const loader = combined.slice(0, split)
const checks = String.raw`
const fs = await import('node:fs')
const os = await import('node:os')
const { spawn } = await import('node:child_process')
const { randomBytes } = await import('node:crypto')
const { setTimeout: pause } = await import('node:timers/promises')
const { loadMachineIdentity } = await import(virtual + 'apps/desktop/src/main/machine-identity.ts')
if (process.argv[3] === '--child') {
  console.log('ready')
  while (!fs.existsSync(process.argv[5])) await pause(5)
  console.log(JSON.stringify(loadMachineIdentity(process.argv[4], 'child')))
} else {
  const { loadHostSigningIdentity } = await import(virtual + 'apps/desktop/src/main/host-signing-identity.ts')
  const { aesGcmSecretBox } = await import(virtual + 'apps/desktop/src/main/secret-box.ts')
  const parent = resolve(os.tmpdir())
  assert.ok(parent.toLowerCase().startsWith('d:\\projects\\.ari-cache\\'))
  const roots = []
  const profile = () => {
    const dir = fs.mkdtempSync(join(parent, 'security-t3-identity-'))
    roots.push(dir)
    return dir
  }
  const primary = (dir) => join(dir, 'identity.json')
  const recovery = (dir) => primary(dir) + '.recovery'
  async function concurrent(dir) {
    const marker = join(dir, 'start-' + roots.length)
    const children = Array.from({ length: 2 }, () => {
      let ready
      const started = new Promise((done) => { ready = done })
      const child = spawn(process.execPath, [resolve('.review-temp/t3-identity-proof.mjs'), sha, '--child', dir, marker],
        { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      if (child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL)
      let output = '', errors = ''
      child.stdout.on('data', (data) => { output += data; if (output.includes('ready\n')) ready() })
      child.stderr.on('data', (data) => { errors += data })
      const completed = new Promise((done, reject) => {
        child.once('error', (error) => { ready(); reject(error) })
        child.once('exit', (code) => { ready(); code === 0 ? done(output) : reject(new Error(errors || 'Child failed')) })
      })
      completed.catch(() => {})
      return { child, started, completed }
    })
    let timer
    try {
      const outputs = await Promise.race([
        (async () => {
          await Promise.all(children.map((child) => child.started))
          fs.writeFileSync(marker, '')
          return Promise.all(children.map((child) => child.completed))
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Concurrent identity proof timed out')), 15000) }),
      ])
      const identities = outputs.map((output) => JSON.parse(output.trim().split('\n').at(-1)))
      assert.deepEqual(identities[0], identities[1])
      assert.deepEqual(loadMachineIdentity(dir, 'child'), identities[0])
      assert.equal(fs.readdirSync(dir).some((name) => name.endsWith('.tmp')), false)
      return identities[0]
    } finally {
      clearTimeout(timer)
      for (const { child } of children) if (child.exitCode === null) child.kill()
      await Promise.allSettled(children.map((child) => child.completed))
    }
  }
  const concurrentCases = []
  try {
    const dir = profile()
    const first = loadMachineIdentity(dir, '1')
    assert.deepEqual(loadMachineIdentity(dir, '2'), { ...first, ariVersion: '2' })
    const recoveryBytes = fs.readFileSync(recovery(dir), 'utf8')
    fs.writeFileSync(primary(dir), '')
    assert.equal(fs.readFileSync(recovery(dir), 'utf8'), recoveryBytes)
    assert.deepEqual(loadMachineIdentity(dir, '3'), { ...first, ariVersion: '3' })
    assert.equal(fs.readFileSync(primary(dir) + '.empty', 'utf8'), '')
    fs.unlinkSync(primary(dir))
    assert.deepEqual(loadMachineIdentity(dir, '4'), { ...first, ariVersion: '4' })

    const legacy = profile()
    const raw = '{"machineId":"machine_legacy","name":"Original host"}'
    fs.writeFileSync(primary(legacy), raw)
    const box = aesGcmSecretBox(randomBytes(32))
    const oldSigner = loadHostSigningIdentity(legacy, 'machine_legacy', () => box)
    const keyBytes = fs.readFileSync(join(legacy, 'host-signing.json'), 'utf8')
    const anchorBytes = fs.readFileSync(join(legacy, 'host-signing-anchor.json'), 'utf8')
    assert.equal(loadMachineIdentity(legacy, '2').machineId, 'machine_legacy')
    assert.equal(fs.readFileSync(primary(legacy), 'utf8'), raw)
    fs.unlinkSync(primary(legacy))
    assert.equal(loadMachineIdentity(legacy, '3').machineId, 'machine_legacy')
    fs.writeFileSync(primary(legacy), '')
    assert.equal(loadMachineIdentity(legacy, '4').machineId, 'machine_legacy')
    assert.deepEqual(loadHostSigningIdentity(legacy, 'machine_legacy', () => box).publicKey, oldSigner.publicKey)
    assert.equal(fs.readFileSync(join(legacy, 'host-signing.json'), 'utf8'), keyBytes)
    assert.equal(fs.readFileSync(join(legacy, 'host-signing-anchor.json'), 'utf8'), anchorBytes)
    fs.unlinkSync(join(legacy, 'host-signing.json'))
    assert.throws(() => loadHostSigningIdentity(legacy, 'machine_legacy', () => box), /missing/)
    assert.equal(fs.existsSync(join(legacy, 'host-signing.json')), false)

    for (const invalid of ['', ' ', '{broken', '{"machineId":"machine_old"}']) {
      const bad = profile()
      fs.writeFileSync(primary(bad), invalid)
      assert.throws(() => loadMachineIdentity(bad, '1'))
      assert.equal(fs.readFileSync(primary(bad), 'utf8'), invalid)
      assert.equal(fs.existsSync(recovery(bad)), false)
    }
    for (const invalid of ['', '{broken', '{"machineId":"machine_other","name":"Other"}']) {
      const bad = profile()
      loadMachineIdentity(bad, '1')
      const bytes = fs.readFileSync(primary(bad), 'utf8')
      fs.writeFileSync(recovery(bad), invalid)
      assert.throws(() => loadMachineIdentity(bad, '2'))
      assert.equal(fs.readFileSync(primary(bad), 'utf8'), bytes)
      assert.equal(fs.readFileSync(recovery(bad), 'utf8'), invalid)
    }
    const malformed = profile()
    loadMachineIdentity(malformed, '1')
    fs.writeFileSync(primary(malformed), '{broken')
    assert.throws(() => loadMachineIdentity(malformed, '2'))
    assert.equal(fs.readFileSync(primary(malformed), 'utf8'), '{broken')

    const fresh = profile()
    await concurrent(fresh); concurrentCases.push('fresh')
    const old = profile()
    fs.writeFileSync(primary(old), raw)
    assert.equal((await concurrent(old)).machineId, 'machine_legacy')
    assert.equal(fs.readFileSync(primary(old), 'utf8'), raw)
    concurrentCases.push('legacy')
    const missing = profile()
    const beforeMissing = loadMachineIdentity(missing, 'child')
    fs.unlinkSync(primary(missing))
    assert.deepEqual(await concurrent(missing), beforeMissing); concurrentCases.push('missing-primary')
    const empty = profile()
    const beforeEmpty = loadMachineIdentity(empty, 'child')
    fs.writeFileSync(primary(empty), '')
    assert.deepEqual(await concurrent(empty), beforeEmpty); concurrentCases.push('empty-primary')
    assert.equal(fs.readFileSync(primary(empty) + '.empty', 'utf8'), '')
    console.log(JSON.stringify({ source: sha, stableWinner: true, separateRecovery: true,
      missingAndEmptyRecovery: true, legacyIDAndSealedKeyContinuity: true,
      noSigningKeyReset: true, invalidFilesPreserved: true, concurrentCases,
      realIndependentProcesses: true, fixtureSealedStorage: true, success: true }, null, 2))
  } finally {
    for (const root of roots) {
      assert.ok(root.startsWith(parent + '\\'))
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  }
}
`
writeFileSync('.review-temp/t3-identity-proof.mjs', loader + checks, 'utf8')
console.log('Prepared exact-source independent identity proof.')
```

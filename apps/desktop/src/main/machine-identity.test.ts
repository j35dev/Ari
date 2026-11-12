// @vitest-environment node
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { constants, setPriority, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { loadMachineIdentity } from './machine-identity'

const roots: string[] = []
const parent = resolve(tmpdir())
function profile() {
  const root = mkdtempSync(join(parent, 'ari-identity-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(parent + sep))
      throw new Error('Identity fixture escaped its parent.')
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

it('retains one identity and an independent recovery anchor across restarts and truncation', () => {
  const dir = profile()
  const first = loadMachineIdentity(dir, '1')
  expect(loadMachineIdentity(dir, '2')).toEqual({ ...first, ariVersion: '2' })
  const recovery = readFileSync(join(dir, 'identity.json.recovery'), 'utf8')
  writeFileSync(join(dir, 'identity.json'), '')
  expect(readFileSync(join(dir, 'identity.json.recovery'), 'utf8')).toBe(recovery)
  expect(loadMachineIdentity(dir, '3')).toEqual({ ...first, ariVersion: '3' })
  expect(readFileSync(join(dir, 'identity.json.empty'), 'utf8')).toBe('')
  expect(readdirSync(dir).some((name) => name.endsWith('.tmp'))).toBe(false)
})

it('reuses the durable winner when primary publication was lost', () => {
  const dir = profile()
  const first = loadMachineIdentity(dir, '1')
  unlinkSync(join(dir, 'identity.json'))
  expect(loadMachineIdentity(dir, '2')).toEqual({ ...first, ariVersion: '2' })
})

it('anchors a valid legacy identity without changing its bytes or ID', () => {
  const dir = profile()
  const original = '{"machineId":"machine_legacy","name":"Original host"}'
  writeFileSync(join(dir, 'identity.json'), original)
  expect(loadMachineIdentity(dir, '2').machineId).toBe('machine_legacy')
  expect(readFileSync(join(dir, 'identity.json'), 'utf8')).toBe(original)
  expect(JSON.parse(readFileSync(join(dir, 'identity.json.recovery'), 'utf8'))).toEqual(
    JSON.parse(original),
  )
})

it.each(['', ' ', '{broken', '{"machineId":"machine_old"}'])(
  'preserves unanchored invalid identity %j',
  (raw) => {
    const dir = profile()
    writeFileSync(join(dir, 'identity.json'), raw)
    expect(() => loadMachineIdentity(dir, '1')).toThrow()
    expect(readFileSync(join(dir, 'identity.json'), 'utf8')).toBe(raw)
    expect(existsSync(join(dir, 'identity.json.recovery'))).toBe(false)
  },
)

it('rejects mismatched and corrupt recovery records without modifying the primary', () => {
  const dir = profile()
  loadMachineIdentity(dir, '1')
  const primary = readFileSync(join(dir, 'identity.json'), 'utf8')
  writeFileSync(join(dir, 'identity.json.recovery'), '{"machineId":"machine_other","name":"Other"}')
  expect(() => loadMachineIdentity(dir, '2')).toThrow('disagrees')
  expect(readFileSync(join(dir, 'identity.json'), 'utf8')).toBe(primary)
  writeFileSync(join(dir, 'identity.json.recovery'), '{broken')
  expect(() => loadMachineIdentity(dir, '2')).toThrow()
  expect(readFileSync(join(dir, 'identity.json'), 'utf8')).toBe(primary)
})

it('preserves malformed primary data even with a valid recovery anchor', () => {
  const dir = profile()
  loadMachineIdentity(dir, '1')
  writeFileSync(join(dir, 'identity.json'), '{broken')
  expect(() => loadMachineIdentity(dir, '2')).toThrow()
  expect(readFileSync(join(dir, 'identity.json'), 'utf8')).toBe('{broken')
})

it('publishes the same complete winner for simultaneous independent processes', async () => {
  const dir = profile()
  const marker = join(dir, 'start')
  const source = pathToFileURL(resolve('src/main/machine-identity.ts')).href
  const script = `import { existsSync } from 'node:fs';
    import { setTimeout } from 'node:timers/promises';
    const { loadMachineIdentity } = await import(${JSON.stringify(source)});
    process.stdout.write('ready\\n');
    while (!existsSync(${JSON.stringify(marker)})) await setTimeout(5);
    process.stdout.write(JSON.stringify(loadMachineIdentity(${JSON.stringify(dir)}, 'child'))+'\\n');`
  const children = Array.from({ length: 2 }, () => {
    let ready!: () => void
    const started = new Promise<void>((done) => {
      ready = done
    })
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--input-type=module', '-e', script],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    if (child.pid) setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL)
    let output = ''
    let errors = ''
    child.stdout.on('data', (data: Buffer) => {
      output += data.toString()
      if (output.includes('ready\n')) ready()
    })
    child.stderr.on('data', (data: Buffer) => {
      errors += data.toString()
    })
    const completed = new Promise<string>((done, reject) => {
      child.once('error', reject)
      child.once('exit', (code) => {
        ready()
        if (code === 0) done(output)
        else reject(new Error(errors || `Child exit ${code}`))
      })
    })
    return { child, started, completed }
  })
  try {
    await Promise.all(children.map((child) => child.started))
    writeFileSync(marker, '')
    const outputs = await Promise.all(children.map((child) => child.completed))
    const identities = outputs.map((output) => JSON.parse(output.trim().split('\n').at(-1)!))
    expect(identities[0]).toEqual(identities[1])
    expect(loadMachineIdentity(dir, 'child')).toEqual(identities[0])
  } finally {
    for (const { child } of children) if (child.exitCode === null) child.kill()
  }
}, 30_000)

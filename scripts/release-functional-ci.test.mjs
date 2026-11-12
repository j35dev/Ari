import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { functionalPlans } from './release-functional-ci.mjs'

const hash = 'a'.repeat(64)
const context = {
  sourceHead: 'b'.repeat(40),
  platform: 'darwin',
  resources: '/test/Resources',
  executable: '/test/MacOS/ari',
  fixture: '/test/fixture.json',
  dataRoot: '/test/data',
  bootstrapSha256: hash,
  hostArch: 'arm64',
}
function native(arch) {
  return {
    kind: 'packaged-native-module-load',
    arch,
    platform: 'darwin',
    version: '0.3.14',
    electron: '43.4.1',
    physicalBehaviorTested: false,
    archive: join(context.resources, `app-${arch}.asar`),
    executableSha256: hash,
    asarSha256: hash,
  }
}
const receipt = {
  sourceHead: context.sourceHead,
  version: '0.3.14',
  platform: 'darwin',
  native: [native('arm64')],
}
test('macOS plans launch the runner-native slice with exact archive/hash identity', () => {
  const plans = functionalPlans(receipt, context)
  assert.deepEqual(
    plans.map((plan) => plan.arch),
    ['arm64'],
  )
  assert.equal(plans[0].archive, receipt.native[0].archive)
  assert.equal(plans[0].asarSha256, hash)
  const intel = functionalPlans(
    { ...receipt, native: [native('x64')] },
    { ...context, hostArch: 'x64' },
  )
  assert.deepEqual(
    intel.map((plan) => plan.arch),
    ['x64'],
  )
  for (const edit of [
    { sourceHead: 'c'.repeat(40) },
    { platform: 'win32' },
    { version: '0.3.12' },
    { nativeFailure: 'timed out' },
    { native: [] },
    { native: [native('x64')] },
    { native: [native('arm64'), native('arm64')] },
    { native: [{ ...native('arm64'), archive: '/test/unrelated.asar' }] },
    { native: [{ ...native('arm64'), asarSha256: null }] },
  ])
    assert.throws(() => functionalPlans({ ...receipt, ...edit }, context))
})
test('one-archive Windows package needs its exact x64 packaged receipt', () => {
  const win = { ...context, platform: 'win32' }
  const packaged = {
    ...native('x64'),
    platform: 'win32',
    archive: join(context.resources, 'app.asar'),
  }
  const plans = functionalPlans({ ...receipt, platform: 'win32', native: [packaged] }, win)
  assert.equal(plans.length, 1)
  assert.equal(plans[0].archive, packaged.archive)
  assert.throws(() =>
    functionalPlans(
      { ...receipt, platform: 'win32', native: [{ ...packaged, electron: '' }] },
      win,
    ),
  )
})

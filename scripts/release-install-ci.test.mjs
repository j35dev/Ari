import assert from 'node:assert/strict'
import { glob, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { URL } from 'node:url'
import { installInput } from './release-install-ci.mjs'

test('workflow retains actual randomly named install receipts on failure', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/release-candidate.yml', import.meta.url),
    'utf8',
  )
  const section = workflow
    .split('- name: Retain disposable install and installed-path proof')[1]
    ?.split('- name:')[0]
  assert.ok(section?.includes('if: always()'), 'Failed installs must retain their evidence')
  const pattern = section.match(/path: \$\{\{ runner\.temp \}\}\/([^\r\n]+)/)?.[1]
  assert.ok(pattern, 'Missing install evidence pattern')
  const runner = await mkdtemp(join(tmpdir(), 'ari-install-retention-test-'))
  for (const name of [
    'ari-install-upgrade-a1B2c3',
    'ari-install-upgrade-z9Y8x7',
    'unrelated-install',
  ]) {
    await mkdir(join(runner, name))
    await writeFile(join(runner, name, 'install-receipt.json'), '{}\n')
  }
  const receipts = []
  for await (const path of glob(pattern, { cwd: runner })) {
    if (path.endsWith('install-receipt.json')) receipts.push(path.replaceAll('\\', '/'))
  }
  assert.deepEqual(receipts.sort(), [
    'ari-install-upgrade-a1B2c3/install-receipt.json',
    'ari-install-upgrade-z9Y8x7/install-receipt.json',
  ])
})

test('install orchestration selects pinned platform assets from the exact package receipt', () => {
  for (const [platform, name, suffix] of [
    ['win32', 'Ari-Setup-0.3.14.exe', 'win-unpacked/ari.exe'],
    ['darwin', 'Ari-0.3.14-universal.dmg', 'mac-universal/ari.app/Contents/MacOS/ari'],
    ['linux', 'Ari-0.3.14.deb', 'linux-unpacked/ari'],
  ]) {
    const context = {
      sourceHead: 'a'.repeat(40),
      platform,
      dist: '/synthetic/dist',
      downloadRoot: '/synthetic/assets',
      fixture: '/synthetic/fixture',
    }
    const receipt = {
      sourceHead: context.sourceHead,
      platform,
      version: '0.3.14',
      files: [{ name }],
    }
    const input = installInput(receipt, context)
    assert.equal(input.packagedExecutable, join(context.dist, suffix))
    assert.equal(input.candidateArtifact, join(context.dist, name))
    assert.equal(
      input.previousArtifact,
      join(context.downloadRoot, name.replace('0.3.14', '0.3.13')),
    )
    for (const edit of [
      { sourceHead: 'b'.repeat(40) },
      { version: '0.3.13' },
      { nativeFailure: 'timeout' },
      { platform: 'other' },
      { files: [] },
      { files: [{ name }, { name }] },
    ])
      assert.throws(() => installInput({ ...receipt, ...edit }, context))
  }
})

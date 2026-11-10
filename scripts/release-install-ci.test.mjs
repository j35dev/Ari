import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { installInput } from './release-install-ci.mjs'

test('install orchestration selects pinned platform assets from the exact package receipt', () => {
  for (const [platform, name, suffix] of [
    ['win32', 'Ari-Setup-0.3.13.exe', 'win-unpacked/ari.exe'],
    ['darwin', 'Ari-0.3.13-universal.dmg', 'mac-universal/ari.app/Contents/MacOS/ari'],
    ['linux', 'Ari-0.3.13.deb', 'linux-unpacked/ari'],
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
      version: '0.3.13',
      files: [{ name }],
    }
    const input = installInput(receipt, context)
    assert.equal(input.packagedExecutable, join(context.dist, suffix))
    assert.equal(input.candidateArtifact, join(context.dist, name))
    assert.equal(
      input.previousArtifact,
      join(context.downloadRoot, name.replace('0.3.13', '0.3.12')),
    )
    for (const edit of [
      { sourceHead: 'b'.repeat(40) },
      { version: '0.3.12' },
      { nativeFailure: 'timeout' },
      { platform: 'other' },
      { files: [] },
      { files: [{ name }, { name }] },
    ])
      assert.throws(() => installInput({ ...receipt, ...edit }, context))
  }
})

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { verifyArtifacts } from './release-artifacts.mjs'

const version = '0.3.14'
async function fixture(platform = 'win32', edit = (metadata) => metadata) {
  const root = await mkdtemp(join(tmpdir(), 'ari-artifact-metadata-'))
  const plans = {
    win32: ['Ari-Setup-0.3.14.exe', 'latest.yml'],
    darwin: ['Ari-0.3.14-universal.zip', 'latest-mac.yml'],
    linux: ['Ari-0.3.14.AppImage', 'latest-linux.yml'],
  }
  const [update, metadataName] = plans[platform]
  const names =
    platform === 'win32'
      ? [update, `${update}.blockmap`]
      : platform === 'darwin'
        ? [
            update,
            `${update}.blockmap`,
            'Ari-0.3.14-universal.dmg',
            'Ari-0.3.14-universal.dmg.blockmap',
          ]
        : [update, 'Ari-0.3.14.deb']
  const bytes = Buffer.from('synthetic artifact; never executed')
  for (const name of names) await writeFile(join(root, name), bytes)
  const metadata = edit({
    version,
    files: [
      {
        url: update,
        size: bytes.length,
        sha512: createHash('sha512').update(bytes).digest('base64'),
      },
    ],
  })
  // JSON is valid YAML, exercising the packaging parser and actual file hashes.
  await writeFile(join(root, metadataName), JSON.stringify(metadata))
  return root
}

for (const platform of ['win32', 'darwin', 'linux'])
  test(`checks actual artifact/update hashes for ${platform}`, async () => {
    const result = await verifyArtifacts(await fixture(platform), platform, version)
    assert.equal(result.version, version)
    assert.ok(result.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)))
  })

test('rejects a metadata version from the previous release', async () => {
  const root = await fixture('win32', (metadata) => ({ ...metadata, version: '0.3.12' }))
  await assert.rejects(verifyArtifacts(root, 'win32', version), /version mismatch/)
})
test('rejects corruption after metadata was generated', async () => {
  const root = await fixture()
  await writeFile(join(root, 'Ari-Setup-0.3.14.exe'), 'changed artifact')
  await assert.rejects(verifyArtifacts(root, 'win32', version), /size mismatch|checksum mismatch/)
})
test('rejects an escaped update URL', async () => {
  const root = await fixture('win32', (metadata) => ({
    ...metadata,
    files: [{ ...metadata.files[0], url: '../Ari-Setup-0.3.14.exe' }],
  }))
  await assert.rejects(verifyArtifacts(root, 'win32', version), /expected local artifact/)
})
test('rejects a stale checksum even when size matches', async () => {
  const root = await fixture('win32', (metadata) => ({
    ...metadata,
    files: [{ ...metadata.files[0], sha512: 'wrong' }],
  }))
  await assert.rejects(verifyArtifacts(root, 'win32', version), /checksum mismatch/)
})

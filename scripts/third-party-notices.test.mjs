import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { collect, declaredLicense, licenseFiles, render } from './third-party-notices.mjs'

async function pkg(root, name, manifest, files = { LICENSE: `${name} license` }) {
  const dir = join(root, 'node_modules', ...name.split('/'))
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', ...manifest }),
  )
  for (const [file, text] of Object.entries(files)) await writeFile(join(dir, file), text)
  return dir
}

test('finds license and notice files, not look-alikes', () => {
  assert.deepEqual(
    licenseFiles(['README.md', 'LICENSE', 'license-mit.txt', 'NOTICE', 'licenses.js.map', 'x.js']),
    ['LICENSE', 'NOTICE', 'license-mit.txt'],
  )
  assert.deepEqual(licenseFiles(['COPYING', 'index.js']), ['COPYING'])
})

test('reads every historical shape of the license field', () => {
  assert.equal(declaredLicense({ license: 'MIT' }), 'MIT')
  assert.equal(declaredLicense({ license: { type: 'ISC' } }), 'ISC')
  assert.equal(declaredLicense({ licenses: [{ type: 'MIT' }, 'Apache-2.0'] }), 'MIT OR Apache-2.0')
  assert.equal(declaredLicense({}), 'UNKNOWN')
})

test('walks shipped dependencies, skips workspace packages, and shares identical texts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ari-notices-'))
  await pkg(root, 'shipped', {
    license: 'MIT',
    dependencies: { leaf: '1' },
    optionalDependencies: { native: '1' },
  })
  await pkg(root, 'leaf', { license: 'MIT' }, { LICENSE: 'shared text' })
  await pkg(root, 'native', { license: 'MIT' }, {})
  await pkg(root, '@ari/core', { dependencies: { bundled: '1' } })
  await pkg(
    root,
    'bundled',
    { license: 'MIT', optionalDependencies: { binary: '1' } },
    { LICENSE: 'shared text' },
  )
  await pkg(root, 'binary', { license: 'UNLICENSED' })

  const result = collect([
    { name: 'shipped', from: root, bundled: false },
    { name: '@ari/core', from: root, bundled: true },
    { name: 'gone', from: root, bundled: false },
  ])
  const names = result.packages.map((entry) => entry.name).sort()
  // A bundler inlines JS but not the binaries a package spawns.
  assert.deepEqual(names, ['bundled', 'leaf', 'native', 'shipped'])
  assert.deepEqual(result.missing, ['gone'])

  const text = render(result)
  assert.equal(text.split('shared text').length - 1, 1)
  assert.match(text, /bundled@1\.0\.0 \(MIT\)\nleaf@1\.0\.0 \(MIT\)/)
  assert.match(text, /ship no license file[\s\S]*native@1\.0\.0 \(MIT\)/)
  assert.match(text, /other platforms[\s\S]*gone/)
})

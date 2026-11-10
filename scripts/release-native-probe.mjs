// Module-load probe only. Never starts hooks, shells, recording, or the Ari app.
import assert from 'node:assert/strict'
import { existsSync, realpathSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join, relative, isAbsolute, sep } from 'node:path'
const nodeRequire = createRequire(import.meta.url)

function stage(value) {
  console.error(JSON.stringify({ kind: 'packaged-native-stage', stage: value, arch: process.arch }))
}

function contained(root, path) {
  const delta = relative(root, path)
  return delta !== '..' && !delta.startsWith(`..${sep}`) && !isAbsolute(delta)
}

try {
  stage('runtime-entry')
  assert.ok(process.versions.electron, 'This probe requires the reviewed packaged Electron binary')
  assert.equal(process.env.ELECTRON_RUN_AS_NODE, '1')
  const [archive, expectedArch] = process.argv.slice(2)
  assert.ok(archive && isAbsolute(archive), 'An absolute app archive is required')
  assert.equal(process.arch, expectedArch)
  const appRequire = createRequire(join(archive, 'package.json'))
  const unpacked = `${archive}.unpacked`
  assert.ok(existsSync(unpacked), 'The selected archive has no unpacked directory')
  const nativeLoads = []
  const originalLoad = nodeRequire.extensions['.node']
  nodeRequire.extensions['.node'] = (module, filename) => {
    const physical = filename.includes(`${archive}${sep}`)
      ? filename.replace(archive, unpacked)
      : filename
    assert.ok(
      contained(realpathSync(unpacked), realpathSync(physical)),
      'Addon escaped the package',
    )
    nativeLoads.push({
      path: physical,
      sha256: createHash('sha256').update(readFileSync(physical)).digest('hex'),
    })
    stage(`addon-loading:${relative(unpacked, physical)}`)
    originalLoad(module, filename)
    stage(`addon-loaded:${relative(unpacked, physical)}`)
  }
  const modules = {}
  for (const name of ['@lydell/node-pty', 'koffi', 'uiohook-napi']) {
    stage(`module-loading:${name}`)
    const resolved = appRequire.resolve(name)
    assert.ok(
      contained(archive, resolved) || contained(unpacked, resolved),
      `${name} escaped the archive`,
    )
    const api = appRequire(name)
    if (name === '@lydell/node-pty') assert.equal(typeof api.spawn, 'function')
    if (name === 'koffi') assert.equal(typeof api.load, 'function')
    if (name === 'uiohook-napi') {
      assert.equal(typeof api.uIOhook.start, 'function')
      assert.equal(api.UiohookKey.Space, 57)
    }
    modules[name] = { resolved, loaded: true }
    stage(`module-loaded:${name}`)
  }
  // Windows PTY loading is lazy: requiring its JS entry does not load ConPTY.
  const ptyName = `@lydell/node-pty-${process.platform}-${process.arch}`
  const ptyDir = dirname(dirname(appRequire.resolve(ptyName)))
  const prebuilds = join(ptyDir, 'prebuilds', `${process.platform}-${process.arch}`)
  const addons = process.platform === 'win32' ? ['conpty', 'conpty_console_list'] : ['pty']
  for (const addon of addons) appRequire(join(prebuilds, `${addon}.node`))
  const helpers =
    process.platform === 'win32'
      ? ['conpty/OpenConsole.exe', 'conpty/conpty.dll']
      : process.platform === 'darwin'
        ? ['spawn-helper']
        : []
  for (const helper of helpers)
    assert.ok(existsSync(join(prebuilds, helper)), `PTY helper ${helper} is missing`)
  assert.ok(nativeLoads.length >= 3, 'Expected PTY, Koffi and hook native addons to load')
  const packaged = appRequire('./package.json')
  console.log(
    JSON.stringify({
      kind: 'packaged-native-module-load',
      version: packaged.version,
      electron: process.versions.electron,
      node: process.versions.node,
      napi: process.versions.napi,
      platform: process.platform,
      arch: process.arch,
      archive,
      modules,
      nativeLoads,
      physicalBehaviorTested: false,
    }),
  )
  process.exit(0)
} catch (error) {
  console.error(JSON.stringify({ kind: 'packaged-native-module-load', error: String(error) }))
  process.exit(1)
}

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { preflight } from './release-macos-preflight.mjs'

test('translation diagnostics preserve separate system and packaged startup failures without native execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ari-macos-diagnostics-'))
  const executable = join(root, 'not-an-executable')
  await writeFile(executable, 'fixture only')
  let calls = 0
  const result = await preflight(executable, root, async (file, args, options) => {
    calls++
    assert.equal(options.windowsHide, true)
    assert.equal(options.timeout, 15_000)
    assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1')
    assert.equal(options.env.ARI_CONTROL_TOKEN, undefined)
    if (file.endsWith('pkgutil')) throw Object.assign(new Error('No package receipt'), { code: 1 })
    if (args.includes('/usr/bin/uname')) return { stdout: 'x86_64\n', stderr: '' }
    throw Object.assign(new Error('Timeout before JavaScript'), {
      code: null,
      signal: 'SIGTERM',
      killed: true,
      stdout: '',
      stderr: '',
    })
  })
  assert.equal(calls, 3)
  assert.equal(result.commands[0].required, false)
  assert.equal(result.commands[1].success, true)
  assert.equal(result.commands[2].success, false)
  assert.equal(result.commands[2].signal, 'SIGTERM')
  assert.equal(result.commands[2].killed, true)
})

test('ordinary local invocation rejects before selecting a packaged executable', async () => {
  await assert.rejects(
    promisify(execFile)(process.execPath, ['scripts/release-macos-preflight.mjs'], {
      env: { ...process.env, CI: '' },
      windowsHide: true,
      timeout: 5000,
    }),
    (error) => /CI-only/.test(error.stderr),
  )
})

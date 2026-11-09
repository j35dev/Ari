import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { app } from 'electron'
import type { uIOhook, UiohookKey } from 'uiohook-napi'

// Load through app.asar to exercise electron-builder's real unpack mapping.
void app
  .whenReady()
  .then(() => {
    const root = process.env['ARIA_WIDGET_PACKAGE'] ?? 'D:/tmp/aria-widget-package/win-unpacked'
    const resources = join(root, 'resources')
    assert.ok(
      existsSync(
        join(
          resources,
          'app.asar.unpacked/node_modules/uiohook-napi/prebuilds',
          `${process.platform}-${process.arch}`,
          'uiohook-napi.node',
        ),
      ),
    )
    const require = createRequire(import.meta.url)
    const hook = require(join(resources, 'app.asar/node_modules/uiohook-napi')) as {
      uIOhook: typeof uIOhook
      UiohookKey: typeof UiohookKey
    }
    assert.equal(hook.UiohookKey.Space, 57)
    hook.uIOhook.start()
    hook.uIOhook.stop()
    console.log('Packaged app.asar hook loaded and started successfully')
  })
  .then(
    () => app.exit(0),
    (error: unknown) => {
      console.error(error)
      app.exit(1)
    },
  )

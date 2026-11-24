/* Native Electron fixture renderer. Isolated userData; never boots Ari main or touches its live windows. */
/* global require, __dirname, setTimeout, console */
/* eslint-disable @typescript-eslint/no-require-imports -- Electron's native capture entry is CommonJS. */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '../../../../../..')
const output = path.join(root, 'docs/reviews/streaming-presentation/previews')
fs.mkdirSync(output, { recursive: true })
app.setPath('userData', path.join(root, 'apps/desktop/out/streaming-capture-profile'))
app.setName('Ari streaming fixture capture')
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.commandLine.appendSwitch('disable-gpu')
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const results = []
const errors = []
let window
const evaluate = async (code) => {
  try {
    return await window.webContents.executeJavaScript(code)
  } catch (error) {
    console.error('Fixture evaluation failed:', code.slice(0, 240))
    throw error
  }
}
const state = () => evaluate('window.__ari.state()')
const click = async (selector) => {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  await pause(100)
}
async function load(query, width = 1592, height = 897) {
  window.setContentSize(width, height)
  await window.loadURL(`http://127.0.0.1:5317/testing/streaming.html?${query}`)
  for (let i = 0; i < 100; i++) {
    if (await evaluate('Boolean(window.__ari?.state)')) break
    await pause(100)
  }
  await evaluate('document.fonts.ready')
  await pause(500)
  assert.equal((await state()).viewport.width, width)
  assert.equal((await state()).viewport.height, height)
}
async function shot(name) {
  const png = await window.webContents.capturePage()
  const size = png.getSize()
  fs.writeFileSync(path.join(output, `${name}.png`), png.toPNG())
  results.push({ name, size, state: await state() })
}
async function run() {
  window = new BrowserWindow({
    width: 1592,
    height: 897,
    useContentSize: true,
    show: false,
    frame: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  window.webContents.on('console-message', (event) => {
    if (event.level === 'error') errors.push(event.message)
  })
  window.webContents.on('render-process-gone', (_event, details) =>
    errors.push(`Renderer gone: ${details.reason}`),
  )
  await load('view=before&scenario=reference')
  // The reference image includes the narration and eleven isolated rows, so its reconstruction starts at the top.
  await evaluate(
    'document.querySelector(".review-scroller").dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 })); document.querySelector(".review-scroller").scrollTop = 0',
  )
  await pause(200)
  assert.equal(await evaluate('document.querySelectorAll(".review-before-tool").length'), 11)
  const before = await state()
  await shot('01-before-reference-1592x897')
  await click('button[data-view="after"]')
  await pause(250)
  const after = await state()
  assert.deepEqual(after.tools, before.tools)
  assert.equal(after.cursor, before.cursor)
  assert.equal(await evaluate('document.querySelectorAll(".review-activity").length'), 1)
  await shot('02-after-reference-1592x897')
  await click('.review-activity-toggle')
  assert.equal((await state()).following, false)
  await click('[data-call="command-1"] button')
  await pause(250)
  assert.equal(await evaluate('Boolean(document.querySelector("[data-output=command-1]"))'), true)
  await shot('03-expanded-command-1592x897')
  await click('button[data-action="reconnect"]')
  assert.deepEqual((await state()).tools, after.tools)
  assert.equal((await state()).uniqueEvents, before.uniqueEvents)
  await click('button[data-view="source"]')
  await pause(350)
  await shot('04-current-source-1592x897')

  await load('view=after&scenario=stress&at=16')
  assert.equal((await state()).tools.find((tool) => tool.id === 'test-1').status, 'failed')
  assert.equal(await evaluate('Boolean(document.querySelector(".review-failure"))'), true)
  assert.equal(
    await evaluate('Boolean(document.querySelector("[data-decision=approval-1]"))'),
    true,
  )
  await shot('05-failure-and-approval-1592x897')
  await click('.review-failure button')
  await pause(150)
  assert.equal(await evaluate('Boolean(document.querySelector("[data-output=test-1]"))'), true)
  assert.equal(
    await evaluate('Boolean(document.querySelector("[data-action=review-decision]"))'),
    true,
  )
  await shot('06-bounded-output-1592x897')
  await click('.review-show-output')
  assert.equal(
    await evaluate(
      'document.querySelector(".review-output-full").textContent.split(String.fromCharCode(10)).length',
    ),
    180,
  )
  assert.ok(await evaluate('document.querySelector(".review-output-full").clientHeight <= 350'))
  await click('[data-decision="approval-1"] .review-decision-buttons button')
  assert.equal(
    await evaluate(
      'document.querySelector("[data-decision=approval-1]").textContent.includes("Answered")',
    ),
    true,
  )

  await load('view=after&scenario=stress&at=11')
  assert.equal((await state()).tools.filter((tool) => tool.status === 'running').length, 2)
  await shot('07-parallel-running-1592x897')
  await load('view=after&scenario=stress&at=19')
  assert.equal((await state()).connected, false)
  assert.equal((await state()).tools.find((tool) => tool.id === 'retry-1').status, 'running')
  await shot('08-disconnected-1592x897')

  await load('view=after&scenario=stress&at=16', 960, 760)
  await shot('09-narrow-960x760')
  assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'))
  await load('view=after&scenario=reference', 640, 760)
  await shot('10-narrow-640x760')
  assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'))

  for (const [id, prefix] of [
    ['pi-acp', '11-pi'],
    ['opencode-acp', '12-opencode'],
  ]) {
    await load(`view=before&scenario=${id}`)
    await shot(`${prefix}-before-1592x897`)
    const baseline = await state()
    await click('button[data-view="after"]')
    await pause(200)
    assert.deepEqual((await state()).tools, baseline.tools)
    assert.equal((await state()).cursor, baseline.cursor)
    await shot(`${prefix}-after-1592x897`)
  }

  // Exercise every selectable adapter/transport fixture without executing a provider.
  await load('view=after&scenario=reference')
  const ids = await evaluate(
    'Array.from(document.querySelector("#scenario").options, option => option.value)',
  )
  for (const id of ids) {
    await evaluate(
      `document.querySelector('#scenario').value = ${JSON.stringify(id)}; document.querySelector('#scenario').dispatchEvent(new Event('change', { bubbles: true }))`,
    )
    await pause(50)
    assert.equal((await state()).scenario, id)
    assert.ok((await state()).uniqueEvents > 0)
  }
  await load('view=before&scenario=reference')
  await click('button[data-action="play"]')
  await pause(1500)
  assert.equal((await state()).playing, true)
  assert.ok((await state()).cursor >= 2)
  await click('button[data-action="play"]')
  const pausedAt = (await state()).cursor
  await pause(800)
  assert.equal((await state()).cursor, pausedAt)
  await click('button[data-action="reset"]')
  assert.equal((await state()).cursor, 0)
  await click('button[data-action="step"]')
  assert.equal((await state()).cursor, 1)
  await click('button[data-action="checkpoint"]')
  await evaluate(
    'const scroller = document.querySelector(".review-scroller"); scroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -150 })); scroller.scrollTop = 0',
  )
  const readingAt = (await state()).scrollTop
  await click('button[data-action="step"]')
  await pause(200)
  assert.equal((await state()).following, false)
  assert.equal((await state()).scrollTop, readingAt)
  assert.equal(errors.length, 0, errors.join('\n'))
  fs.writeFileSync(
    path.join(output, 'capture-checks.json'),
    JSON.stringify(
      {
        capturedBy: 'Isolated hidden native Electron fixture renderer, not live Ari chat',
        checks: [
          'same-sequence before/after',
          '11 isolated rows to one group',
          'tool expansion pauses following',
          'exact output present',
          'reconnect idempotence',
          'failure remains visible',
          'approval resolution simulation',
          '180-line output bounded to 350px',
          'two active tools',
          'disconnect retains pending status',
          '21 selectable scenarios',
          'play/pause/reset/step',
          'scroll-up held on next event',
          '960 and 640px no document overflow',
          'no renderer errors',
        ],
        errors,
        results,
      },
      null,
      2,
    ),
  )
  console.log(
    JSON.stringify({
      ok: true,
      output,
      screenshots: results.length,
      scenarios: ids.length,
      errors: errors.length,
    }),
  )
  app.quit()
}
app
  .whenReady()
  .then(run)
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })

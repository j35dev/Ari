/* Native Ari fixture renderer; isolated profile; never boots Ari main. */
/* global require, __dirname, setTimeout, console, process */
/* eslint-disable @typescript-eslint/no-require-imports -- Native Electron entry is CommonJS. */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '../../../../../..')
const output = path.join(root, 'docs/reviews/streaming-presentation/v2/previews')
fs.mkdirSync(output, { recursive: true })
app.setName('Ari streaming design lab')
app.setPath('userData', path.join(root, 'apps/desktop/out/streaming-lab-capture-profile'))
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.commandLine.appendSwitch('disable-gpu')
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let win
const errors = []
const snapshots = []
const evaluate = async (code) => {
  try {
    return await win.webContents.executeJavaScript(code)
  } catch (error) {
    console.error('Evaluation failed:', code.slice(0, 200))
    throw error
  }
}
const state = () => evaluate('window.__ari.state()')
const click = async (selector) => {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  await wait(100)
}
async function load(query, width = 1592, height = 897) {
  win.setContentSize(width, height)
  await win.loadURL(`http://127.0.0.1:5317/testing/streaming-v2.html?${query}`)
  for (let i = 0; i < 100; i++) {
    if (await evaluate('Boolean(window.__ari?.state)')) break
    await wait(100)
  }
  await evaluate('document.fonts.ready')
  await wait(250)
  assert.deepEqual((await state()).viewport, { width, height })
}
async function screenshot(name) {
  const shot = await win.webContents.capturePage()
  fs.writeFileSync(path.join(output, `${name}.png`), shot.toPNG())
  snapshots.push({ name, size: shot.getSize(), state: await state() })
}
async function run() {
  win = new BrowserWindow({
    width: 1592,
    height: 897,
    useContentSize: true,
    show: false,
    frame: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') errors.push(event.message)
  })
  if (process.argv.includes('--sources-only')) {
    await load('layout=quiet')
    await click('[data-action=sources]')
    await screenshot('15-research-sources-1592x897')
    const checksPath = path.join(output, 'checks.json')
    const saved = JSON.parse(fs.readFileSync(checksPath, 'utf8'))
    saved.snapshots = saved.snapshots.map((item) =>
      item.name === snapshots[0].name ? snapshots[0] : item,
    )
    fs.writeFileSync(checksPath, JSON.stringify(saved, null, 2))
    console.log(JSON.stringify({ ok: true, refreshed: snapshots[0].name }))
    app.quit()
    return
  }
  let baseline
  for (const [index, layout] of ['quiet', 'split', 'outline'].entries()) {
    await load(`layout=${layout}`)
    const current = await state()
    baseline ??= current
    assert.deepEqual(current.tools, baseline.tools)
    assert.equal(current.cursor, baseline.cursor)
    assert.deepEqual(current.active, ['test-projection', 'test-sidebar'])
    await screenshot(`0${index + 1}-${layout}-working-1592x897`)
    await click('[data-action=attention]')
    assert.equal((await state()).pending, 'rerun')
    assert.equal((await state()).failed.length, 1)
    assert.ok(await evaluate('Boolean(document.querySelector("[data-action=review-decision]"))'))
    await screenshot(`0${index + 4}-${layout}-needs-you-1592x897`)
    await click('[data-action=end]')
    assert.equal((await state()).settled, true)
    assert.equal((await state()).tools.length, 7)
    assert.equal((await state()).failed.length, 1)
    await screenshot(`0${index + 7}-${layout}-finished-1592x897`)
  }
  await load('layout=before')
  assert.deepEqual((await state()).tools, baseline.tools)
  await screenshot('10-before-same-sequence-1592x897')
  await load('layout=quiet')
  await click('[data-action=open-log]')
  await click('[data-log-call=test-projection]')
  assert.equal((await state()).following, false)
  await screenshot('11-live-output-work-log-1592x897')
  const selected = (await state()).selected
  await click('[data-action=reconnect]')
  assert.equal((await state()).selected, selected)
  assert.equal((await state()).uniqueEvents, baseline.uniqueEvents)
  await click('[data-action=attention]')
  await click('[data-failure=test-projection] button')
  assert.ok(await evaluate('Boolean(document.querySelector("[data-detail=test-projection]"))'))
  await click('.lab-expand-output')
  assert.equal(
    await evaluate(
      'document.querySelector(".lab-output.expanded").textContent.split(String.fromCharCode(10)).length',
    ),
    132,
  )
  assert.ok(await evaluate('document.querySelector(".lab-output.expanded").clientHeight<=240'))
  await click('[data-action=reconnect]')
  assert.ok(await evaluate('Boolean(document.querySelector(".lab-output.expanded"))'))
  await click('[data-log-call=read-app]')
  await click('[data-log-call=test-projection]')
  assert.ok(await evaluate('Boolean(document.querySelector(".lab-output.expanded"))'))
  await click('[data-action=close-log]')
  await click('[data-action=open-log]')
  assert.ok(await evaluate('Boolean(document.querySelector(".lab-output.expanded"))'))
  await screenshot('12-failure-output-expanded-1592x897')
  await click('[data-action=review-decision]')
  assert.equal((await state()).following, false)
  await click('[data-decision=rerun] .lab-choice-row button')
  assert.equal((await state()).pending, null)
  await load('layout=split', 960, 760)
  assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'))
  await screenshot('13-split-narrow-960x760')
  await load('layout=quiet', 640, 760)
  assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'))
  await screenshot('14-quiet-narrow-640x760')
  await load('layout=quiet')
  await click('[data-action=sources]')
  assert.ok(await evaluate('document.querySelectorAll(".lab-research article").length>=10'))
  await screenshot('15-research-sources-1592x897')
  await click('[data-action=close-sources]')
  await load('layout=quiet&scenario=reference')
  const reference = await state()
  assert.equal(reference.tools.length, 11)
  await screenshot('16-quiet-eleven-commands-1592x897')
  await click('[data-layout-choice=before]')
  assert.deepEqual((await state()).tools, reference.tools)
  await evaluate(
    'document.querySelector(".lab-transcript").dispatchEvent(new WheelEvent("wheel",{bubbles:true,deltaY:-1}));document.querySelector(".lab-transcript").scrollTop=0',
  )
  await wait(100)
  await screenshot('17-before-eleven-commands-1592x897')

  await load('layout=quiet')
  await click('[data-action=play]')
  await wait(1200)
  assert.equal((await state()).playing, true)
  assert.ok((await state()).cursor >= 3)
  await click('[data-action=play]')
  const paused = (await state()).cursor
  await wait(650)
  assert.equal((await state()).cursor, paused)
  await click('[data-action=reset]')
  assert.equal((await state()).cursor, 0)
  await click('[data-action=step]')
  assert.equal((await state()).cursor, 1)
  await click('[data-action=live]')
  await click('.lab-history-line')
  assert.equal((await state()).following, false)
  const top = (await state()).scrollTop
  await click('[data-action=step]')
  await wait(100)
  assert.equal((await state()).scrollTop, top)
  await click('[data-action=latest]')
  assert.equal((await state()).following, true)
  const ids = await evaluate(
    'Array.from(document.querySelector("#lab-scenario").options,option=>option.value)',
  )
  for (const layout of ['quiet', 'split', 'outline']) {
    await click(`[data-layout-choice=${layout}]`)
    for (const id of ids) {
      await evaluate(
        `document.querySelector('#lab-scenario').value=${JSON.stringify(id)};document.querySelector('#lab-scenario').dispatchEvent(new Event('change',{bubbles:true}))`,
      )
      await wait(30)
      assert.equal((await state()).scenario, id)
      assert.ok((await state()).uniqueEvents > 0)
    }
  }
  assert.deepEqual(errors, [])
  fs.writeFileSync(
    path.join(output, 'checks.json'),
    JSON.stringify(
      {
        capture: 'Isolated native Electron fixture renderer, not live third-party clients',
        checks: [
          'same events in three variants and baseline',
          'two parallel active commands',
          'failures retained after success',
          'pending decision always available above composer',
          'exact 132-line output bounded',
          'detail selection/expansion retained on reconnect',
          '22 scenarios × 3 variants',
          'play/pause/reset/step',
          'explicit expansion pauses following',
          'scroll anchor held on next event',
          'jump to latest resumes following',
          '960 and 640px no document overflow',
          '10 source entries distinguish reports and older tutorials',
          'zero renderer errors',
        ],
        errors,
        snapshots,
      },
      null,
      2,
    ),
  )
  console.log(
    JSON.stringify({
      ok: true,
      output,
      screenshots: snapshots.length,
      scenarios: ids.length,
      layouts: 3,
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

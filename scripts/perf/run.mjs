/* global setInterval, clearInterval */
// Ari performance harness: cold start, session switching, streaming + typing,
// main-process responsiveness and memory on the real built app.
// Usage: node scripts/perf/run.mjs --app <worktree> --label <name> [--runs 3] [--build]
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, platform, release, tmpdir, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { appDataDir, ensureBuild, launch, sleep, treeMemory, withTimeout } from './app.mjs'
import { loadStores, seedProfile, startFakeModel } from './fixtures.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const { values: opt } = parseArgs({
  options: {
    app: { type: 'string', default: resolve(here, '..', '..') },
    label: { type: 'string', default: 'run' },
    out: { type: 'string', default: join(tmpdir(), 'ari-perf') },
    runs: { type: 'string', default: '3' },
    build: { type: 'boolean', default: false },
    'no-throttle': { type: 'boolean', default: false },
    'throttle-rate': { type: 'string', default: '4' },
    'stream-seconds': { type: 'string', default: '20' },
    'tokens-per-second': { type: 'string', default: '50' },
    'long-turns': { type: 'string', default: '300' },
    theme: { type: 'string', default: 'redline' },
    wallpaper: { type: 'string', default: 'anime-city' },
    window: { type: 'string', default: '1400x820' },
    'keep-profile': { type: 'boolean', default: false },
  },
})
const runs = Number(opt.runs)
const appDir = resolve(opt.app)
const desktopDir = join(appDir, 'apps', 'desktop')
const outDir = join(opt.out, opt.label)
const scratchName = `Ari Perf ${process.pid}`
const profileDir = join(appDataDir(), scratchName)
const scratchDir = join(outDir, 'scratch')
const probe = readFileSync(join(here, 'probe.js'), 'utf8')
const [winW, winH] = opt.window.split('x').map(Number)

// ---- stats ------------------------------------------------------------------
const pct = (xs, p) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : null
}
const summary = (xs) => ({
  n: xs.filter(Number.isFinite).length,
  median: pct(xs, 50),
  p95: pct(xs, 95),
  max: pct(xs, 100),
})
const results = { metrics: {}, raw: {}, errors: [] }
const record = (name, value, unit = 'ms') =>
  (results.raw[name] ??= { unit, values: [] }).values.push(value)

function cpuSnapshot() {
  return cpus().reduce(
    (a, c) => ({
      idle: a.idle + c.times.idle,
      total: a.total + Object.values(c.times).reduce((x, y) => x + y, 0),
    }),
    { idle: 0, total: 0 },
  )
}
const loadSamples = []
let lastCpu = cpuSnapshot()
const loadTimer = setInterval(() => {
  const now = cpuSnapshot()
  loadSamples.push(Math.round(100 * (1 - (now.idle - lastCpu.idle) / (now.total - lastCpu.total))))
  lastCpu = now
}, 5000)

async function step(name, fn) {
  try {
    return await fn()
  } catch (error) {
    console.error(`[perf] ${name} failed: ${error.message}`)
    results.errors.push({ step: name, message: error.message })
    return null
  }
}

// ---- scenarios --------------------------------------------------------------
async function waitInteractive(app) {
  for (
    const t0 = Date.now();
    !(await app.eval('window.__perf?.marks.interactive !== undefined'));
    await sleep(100)
  ) {
    if (Date.now() - t0 > 90_000) {
      const state = await app.eval(
        'JSON.stringify({ perf: !!window.__perf, marks: window.__perf?.marks, url: location.href })',
      )
      throw new Error(`shell never became interactive: ${state}`)
    }
  }
  return app.eval('window.__perf.boot()')
}

async function click(app, title) {
  let at = null
  for (let i = 0; i < 50 && !at; i++)
    at = (await app.eval(`window.__perf.row(${JSON.stringify(title)})`)) ?? (await sleep(100))
  if (!at) throw new Error(`sidebar row "${title}" not found`)
  await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at })
  await app.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    ...at,
    button: 'left',
    clickCount: 1,
  })
  await app.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    ...at,
    button: 'left',
    clickCount: 1,
  })
}

async function measureSwitch(app, metric, session) {
  await app.eval(`window.__perf.armSwitch(${JSON.stringify(session.href)})`)
  await click(app, session.title)
  const r = await app.eval('window.__perf.pending', 45_000)
  if (r.error) throw new Error(r.error)
  record(`${metric}.paint`, r.paintMs)
  record(`${metric}.settled`, r.settleMs)
  record(`${metric}.longTasks`, r.longTasks, 'count')
  record(`${metric}.longTaskMs`, r.longTaskMs)
  await sleep(800)
}

async function measureStream(app, prefix, session, model) {
  await click(app, session.title)
  await sleep(1500)
  if (!(await app.eval('window.__perf.composer()'))) throw new Error('composer not found')
  const started = model.next('start')
  const ended = model.next('end')
  const command = {
    type: 'turn.start',
    sessionId: session.id,
    text: 'Write a long, detailed answer with code.',
    attachments: [],
  }
  await app.eval(`window.ari.invoke('command.dispatch', ${JSON.stringify({ command })})`)
  await withTimeout(started, 30_000, 'fake model never received the turn')
  await app.eval('window.__perf.begin()')
  await app.main.send('Runtime.evaluate', {
    expression:
      "globalThis.__perfLoop ??= process.getBuiltinModule('node:perf_hooks').monitorEventLoopDelay({ resolution: 10 }); __perfLoop.reset(); __perfLoop.enable()",
  })
  let typing = true
  const keys = 'the quick brown fox jumps over the lazy dog '
  const typer = (async () => {
    for (let i = 0; typing; i++) {
      const ch = keys[i % keys.length]
      const key =
        ch === ' '
          ? { key: ' ', code: 'Space', windowsVirtualKeyCode: 32 }
          : {
              key: ch,
              code: `Key${ch.toUpperCase()}`,
              windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0),
            }
      await app.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, ...key })
      await app.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
      await sleep(200)
    }
  })()
  const tokens = await withTimeout(
    ended,
    Number(opt['stream-seconds']) * 1000 + 60_000,
    'stream end',
  )
  typing = false
  await typer
  const r = await app.eval('window.__perf.end()')
  // The fake reply opens with heading "1000. …"; without it the turn errored instead of streaming.
  if (
    !(await app.eval(
      `[...document.querySelectorAll('h3')].some((h) => h.textContent.startsWith('1000. ') && h.getBoundingClientRect().height > 0)`,
    ))
  ) {
    throw new Error('streamed reply never rendered in the transcript (turn failed?)')
  }
  const loop = await app.main.send('Runtime.evaluate', {
    expression:
      '__perfLoop.disable(), JSON.stringify({ p50: __perfLoop.percentile(50) / 1e6, p95: __perfLoop.percentile(95) / 1e6, max: __perfLoop.max / 1e6 })',
    returnByValue: true,
  })
  record(`${prefix}.longTasks`, r.longTasks.length, 'count')
  record(
    `${prefix}.longTaskMs`,
    r.longTasks.reduce((a, b) => a + b, 0),
  )
  for (const p of [50, 95]) record(`${prefix}.frame.p${p}`, pct(r.frames, p))
  record(`${prefix}.frame.max`, pct(r.frames, 100))
  record(`${prefix}.framesOver50ms`, r.frames.filter((f) => f > 50).length, 'count')
  for (const p of [50, 95]) record(`${prefix}.typing.p${p}`, pct(r.keys, p))
  record(`${prefix}.typing.max`, pct(r.keys, 100))
  record(`${prefix}.typing.keysMeasured`, r.keys.length, 'count')
  for (const p of [50, 95]) record(`${prefix}.pingRpc.p${p}`, pct(r.pings, p))
  record(`${prefix}.pingRpc.max`, pct(r.pings, 100))
  if (loop.result?.value) {
    const l = JSON.parse(loop.result.value)
    record(`${prefix}.mainLoopDelay.p50`, l.p50)
    record(`${prefix}.mainLoopDelay.p95`, l.p95)
    record(`${prefix}.mainLoopDelay.max`, l.max)
  }
  record(`${prefix}.tokensStreamed`, tokens, 'count')
  // Let the turn settle so the next scenario starts from an idle session.
  for (let i = 0; i < 100; i++) {
    const m = await app.eval(
      `window.ari.invoke('session.load', { sessionId: ${JSON.stringify(session.id)} })`,
    )
    if (!m?.activeTurnId) break
    await sleep(200)
  }
  await app.eval(
    `(() => { const el = document.activeElement; if (el && 'value' in el) { el.select?.(); document.execCommand('delete') } })()`,
  )
}

async function memory(app, prefix) {
  const heap = await app.send('Runtime.getHeapUsage')
  record(`${prefix}.rendererHeapMB`, Math.round(heap.usedSize / 1048576), 'MB')
  const tree = treeMemory(app.pid)
  record(`${prefix}.workingSetMB`, tree.workingSetMB, 'MB')
  if (tree.privateMB !== null) record(`${prefix}.privateMB`, tree.privateMB, 'MB')
  record(`${prefix}.processes`, tree.processes, 'count')
}

// ---- main -------------------------------------------------------------------
function streamEvents() {
  const waiters = []
  return {
    emit: (kind, value) =>
      waiters.splice(0).forEach((w) => (w.kind === kind ? w.resolve(value) : waiters.push(w))),
    next: (kind) => new Promise((resolve) => waiters.push({ kind, resolve })),
  }
}

async function main() {
  mkdirSync(scratchDir, { recursive: true })
  rmSync(profileDir, { recursive: true, force: true })
  await ensureBuild(appDir, opt.build)
  const events = streamEvents()
  const model = await startFakeModel({
    tokensPerSecond: Number(opt['tokens-per-second']),
    seconds: Number(opt['stream-seconds']),
    onStream: events.emit,
  })
  const sha = (() => {
    try {
      return execFileSync('git', ['-C', appDir, 'rev-parse', '--short', 'HEAD'], {
        encoding: 'utf8',
      }).trim()
    } catch {
      return null
    }
  })()
  Object.assign(results, {
    label: opt.label,
    app: appDir,
    sha,
    startedAt: new Date().toISOString(),
    options: opt,
    machine: {
      platform: platform(),
      release: release(),
      cpu: cpus()[0]?.model,
      cores: cpus().length,
      memGB: Math.round(totalmem() / 2 ** 30),
    },
  })
  console.log(`[perf] ${opt.label}: ${appDir} @ ${sha} → ${outDir}`)
  let app = null
  try {
    console.log('[perf] seeding scratch profile…')
    const t0 = Date.now()
    const stores = await loadStores(appDir, scratchDir)
    mkdirSync(join(scratchDir, 'workspace'), { recursive: true })
    const seeded = await seedProfile({
      stores,
      profileDir,
      workspaceDir: join(scratchDir, 'workspace'),
      endpointUrl: model.url,
      runs,
      longTurns: Number(opt['long-turns']),
      appearance: { themeId: opt.theme, mode: opt.theme, wallpaper: opt.wallpaper },
      window: { x: 40, y: 20, width: winW, height: winH, maximized: false },
    })
    console.log(`[perf] seeded ${Object.keys(seeded.ids).length} sessions in ${Date.now() - t0} ms`)
    const startLoad = loadSamples.length
    const logPath = join(outDir, 'app.log')
    const ctx = { desktopDir, scratchName, probe, logPath, scratchDir }

    // 1. Cold start: one discarded warm-up launch, then `runs` measured ones.
    for (let i = 0; i <= runs; i++) {
      await step(`cold start ${i}`, async () => {
        app = await launch(ctx)
        try {
          const b = await waitInteractive(app)
          if (i > 0) {
            if (b.fcp !== null)
              record('coldStart.firstContentfulPaint', b.origin + b.fcp - app.spawnedAt)
            // A late probe only times marks that happened after it arrived.
            const seen = (mark) => !app.lateAttach || mark > b.injectedAt + 50
            if (seen(b.shell)) record('coldStart.shellMounted', b.origin + b.shell - app.spawnedAt)
            if (seen(b.interactive))
              record('coldStart.shellInteractive', b.origin + b.interactive - app.spawnedAt)
            if (app.lateAttach)
              results.errors.push({
                step: `cold start ${i}`,
                message: 'probe attached after the window opened; marks before it were dropped',
              })
          }
          console.log(
            `[perf] cold start ${i === 0 ? '(warm-up)' : i}: interactive at ${Math.round(b.origin + b.interactive - app.spawnedAt)} ms${app.lateAttach ? ' (late probe)' : ''}`,
          )
        } finally {
          await app.kill()
          app = null
        }
      })
      await sleep(1500)
    }

    // 2. Scenarios on one long-lived instance, normal then CPU-throttled.
    app = await launch(ctx)
    await waitInteractive(app)
    await sleep(3000)
    await step('memory idle', () => memory(app, 'memory.idle'))
    const variants = opt['no-throttle'] ? ['normal'] : ['normal', 'throttled']
    for (const variant of variants) {
      const rate = variant === 'throttled' ? Number(opt['throttle-rate']) : 1
      await app.send('Emulation.setCPUThrottlingRate', { rate })
      const p = variant === 'throttled' ? `throttled${rate}x.` : ''
      for (let r = 0; r < runs; r++) {
        const slot = String(variant === 'normal' ? r : runs + r).padStart(2, '0')
        const long = seeded.ids[`long-${slot}`]
        console.log(`[perf] ${variant} run ${r + 1}/${runs}: switching`)
        await step(`${variant} switch ${r}`, async () => {
          await click(app, seeded.ids.short.title)
          await sleep(1500)
          await measureSwitch(app, `${p}switch.shortToLongFirst`, long)
          await measureSwitch(app, `${p}switch.longToShort`, seeded.ids.short)
          await measureSwitch(app, `${p}switch.shortToLongRevisit`, long)
        })
        console.log(`[perf] ${variant} run ${r + 1}/${runs}: streaming`)
        await step(`${variant} stream ${r}`, () =>
          measureStream(app, `${p}stream`, seeded.ids[`strm-${slot}`], { next: events.next }),
        )
      }
    }
    await app.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    await sleep(2000)
    await step('memory after', () => memory(app, 'memory.afterScenarios'))
    results.load = { busyPctDuringRun: summary(loadSamples.slice(startLoad)), samples: loadSamples }
  } finally {
    clearInterval(loadTimer)
    await app?.kill().catch(() => undefined)
    model.close()
    await sleep(1000)
    if (!opt['keep-profile']) {
      rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
      rmSync(scratchDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    }
  }
  for (const [name, { unit, values }] of Object.entries(results.raw))
    results.metrics[name] = { unit, ...summary(values) }
  const fmt = (v) => (v === null ? '–' : Number.isInteger(v) ? String(v) : v.toFixed(1))
  const rows = Object.entries(results.metrics).map(
    ([name, m]) => `| ${name} | ${m.unit} | ${m.n} | ${fmt(m.median)} | ${fmt(m.p95)} |`,
  )
  const load = results.load?.busyPctDuringRun
  const md = [
    `## Ari perf — ${opt.label} (${sha ?? 'unknown sha'})`,
    '',
    `${results.machine.cpu}, ${results.machine.cores} threads, ${results.machine.memGB} GB · machine CPU busy during run: median ${load?.median ?? '?'}% / max ${load?.max ?? '?'}%`,
    '',
    '| metric | unit | n | median | p95 |',
    '| --- | --- | ---: | ---: | ---: |',
    ...rows,
    ...(results.errors.length
      ? ['', '**Errors:**', ...results.errors.map((e) => `- ${e.step}: ${e.message}`)]
      : []),
  ].join('\n')
  writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2))
  writeFileSync(join(outDir, 'summary.md'), md + '\n')
  console.log(`\n${md}\n\n[perf] wrote ${join(outDir, 'results.json')}`)
}

main().catch((error) => {
  console.error(`[perf] fatal: ${error.stack ?? error.message}`)
  process.exitCode = 1
})

import process from 'node:process'
// Standalone Electron harness: never boots Ari or reads its installed profile.
import { app, utilityProcess } from 'electron'
import { mkdir, link, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { execFileSync } from 'node:child_process'
import { missingNativeWords } from './aria-voice-diagnostics.mjs'
const root = resolve('D:/Projects/Ari-aria-voice')
const profile = join(root, '.voice-smoke')
app.setPath('userData', profile)
app.commandLine.appendSwitch('disable-breakpad')
async function smoke() {
  const model = join(profile, 'speech', 'models', 'kokoro-82m-v1.0')
  await mkdir(model, { recursive: true })
  for (const name of ['model.onnx', 'voices.bin', 'tokens.txt', 'lexicon-us-en.txt']) {
    await link(
      join(
        'D:/Projects/Ari-aria-voice-spike/models/kokoro-multi-lang-v1_0/kokoro-multi-lang-v1_0',
        name,
      ),
      join(model, name),
    ).catch((error) => {
      if (error.code !== 'EEXIST') throw error
    })
  }
  await app.whenReady()
  const worker = utilityProcess.fork(
    join(root, 'apps', 'desktop', 'out', 'main', 'voice-worker.js'),
    [],
    { stdio: 'pipe', serviceName: 'Aria voice smoke' },
  )
  let diagnostics = ''
  worker.stderr?.on('data', (data) => {
    diagnostics += data
    process.stderr.write(data)
  })
  worker.stdout?.on('data', (data) => process.stdout.write(data))
  const pending = new Map()
  worker.on('message', (reply) => {
    const item = pending.get(reply.id)
    if (!item) return
    pending.delete(reply.id)
    clearTimeout(item.timer)
    if (reply.error) item.reject(new Error(reply.error))
    else item.resolve(reply)
  })
  function request(data) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(data.id)
        reject(new Error('Utility request timed out'))
      }, 60000)
      pending.set(data.id, { resolve, reject, timer })
      worker.postMessage(data)
    })
  }
  try {
    const loadStart = performance.now()
    const loaded = await request({ id: 1, kind: 'load', path: model })
    const preloadMs = performance.now() - loadStart
    const firstStart = performance.now()
    const audio = await request({
      id: 2,
      kind: 'speak',
      path: model,
      generation: 0,
      text: 'The checks passed,',
      voice: 'af_heart',
      speed: 1,
    })
    const firstAudioMs = performance.now() - firstStart
    if (
      !audio.audio?.samples?.length ||
      audio.audio.samples.some((value) => !Number.isFinite(value))
    )
      throw new Error('Utility returned invalid audio')
    worker.postMessage({ kind: 'cancel', generation: 1 })
    const cancelled = await request({
      id: 3,
      kind: 'speak',
      path: model,
      generation: 0,
      text: 'This stale reply must not be spoken.',
      voice: 'af_heart',
      speed: 1,
    })
    if (!cancelled.cancelled) throw new Error('Utility failed to reject stale speech')
    const names = await request({ id: 4, kind: 'speak', path: model, generation: 1, text: 'Ari, Aria and Codex checked the PR, ACP and CLI. Quuxwidget has 12 updates and the details are in the chat.', voice: 'af_heart', speed: 1 })
    if (!names.audio?.samples.length || !names.spelled.includes('Quuxwidget')) throw new Error('Utility failed to cover unknown words')
    const interrupted = request({ id: 5, kind: 'speak', path: model, generation: 1, text: 'This reply is interrupted while synthesis is still running.', voice: 'af_heart', speed: 1 })
    setTimeout(() => worker.postMessage({ kind: 'cancel', generation: 2 }), 50)
    if (!(await interrupted).cancelled) throw new Error('Utility returned audio after interruption')
    if (missingNativeWords(diagnostics))
      throw new Error('Native engine dropped a word')
    const result = {
      ok: true,
      at: new Date().toISOString(),
      sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      electron: process.versions.electron,
      hardware: loaded.hardware,
      preloadMs,
      firstAudioMs,
      utilityMetrics: app.getAppMetrics().find(metric => metric.pid === worker.pid),
      sampleRate: audio.audio.sampleRate,
      samples: audio.audio.samples.length,
      cancellation: 'passed',
      inFlightCancellation: 'passed',
      nativeWords: 'passed',
      spelled: names.spelled,
    }
    await writeFile(
      join(root, 'docs', 'research', 'aria-voice-measurements', 'utility-smoke.json'),
      JSON.stringify(result, null, 2),
    )
    console.log(JSON.stringify(result))
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    worker.kill()
    app.exit(process.exitCode ?? 0)
  }
}
void smoke().catch((error) => {
  console.error(error)
  app.exit(1)
})

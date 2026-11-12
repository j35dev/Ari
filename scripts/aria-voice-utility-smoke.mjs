import process from 'node:process'
// Standalone Electron harness: never boots Ari or reads its installed profile.
import { app, utilityProcess } from 'electron'
import { mkdir, link, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
const root = resolve('D:/Projects/Ari-aria-voice')
const profile = join(root, '.voice-smoke')
app.setPath('userData', profile)
app.commandLine.appendSwitch('disable-breakpad')
async function smoke() {
const model = join(profile, 'speech', 'models', 'kokoro-82m-v1.0')
await mkdir(model, { recursive: true })
for (const name of ['model.onnx', 'voices.bin', 'tokens.txt', 'lexicon-us-en.txt']) {
  await link(join('D:/Projects/Ari-aria-voice-spike/models/kokoro-multi-lang-v1_0/kokoro-multi-lang-v1_0', name), join(model, name)).catch(error => { if (error.code !== 'EEXIST') throw error })
}
await app.whenReady()
const worker = utilityProcess.fork(join(root, 'apps', 'desktop', 'out', 'main', 'voice-worker.js'), [], { stdio: 'pipe', serviceName: 'Aria voice smoke' })
let diagnostics = ''
worker.stderr?.on('data', data => { diagnostics += data; process.stderr.write(data) })
worker.stdout?.on('data', data => process.stdout.write(data))
const pending = new Map()
worker.on('message', reply => {
  const item = pending.get(reply.id)
  if (!item) return
  pending.delete(reply.id); clearTimeout(item.timer)
  if (reply.error) item.reject(new Error(reply.error)); else item.resolve(reply)
})
function request(data) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(data.id); reject(new Error('Utility request timed out')) }, 60000)
    pending.set(data.id, { resolve, reject, timer }); worker.postMessage(data)
  })
}
try {
  const loaded = await request({ id: 1, kind: 'load', path: model })
  const audio = await request({ id: 2, kind: 'speak', path: model, generation: 0, text: 'Ari, Aria and Codex are ready.', voice: 'af_heart', speed: 1 })
  if (!audio.audio?.samples?.length || audio.audio.samples.some(value => !Number.isFinite(value))) throw new Error('Utility returned invalid audio')
  worker.postMessage({ kind: 'cancel', generation: 1 })
  const cancelled = await request({ id: 3, kind: 'speak', path: model, generation: 0, text: 'This stale reply must not be spoken.', voice: 'af_heart', speed: 1 })
  if (!cancelled.cancelled) throw new Error('Utility failed to reject stale speech')
  if (/skip(?:ped|ping)?[^\n]*word|word[^\n]*(?:not found|missing)/i.test(diagnostics)) throw new Error('Native engine dropped a word')
  const result = { ok: true, hardware: loaded.hardware, sampleRate: audio.audio.sampleRate, samples: audio.audio.samples.length, cancellation: 'passed', nativeWords: 'passed' }
  await writeFile(join(root, 'docs', 'research', 'aria-voice-measurements', 'utility-smoke.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
} catch (error) {
  console.error(error); process.exitCode = 1
} finally {
  worker.kill(); app.exit(process.exitCode ?? 0)
}

}
void smoke().catch(error => { console.error(error); app.exit(1) })

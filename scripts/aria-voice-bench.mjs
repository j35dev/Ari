import { URL } from 'node:url'
import { performance } from 'node:perf_hooks'
// Run only through scripts/coordination/run-heavy.mjs on this shared PC.
// Sources are imported directly so the audition exercises production text preparation.
import { createRequire } from 'node:module'
import { readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { cpus, totalmem, setPriority, constants } from 'node:os'
import { condenseReply, speechChunks } from '../packages/contracts/src/aria-voice.ts'
import {
  ARIA_LEXICON,
  lexiconWords,
  prepareKokoro,
} from '../apps/desktop/src/main/speech/pronunciation.ts'
import { pcmWav } from '../apps/desktop/src/main/speech/groq.ts'
import { KOKORO_FILES } from '../apps/desktop/src/main/speech/voice-model.ts'

const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url))
const sherpa = require('sherpa-onnx-node')
const threads = Number(process.argv[2] ?? 4)
const provider = process.argv[3] ?? 'cpu'
const model =
  'D:/Projects/Ari-aria-voice-spike/models/kokoro-multi-lang-v1_0/kokoro-multi-lang-v1_0'
const out = 'D:/Projects/Ari-aria-voice-spike/samples-v2'
const reportDir = new URL('../docs/research/aria-voice-measurements/', import.meta.url)
await mkdir(out, { recursive: true })
await mkdir(reportDir, { recursive: true })
setPriority(process.pid, constants.priority.PRIORITY_BELOW_NORMAL)
const files = []
for (const file of KOKORO_FILES) {
  const data = await readFile(join(model, file.name))
  const sha256 = createHash('sha256').update(data).digest('hex')
  if (sha256 !== file.sha256)
    throw new Error(`Spike ${file.name} differs from pinned download: ${sha256}`)
  files.push({ ...file })
}
const lexicon = await readFile(join(model, 'lexicon-us-en.txt'), 'utf8')
const extra = Object.entries(ARIA_LEXICON)
  .map(([word, phonemes]) => `${word} ${phonemes}`)
  .join('\n')
const lexiconPath = join(out, 'aria-lexicon.txt')
await writeFile(lexiconPath, extra + '\n' + lexicon)
const words = lexiconWords(extra + '\n' + lexicon)
const runtime = join(
  new URL('../apps/desktop/node_modules/sherpa-onnx-win-x64/', import.meta.url).pathname.replace(
    /^\//,
    '',
  ),
)
const runtimeFiles = await readdir(runtime)
let runtimeBytes = 0
for (const name of runtimeFiles) runtimeBytes += (await stat(join(runtime, name))).size
const onnx = await readFile(join(runtime, 'onnxruntime.dll'))
const directML = onnx.includes(Buffer.from('OrtSessionOptionsAppendExecutionProvider_DML'))
const result = {
  at: new Date().toISOString(),
  sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  cpu: cpus()[0].model,
  cores: cpus().length,
  ramGB: totalmem() / 2 ** 30,
  threads,
  provider,
  runtimeBytes,
  downloadBytes: files.reduce((n, f) => n + f.size, 0),
  directML,
  files,
  replies: [],
}
// Probe dml even on a CPU-only build: report an explicit unsupported result rather than CPU timings labelled GPU.
if (provider === 'dml' && !directML) {
  result.unavailable =
    'The shipped sherpa-onnx 2.0.1 Windows runtime has no DirectML execution-provider entry point.'
  await writeFile(new URL(`dml-t${threads}.json`, reportDir), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
  process.exit(0)
}
const loadStart = performance.now()
const tts = await sherpa.OfflineTts.createAsync({
  model: {
    kokoro: {
      model: join(model, 'model.onnx'),
      voices: join(model, 'voices.bin'),
      tokens: join(model, 'tokens.txt'),
      lexicon: lexiconPath,
    },
    numThreads: threads,
    provider,
    debug: 0,
  },
  maxNumSentences: 1,
})
result.loadMs = performance.now() - loadStart
result.rssAfterLoadMB = process.memoryUsage().rss / 2 ** 20
const warmStart = performance.now()
await tts.generateAsync({
  text: 'The voice is ready.',
  sid: 3,
  speed: 1,
  enableExternalBuffer: false,
})
result.warmupMs = performance.now() - warmStart
const replies = {
  ready:
    '<!-- aria:speak {"text":"The checks passed, and the changes are ready for your review."} -->\nAll 28 tests passed. The code and table are below.',
  question:
    '<!-- aria:speak {"text":"Codex finished the pairing screen. Would you like Pi to handle the mobile polish?"} -->\n| Agent | State |\n|---|---|\n|Codex|Done|\n```ts\nconst status = 42\n```',
  fallback:
    'Ari Connect is the only project that needs you.\n\n| Project | State |\n|---|---|\n| Ari Connect | waiting |\n\n```ari-viz\n{"version":1}\n```\nShould I run the checks?',
  names:
    '<!-- aria:speak {"text":"Ari, Aria, Claude Code, Codex, Grok, OpenCode and Pi are ready. The PR and CLI checks passed."} -->',
  unknown: '<!-- aria:speak {"text":"Quuxwidget has twelve updates. The ACP checks passed."} -->',
}
for (const [name, written] of Object.entries(replies)) {
  const spoken = condenseReply(written)
  const chunks = speechChunks(spoken)
  const pieces = []
  const measurements = []
  let firstMs
  const cpu0 = process.cpuUsage()
  const start = performance.now()
  for (const chunk of chunks) {
    const prepared = prepareKokoro(chunk, words)
    for (const word of prepared.text.match(/[a-z]+(?:'[a-z]+)?/g) ?? [])
      if (!words.has(word)) throw new Error(`Dropped word: ${word}`)
    const genStart = performance.now()
    const audio = await tts.generateAsync({
      text: prepared.text,
      sid: 3,
      speed: 1,
      enableExternalBuffer: false,
    })
    if (!audio.samples.length || audio.samples.some((x) => !Number.isFinite(x)))
      throw new Error('Invalid PCM')
    firstMs ??= performance.now() - start
    measurements.push({
      text: chunk,
      prepared: prepared.text,
      spelled: prepared.spelled,
      genMs: performance.now() - genStart,
      audioMs: (audio.samples.length / audio.sampleRate) * 1000,
    })
    pieces.push(audio.samples)
  }
  const wallMs = performance.now() - start
  const cpu = process.cpuUsage(cpu0)
  const samples = new Float32Array(pieces.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const piece of pieces) {
    samples.set(piece, offset)
    offset += piece.length
  }
  if (threads === 4) await writeFile(join(out, `${name}.wav`), pcmWav(samples, tts.sampleRate))
  const audioMs = measurements.reduce((n, m) => n + m.audioMs, 0)
  let peak = 0
  let squared = 0
  for (const sample of samples) {
    peak = Math.max(peak, Math.abs(sample))
    squared += sample * sample
  }
  if (peak < 0.0001) throw new Error('Kokoro returned silent PCM')
  result.replies.push({
    name,
    written,
    spoken,
    firstAudioMs: firstMs,
    wallMs,
    audioMs,
    rtf: wallMs / audioMs,
    avgCoresBusy: (cpu.user + cpu.system) / 1000 / wallMs,
    rssMB: process.memoryUsage().rss / 2 ** 20,
    peak,
    rms: Math.sqrt(squared / samples.length),
    chunks: measurements,
  })
}
result.peakRssMB = process.resourceUsage().maxRSS / 1024
await writeFile(new URL(`${provider}-t${threads}.json`, reportDir), JSON.stringify(result, null, 2))
if (threads === 4) {
  const rows = result.replies
    .map(
      (reply) =>
        `<article><h2>${reply.name}</h2><p>${reply.spoken}</p><audio controls src="${reply.name}.wav"></audio><p>First audio ${Math.round(reply.firstAudioMs)} ms; RTF ${reply.rtf.toFixed(2)}</p></article>`,
    )
    .join('\n')
  await writeFile(
    join(out, 'index.html'),
    `<!doctype html><html><meta charset="utf-8"><title>Aria Kokoro short replies</title><style>body{font:18px system-ui;max-width:850px;margin:40px auto;padding:20px;background:#151719;color:#eee}article{padding:20px 0;border-bottom:1px solid #444}audio{width:100%}</style><h1>Aria · Kokoro short replies</h1><p>Measured on this PC. Audio quality was not judged by the agent.</p>${rows}</html>`,
  )
}
console.log(
  JSON.stringify(
    {
      threads,
      provider,
      loadMs: result.loadMs,
      peakRssMB: result.peakRssMB,
      runtimeBytes,
      downloadBytes: result.downloadBytes,
      directML,
      replies: result.replies.map(({ name, firstAudioMs, rtf, avgCoresBusy }) => ({
        name,
        firstAudioMs,
        rtf,
        avgCoresBusy,
      })),
    },
    null,
    2,
  ),
)

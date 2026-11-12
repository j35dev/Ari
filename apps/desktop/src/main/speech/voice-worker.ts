import { readFile, writeFile } from 'node:fs/promises'
import { cpus, totalmem, setPriority, constants } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { ARIA_LEXICON, lexiconWords, prepareKokoro } from './pronunciation'
import { KOKORO_FILES } from './voice-model'
import { acceleratedVoiceProvider, fasterVoiceProvider } from './voice-provider'
import { verifyDownload } from './download'

interface Tts {
  generateAsync(request: {
    text: string
    sid: number
    speed: number
    onProgress?: () => number
  }): Promise<{ samples: Float32Array; sampleRate: number }>
}
interface Sherpa {
  OfflineTts: { createAsync(config: unknown): Promise<Tts> }
}
interface Request {
  id: number
  kind: 'load' | 'speak' | 'cancel'
  path?: string
  text?: string
  voice?: string
  speed?: number
  generation?: number
}
interface Hardware {
  threads: number
  ramGB: number
  logicalCores: number
  provider: string
  rtf: number
  firstAudioMs: number
  slow: boolean
}
let tts: Tts | null = null
let loadedPath: string | null = null
let words: Set<string> = new Set()
let hardware: Hardware | null = null
let generation = 0
let queue = Promise.resolve()
try {
  setPriority(process.pid, constants.priority.PRIORITY_BELOW_NORMAL)
} catch {
  /* The OS may deny a priority change. */
}
const require = createRequire(import.meta.url)

async function load(path: string): Promise<void> {
  if (tts && loadedPath === path) return
  // The manager already checks downloads. Verify once per utility lifetime before native code reads them.
  for (const file of KOKORO_FILES) await verifyDownload(join(path, file.name), file.sha256)
  const lexicon = await readFile(join(path, 'lexicon-us-en.txt'), 'utf8')
  const extra = Object.entries(ARIA_LEXICON)
    .map(([word, phonemes]) => `${word} ${phonemes}`)
    .join('\n')
  const lexiconPath = join(path, 'aria-lexicon.txt')
  await writeFile(lexiconPath, extra + '\n' + lexicon)
  words = lexiconWords(extra + '\n' + lexicon)
  const logicalCores = cpus().length
  const threads = Math.max(1, Math.min(4, Math.floor(logicalCores / 2)))
  const signature = `${cpus()[0]?.model}:${logicalCores}:${totalmem()}:kokoro-2.0.1`
  const cached = await readFile(join(path, 'hardware.json'), 'utf8')
    .then((s) => JSON.parse(s) as { signature: string; hardware: Hardware })
    .catch(() => null)
  const sherpa = require('sherpa-onnx-node') as Sherpa
  // Published 2.0.1 binaries are CPU builds. Only offer a provider if its native entry point exists.
  // No acceleration is claimed merely because the machine has a GPU or NPU.
  let provider: string = 'cpu'
  const accelerator = await acceleratedVoiceProvider()
  if (cached?.signature === signature && cached.hardware.provider === accelerator)
    provider = accelerator ?? 'cpu'
  const create = (selected: string) =>
    sherpa.OfflineTts.createAsync({
      model: {
        kokoro: {
          model: join(path, 'model.onnx'),
          voices: join(path, 'voices.bin'),
          tokens: join(path, 'tokens.txt'),
          lexicon: lexiconPath,
        },
        numThreads: threads,
        provider: selected,
        debug: 0,
      },
      maxNumSentences: 1,
    })
  tts = await create(provider)
  loadedPath = path
  const start = performance.now()
  let audio = await tts.generateAsync({
    text: prepareKokoro('The changes are ready for you to review.', words).text,
    sid: 3,
    speed: 1,
  })
  let measuredMs = performance.now() - start
  if (accelerator && cached?.signature !== signature) {
    try {
      const candidate = await create(accelerator)
      await candidate.generateAsync({ text: 'The voice is ready.', sid: 3, speed: 1 })
      const trial = performance.now()
      const candidateAudio = await candidate.generateAsync({
        text: 'The changes are ready for you to review.',
        sid: 3,
        speed: 1,
      })
      const candidateMs = performance.now() - trial
      if (fasterVoiceProvider(measuredMs, candidateMs)) {
        tts = candidate
        provider = accelerator
        measuredMs = candidateMs
        audio = candidateAudio
      }
    } catch {
      /* A provider may be compiled in but unavailable on this hardware. Keep CPU. */
    }
  }
  if (cached?.signature === signature) hardware = cached.hardware
  else {
    const firstAudioMs = measuredMs
    const rtf = firstAudioMs / ((audio.samples.length / audio.sampleRate) * 1000)
    hardware = {
      threads,
      ramGB: Math.round(totalmem() / 2 ** 30),
      logicalCores,
      provider,
      rtf,
      firstAudioMs,
      slow: rtf >= 1,
    }
    await writeFile(join(path, 'hardware.json'), JSON.stringify({ signature, hardware }))
  }
}

process.parentPort?.on('message', (event: { data: Request }) => {
  const request = event.data
  if (request.kind === 'cancel') {
    generation = request.generation!
    return
  }
  queue = queue.then(async () => {
    try {
      await load(request.path!)
      if (request.kind === 'load') {
        process.parentPort?.postMessage({ id: request.id, hardware })
        return
      }
      if (request.generation !== generation) {
        process.parentPort?.postMessage({ id: request.id, cancelled: true })
        return
      }
      if (hardware?.slow)
        throw new Error(
          'Kokoro is slower than real time on this computer. Choose Groq in Aria settings for smooth speech.',
        )
      const prepared = prepareKokoro(request.text!, words)
      const audio = await tts!.generateAsync({
        text: prepared.text,
        sid: request.voice === 'am_michael' ? 16 : 3,
        speed: request.speed ?? 1,
        onProgress: () => (request.generation === generation ? 1 : 0),
      })
      process.parentPort?.postMessage(
        request.generation === generation
          ? { id: request.id, audio, spelled: prepared.spelled }
          : { id: request.id, cancelled: true },
      )
    } catch (error) {
      process.parentPort?.postMessage({
        id: request.id,
        error: error instanceof Error ? error.message : 'Local speech failed.',
      })
    }
  })
})

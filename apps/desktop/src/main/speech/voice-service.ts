import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { utilityProcess, type UtilityProcess, type WebContents } from 'electron'
import type { SettingsStore } from '@ari/engine/settings'
import type { RpcResults, SpeechProgress } from '@ari/contracts/rpc'
import { condenseReply, readableReply, speechChunks, spokenReply } from '@ari/contracts/aria-voice'
import { getAudioDucking } from './audio-ducking'
import { type SpeechService } from './service'
import { KOKORO_ID } from './voice-model'
import { GROQ_SPEECH_LIMIT, type GroqSpeech, pcmWav, withLocalFallback } from './groq'
import { normalizeCloudSpeech } from './pronunciation'

type Status = RpcResults['aria.voice.status']
type Reply = {
  id: number
  error?: string
  cancelled?: boolean
  hardware?: Status['hardware']
  audio?: { samples: Float32Array; sampleRate: number }
}

/** Replacement, cancellation and playback acknowledgments are generation-scoped. */
export class VoiceService {
  private worker: UtilityProcess | null = null
  private pending = new Map<
    number,
    {
      resolve: (reply: Reply) => void
      reject: (error: Error) => void
      timeout: ReturnType<typeof setTimeout>
    }
  >()
  private nextId = 0
  private generation = 0
  private abort = new AbortController()
  private idle: ReturnType<typeof setTimeout> | undefined
  /** Settles when all audio queued so far has been sent to the player. */
  private tail: Promise<void> = Promise.resolve()
  private loading: Promise<void> | null = null
  private owner = randomUUID()
  private state: Status = { installed: false, loaded: false, error: null, hardware: null }
  private playback = new Map<
    number,
    {
      finished: Promise<string | undefined>
      resolve: (error?: string) => void
      timeout: ReturnType<typeof setTimeout>
    }
  >()
  publish: (frame: SpeechProgress) => void = () => undefined
  constructor(
    private readonly settings: SettingsStore,
    private readonly models: SpeechService,
    private readonly groq: GroqSpeech,
    private readonly contents: WebContents,
  ) {
    contents.on('render-process-gone', () => this.stop())
    contents.on('did-navigate', () => this.stop())
  }
  private enabled(): boolean {
    return this.settings.current.experimental.ariaEnabled
  }
  async status(): Promise<Status> {
    const model = (await this.models.models(false)).find((m) => m.id === KOKORO_ID)
    this.state.installed = Boolean(model?.installed)
    return { ...this.state }
  }
  private report(message: string): void {
    this.state.error = message
    this.publish({ id: 'aria-voice', phase: 'error', received: 0, total: 0, error: message })
  }
  private async request(
    kind: 'load' | 'speak',
    text?: string,
    signal?: AbortSignal,
  ): Promise<Reply> {
    if (!this.enabled()) throw new Error('Aria is off.')
    const model = (await this.models.models(false)).find((m) => m.id === KOKORO_ID)
    signal?.throwIfAborted()
    if (!model?.installed)
      throw new Error('Download Kokoro in Settings → Experimental → Aria to use local speech.')
    if (!this.worker) {
      const worker = utilityProcess.fork(join(import.meta.dirname, 'voice-worker.js'), [], {
        stdio: 'ignore',
        serviceName: 'Aria voice',
      })
      this.worker = worker
      worker.postMessage({ kind: 'cancel', generation: this.generation })
      worker.on('message', (reply: Reply) => {
        const pending = this.pending.get(reply.id)
        if (!pending || this.worker !== worker) return
        this.pending.delete(reply.id)
        clearTimeout(pending.timeout)
        if (reply.error) pending.reject(new Error(reply.error))
        else pending.resolve(reply)
      })
      worker.once('exit', () => {
        if (this.worker === worker) this.unload('The local voice stopped. Try Read aloud again.')
      })
    }
    const path = model.installed.path
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => this.unload('Local speech timed out. Choose Groq for faster speech.'),
        60_000,
      )
      this.pending.set(id, { resolve, reject, timeout })
      try {
        this.worker!.postMessage({
          id,
          kind,
          path,
          text,
          generation: this.generation,
          voice: this.settings.current.ariaVoice.kokoroVoice,
          speed: this.settings.current.ariaVoice.speed,
        })
      } catch {
        this.unload('Local speech could not start.')
      }
    })
  }
  warm(): Promise<void> {
    if (!this.enabled()) return Promise.resolve()
    clearTimeout(this.idle)
    this.loading ??= this.request('load')
      .then((reply) => {
        this.state.loaded = true
        this.state.hardware = reply.hardware ?? null
        this.state.error = reply.hardware?.slow
          ? 'Kokoro is slower than real time here. Choose Groq for smooth speech.'
          : null
      })
      .catch((error) => {
        this.report(error instanceof Error ? error.message : 'Local voice unavailable.')
      })
      .finally(() => {
        this.loading = null
        this.scheduleIdle()
      })
    return this.loading
  }
  private scheduleIdle(): void {
    clearTimeout(this.idle)
    this.idle = setTimeout(() => this.unload(), 5 * 60_000)
    this.idle.unref()
  }
  stop(): void {
    this.generation++
    this.abort.abort()
    this.abort = new AbortController()
    this.tail = Promise.resolve()
    this.worker?.postMessage({ kind: 'cancel', generation: this.generation })
    if (!this.contents.isDestroyed())
      this.contents.send('ari:ariaVoice.audio', { generation: this.generation, stop: true })
    for (const entry of this.playback.values()) {
      clearTimeout(entry.timeout)
      entry.resolve()
    }
    this.playback.clear()
    this.state.error = null
    this.publish({ id: 'aria-voice', phase: 'cancelled', received: 0, total: 0 })
    getAudioDucking().setActive(this.owner, false)
    this.scheduleIdle()
  }
  played(id: number, generation: number, error?: string): void {
    if (generation !== this.generation) return
    this.finishPlayback(id, error ? 'Speech playback failed. Try Read aloud again.' : undefined)
  }
  private finishPlayback(id: number, error?: string): void {
    const pending = this.playback.get(id)
    if (!pending) return
    this.playback.delete(id)
    clearTimeout(pending.timeout)
    pending.resolve(error)
    if (!this.playback.size) getAudioDucking().setActive(this.owner, false)
  }
  private play(audio: Uint8Array, generation: number): Promise<string | undefined> {
    if (generation !== this.generation || this.contents.isDestroyed())
      throw new Error('Speech interrupted.')
    const id = ++this.nextId
    let resolve!: (error?: string) => void
    const finished = new Promise<string | undefined>((done) => {
      resolve = done
    })
    const timeout = setTimeout(() => this.finishPlayback(id, 'Speech playback timed out.'), 90_000)
    if (!this.playback.size)
      getAudioDucking().setActive(this.owner, this.settings.current.speech.duckAudio)
    this.playback.set(id, { finished, resolve, timeout })
    try {
      this.contents.send('ari:ariaVoice.audio', {
        id,
        generation,
        audio,
        volume: this.settings.current.ariaVoice.volume,
      })
    } catch {
      this.finishPlayback(id, 'Speech playback failed. Try Read aloud again.')
    }
    return finished
  }
  /**
   * Says a reply. On its own it replaces whatever is being said. With
   * `follow` it queues after the previous passage and can render while it plays.
   */
  speak(reply: string, options: { readAll?: boolean; follow?: boolean } = {}): Promise<void> {
    if (!options.follow) this.stop()
    if (!this.enabled()) return Promise.resolve()
    const generation = this.generation
    const signal = this.abort.signal
    const playback: Promise<string | undefined>[] = []
    const submitted = this.tail.then(() =>
      this.queueReply(reply, options, generation, signal, playback),
    )
    this.tail = submitted.catch(() => undefined)
    return submitted
      .catch((error: unknown) => (error instanceof Error ? error.message : 'Speech failed.'))
      .then(async (error) => {
        const results = await Promise.all(playback)
        if (signal.aborted) return
        const failure = error ?? results.find((result) => result !== undefined)
        if (failure) this.report(failure)
        else if (playback.length)
          this.publish({ id: 'aria-voice', phase: 'complete', received: 0, total: 0 })
        this.scheduleIdle()
      })
  }
  private async queueReply(
    reply: string,
    options: { readAll?: boolean },
    generation: number,
    signal: AbortSignal,
    playback: Promise<string | undefined>[],
  ): Promise<void> {
    signal.throwIfAborted()
    const authored = options.readAll ? null : spokenReply(reply)
    const text = options.readAll ? readableReply(reply) : (authored?.text ?? condenseReply(reply))
    let engine = this.settings.current.ariaVoice.engine
    let chunks: string[]
    try {
      chunks = speechChunks(
        text,
        engine === 'groq' ? GROQ_SPEECH_LIMIT : undefined,
        engine === 'groq' ? (part) => normalizeCloudSpeech(part).length : undefined,
      )
    } catch {
      throw new Error('This spoken line is too long. Shorten it and try Read aloud again.')
    }
    if (!chunks.length) return
    this.state.error = null
    const synthesize = async (text: string, index: number): Promise<Uint8Array> => {
      signal.throwIfAborted()
      const local = async () => {
        await this.warm()
        const result = await this.request('speak', text, signal)
        if (!result.audio || result.cancelled) throw new Error('Speech interrupted.')
        return pcmWav(result.audio.samples, result.audio.sampleRate)
      }
      if (engine === 'kokoro') return local()
      const normalized = normalizeCloudSpeech(text)
      const tone = index === 0 ? authored?.tone : undefined
      const directed = tone ? `[${tone}] ${normalized}` : normalized
      return withLocalFallback(
        () =>
          this.groq.speak(
            directed.length <= GROQ_SPEECH_LIMIT ? directed : normalized,
            this.settings.current.ariaVoice.groqVoice,
            signal,
          ),
        local,
        (message) => {
          engine = 'kokoro'
          this.report(message)
        },
        signal,
      )
    }
    for (const [index, text] of chunks.entries()) {
      const audio = await synthesize(text, index)
      signal.throwIfAborted()
      // Keep a playing clip and its successor in the renderer, plus at most one synthesized clip here.
      if (this.playback.size >= 2) await this.playback.values().next().value?.finished
      signal.throwIfAborted()
      playback.push(this.play(audio, generation))
    }
  }
  configure(): void {
    if (!this.enabled()) {
      this.stop()
      this.unload()
    } else this.stop()
  }
  unload(message = 'Local voice unloaded.'): void {
    clearTimeout(this.idle)
    const worker = this.worker
    this.worker = null
    worker?.kill()
    this.state.loaded = false
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(new Error(message))
    }
    this.pending.clear()
  }
  dispose(): void {
    this.stop()
    this.unload()
  }
}

import { stat, rm, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { utilityProcess, type UtilityProcess } from 'electron'
import type { SettingsStore } from '@ari/engine/settings'
import { MAC_SPEECH_SHORTCUT } from '@ari/contracts/settings'
import type { SpeechModel, SpeechProgress, SpeechStatus } from '@ari/contracts/rpc'
import { catalog, discoverModels, modelRoots } from './discovery'
import { downloadFile, prunePartialDownloads, PARTIAL_DOWNLOAD_MAX_AGE } from './download'
import { ENGINE_VERSION, verifyInstalledEngine, installEngine, EngineIoError } from './engine'
import { WINDOWS_SPEECH_RUNTIME_HINT } from './runtime-hint'

export function speechRequestTimeout(kind: string, samples = 0, modelSize = 0): number {
  if (kind !== 'transcribe') return 15 * 60_000
  // CPU-only machines can take many times the recording length on larger models.
  const factor = modelSize >= 1_000_000_000 ? 60 : 30
  return 10 * 60_000 + (samples / 16_000) * factor * 1000
}

export function speechWorkerExitError(
  platform: string,
  code: number,
  hasLoaded: boolean,
  knownCause: boolean,
): string {
  const message = 'The speech engine stopped. Please retry.'
  return platform === 'win32' && code !== 0 && !knownCause && !hasLoaded
    ? `${message} ${WINDOWS_SPEECH_RUNTIME_HINT}`
    : message
}

export class SpeechService {
  readonly #root: string
  readonly #settings: SettingsStore
  #engine: SpeechStatus['engine'] = 'missing'
  #library: string | null = null
  #initialized: Promise<void> | null = null
  #engineQueue: Promise<void> = Promise.resolve()
  #checkQueued = false
  #installQueued = false
  #nextCheckAt = 0
  #retryAt = 0
  #retryTimer: ReturnType<typeof setTimeout> | undefined
  #verifiedForSpawnAt = 0
  #verifiedStamp: string | null = null
  #installFailed = false
  #refreshing: Promise<void> | null = null
  #refreshAgain = false
  #publishedStatus = ''
  #model: SpeechModel | null = null
  #disposed = false
  #engineError: string | null = null
  #reinstallRequired = false
  #workerStarting: Promise<UtilityProcess> | null = null
  #error: string | null = null
  #validated: string | null = null
  #configurationVersion = 0
  #preparing: Promise<void> | null = null
  #worker: UtilityProcess | null = null
  #nextId = 0
  #pending = new Map<
    number,
    {
      resolve: (result: { text: string }) => void
      reject: (error: Error) => void
      worker: UtilityProcess
      kind: 'load' | 'transcribe' | 'unload'
      budget: number
      timeout?: ReturnType<typeof setTimeout>
    }
  >()
  #downloads = new Map<string, { controller: AbortController; done: Promise<void> }>()
  #workerState = new WeakMap<
    UtilityProcess,
    { hasLoaded: boolean; knownCause: boolean; stopping: boolean }
  >()
  #progress = new Map<string, SpeechProgress>()
  #models: { at: number; value: SpeechModel[] } | null = null
  publish: (frame: SpeechProgress) => void = () => undefined

  constructor(userData: string, settings: SettingsStore) {
    this.#root = join(userData, 'speech')
    this.#settings = settings
  }

  snapshot(): SpeechProgress[] {
    return [...this.#progress.values()]
  }

  #emit(frame: SpeechProgress): void {
    this.#progress.set(frame.id, frame)
    this.publish(frame)
  }

  #publishStatus(): void {
    if (this.#disposed) return
    const status = this.#currentStatus()
    const key = JSON.stringify(status)
    if (key === this.#publishedStatus) return
    this.#publishedStatus = key
    this.#emit({
      id: 'configuration',
      phase: status.error ? 'error' : 'complete',
      received: 0,
      total: 0,
      ...(status.error ? { error: status.error } : {}),
      status,
    })
  }

  async #init(): Promise<void> {
    this.#initialized ??= (async () => {
      await this.#settings.load()
      if (!this.#settings.current.speech.shortcut)
        await this.#settings.update({
          speech: {
            shortcut: process.platform === 'darwin' ? MAC_SPEECH_SHORTCUT : 'ctrl+space',
          },
        })
      this.#scheduleCheck(true)
    })().catch((error: unknown) => {
      this.#initialized = null
      throw error
    })
    return this.#initialized
  }

  #queueEngine<T>(run: () => Promise<T>): Promise<T> {
    const result = this.#engineQueue.then(() => {
      if (this.#disposed) throw new Error('Speech service stopped.')
      return run()
    })
    this.#engineQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  #scheduleCheck(prune = false): void {
    if (
      this.#disposed ||
      this.#checkQueued ||
      this.#installQueued ||
      this.#installFailed ||
      Date.now() < this.#nextCheckAt
    )
      return
    this.#checkQueued = true
    void this.#queueEngine(async () => {
      if (prune)
        await prunePartialDownloads(
          join(this.#root, 'engine'),
          new Set(),
          PARTIAL_DOWNLOAD_MAX_AGE,
          '.partial',
        )
      await this.#inspectEngine(false)
    })
      .catch(() => undefined)
      .finally(() => {
        this.#checkQueued = false
        this.#refreshStatus()
        if (this.#retryAt) this.#scheduleRetry()
      })
  }

  #scheduleRetry(): void {
    if (this.#disposed || this.#installFailed || this.#retryTimer) return
    this.#retryTimer = setTimeout(
      () => {
        this.#retryTimer = undefined
        if (!this.#checkQueued && !this.#installQueued) this.#scheduleCheck()
      },
      Math.max(10, this.#retryAt - Date.now()),
    )
    this.#retryTimer.unref()
  }

  #refreshStatus(): void {
    if (this.#disposed) return
    if (this.#refreshing) {
      this.#refreshAgain = true
      return
    }
    this.#refreshing = this.#init()
      .then(async () => {
        this.#scheduleCheck()
        const model = await this.#selected()
        if (
          this.#engine === 'ready' &&
          this.#settings.current.speech.enabled &&
          model?.installed &&
          model.installed.path === this.#settings.current.speech.modelPath &&
          this.#validated !== model.installed.path &&
          !this.#preparing &&
          !this.#error &&
          Date.now() >= this.#retryAt
        ) {
          void this.#prepare(model).catch(() => undefined)
        }
      })
      .catch((error: unknown) => {
        if (!this.#disposed && !(error instanceof EngineIoError))
          console.warn('Could not refresh speech configuration:', error)
      })
      .finally(() => {
        this.#refreshing = null
        this.#publishStatus()
        if (this.#refreshAgain) {
          this.#refreshAgain = false
          this.#refreshStatus()
        }
      })
  }

  async #inspectEngine(full: boolean): Promise<void> {
    if (this.#installFailed) return
    let library: string | null
    let stamp: string | null = null
    try {
      library = await verifyInstalledEngine(
        join(this.#root, 'engine', ENGINE_VERSION),
        full,
        undefined,
        (value) => {
          stamp = value
        },
      )
    } catch (error) {
      if (this.#disposed) throw error
      this.#engineError = error instanceof Error ? error.message : String(error)
      this.#nextCheckAt = Date.now() + 500
      this.#retryAt = error instanceof EngineIoError ? this.#nextCheckAt : 0
      this.#verifiedForSpawnAt = 0
      this.#publishStatus()
      if (this.#retryAt) this.#scheduleRetry()
      throw error
    }
    if (this.#disposed) return
    this.#nextCheckAt = Date.now() + 1000
    this.#retryAt = 0
    clearTimeout(this.#retryTimer)
    this.#retryTimer = undefined
    this.#engineError = null
    if (library) {
      if (full) this.#reinstallRequired = false
      if (this.#reinstallRequired) {
        this.#publishStatus()
        return
      }
      this.#library = library
      this.#engine = 'ready'
      if (full) {
        this.#verifiedForSpawnAt = Date.now()
        this.#verifiedStamp = stamp
      } else if (stamp !== this.#verifiedStamp) {
        this.#verifiedForSpawnAt = 0
      }
    } else {
      const wasInstalled = this.#library !== null
      if (full || wasInstalled) this.#reinstallRequired = true
      this.#library = null
      this.#verifiedForSpawnAt = 0
      this.#engine = 'missing'
      this.#validated = null
      this.#publishStatus()
      if (this.#worker) await this.#stopWorkerAndWait(this.#worker)
      if (wasInstalled) {
        this.#error = 'The speech engine is missing or changed. Download it again.'
      }
    }
    this.#publishStatus()
  }

  async models(refresh = true): Promise<SpeechModel[]> {
    if (!refresh && this.#models && Date.now() - this.#models.at < 10_000) return this.#models.value
    await prunePartialDownloads(
      join(this.#root, 'models'),
      new Set(
        catalog
          .filter((model) => this.#downloads.has(model.id))
          .map((model) => `${model.filename}.partial`),
      ),
    )
    const value = await discoverModels(await modelRoots(join(this.#root, 'models')))
    this.#models = { at: Date.now(), value }
    return value
  }

  async #selected(): Promise<SpeechModel | null> {
    const { modelPath, modelId } = this.#settings.current.speech
    if (!modelPath) {
      this.#model = null
      this.#publishStatus()
      return null
    }
    const known = (await this.models(false)).find(
      (entry) => entry.installed && entry.installed.path === modelPath,
    )
    if (known) {
      if (this.#settings.current.speech.modelPath === modelPath) this.#model = known
      this.#publishStatus()
      return known
    }
    const file = await stat(modelPath).catch(() => null)
    if (!file?.isFile() || !modelPath.toLowerCase().endsWith('.gguf') || !file.size) {
      if (this.#settings.current.speech.modelPath === modelPath) this.#model = null
      this.#publishStatus()
      return null
    }
    const model: SpeechModel = {
      id: modelId ?? `local:${modelPath}`,
      name: basename(modelPath),
      filename: basename(modelPath),
      description: 'Local GGUF model',
      size: file.size,
      languages: [],
      sha256: null,
      repository: null,
      revision: null,
      installed: { path: modelPath, source: 'other' },
    }
    if (this.#settings.current.speech.modelPath === modelPath) this.#model = model
    this.#publishStatus()
    return model
  }

  status(): SpeechStatus {
    this.#refreshStatus()
    this.#publishStatus()
    return this.#currentStatus()
  }

  #currentStatus(): SpeechStatus {
    const model = this.#model
    return {
      engine: this.#engine,
      model,
      ready:
        this.#settings.current.speech.enabled &&
        Boolean(
          model?.installed &&
          this.#validated === model.installed.path &&
          model.installed.path === this.#settings.current.speech.modelPath,
        ) &&
        this.#engine === 'ready' &&
        !this.#error,
      error: this.#error ?? this.#engineError,
    }
  }

  async #prepare(model: SpeechModel): Promise<void> {
    if (!model.installed) return
    const path = model.installed.path
    if (this.#preparing) return this.#preparing
    const version = this.#configurationVersion
    this.#preparing = (async () => {
      try {
        await this.#request('load', path)
        if (
          version === this.#configurationVersion &&
          this.#settings.current.speech.modelPath === path
        ) {
          this.#validated = path
          this.#error = null
        }
      } catch (error) {
        if (
          version === this.#configurationVersion &&
          this.#settings.current.speech.modelPath === path
        ) {
          this.#validated = null
          if (!(error instanceof EngineIoError))
            this.#error = error instanceof Error ? error.message : String(error)
        }
        throw error
      } finally {
        this.#preparing = null
        this.#publishStatus()
        this.#refreshStatus()
      }
    })()
    return this.#preparing
  }

  async install(): Promise<{ started: boolean }> {
    await this.#init()
    if (this.#installQueued) return { started: false }
    this.#installQueued = true
    return new Promise((resolve, reject) => {
      const task = this.#queueEngine(async () => {
        if (this.#engine === 'ready' || this.#engine === 'downloading') {
          resolve({ started: false })
          return
        }
        const prior = this.#engine
        this.#configurationVersion++
        this.#engine = 'downloading'
        this.#installFailed = false
        this.#error = null
        this.#engineError = null
        this.#verifiedForSpawnAt = 0
        this.#validated = null
        clearTimeout(this.#retryTimer)
        this.#retryTimer = undefined
        this.#publishStatus()
        const download = this.#start('engine', async (signal) => {
          try {
            signal.throwIfAborted()
            if (this.#worker) await this.#stopWorkerAndWait(this.#worker)
            this.#library = await installEngine(
              join(this.#root, 'engine'),
              signal,
              (frame) => this.#emit(frame),
              (stamp) => {
                this.#verifiedStamp = stamp
              },
            )
            this.#engine = 'ready'
            this.#reinstallRequired = false
            this.#verifiedForSpawnAt = Date.now()
            this.#retryAt = 0
            this.#nextCheckAt = Date.now() + 1000
          } catch (error) {
            this.#engine = signal.aborted ? prior : 'error'
            this.#installFailed = !signal.aborted
            this.#engineError = signal.aborted
              ? null
              : error instanceof Error
                ? error.message
                : String(error)
            throw error
          } finally {
            this.#publishStatus()
          }
        })
        resolve({ started: true })
        await download
      })
      void task.catch(reject).finally(() => {
        this.#installQueued = false
        this.#refreshStatus()
        if (this.#retryAt) this.#scheduleRetry()
      })
    })
  }

  #start(id: string, run: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const controller = new AbortController()
    this.#emit({ id, phase: 'downloading', received: 0, total: 0 })
    let terminal: SpeechProgress
    const done = Promise.resolve()
      .then(() => run(controller.signal))
      .then(() => {
        const prior = this.#progress.get(id)!
        terminal = { ...prior, phase: 'complete' }
      })
      .catch((error: unknown) => {
        const cancelled = controller.signal.aborted
        const message = error instanceof Error ? error.message : String(error)
        terminal = {
          ...this.#progress.get(id)!,
          phase: cancelled ? 'cancelled' : 'error',
          ...(cancelled ? {} : { error: message }),
        }
      })
      .finally(() => {
        this.#downloads.delete(id)
        this.#models = null
        this.#emit(terminal)
      })
    this.#downloads.set(id, { controller, done })
    return done
  }

  async download(modelId: string): Promise<{ started: boolean }> {
    await this.#init()
    const model = catalog.find((entry) => entry.id === modelId)
    if (!model) throw new Error('Unknown speech model.')
    if (this.#downloads.has(modelId)) return { started: false }
    if ([...this.#downloads.keys()].some((id) => id !== 'engine'))
      throw new Error('Wait for the current model download or cancel it first.')
    const existing = (await this.models()).find((entry) => entry.id === modelId && entry.installed)
    if (existing) {
      await this.select({ modelId })
      return { started: false }
    }
    const path = join(this.#root, 'models', model.filename)
    void this.#start(modelId, async (signal) => {
      await downloadFile({
        id: modelId,
        url: `https://huggingface.co/${model.repository}/resolve/${model.revision}/${model.filename}`,
        path,
        size: model.size,
        sha256: model.sha256!,
        signal,
        progress: (frame) => this.#emit(frame),
      })
      await this.select({ modelId })
    })
    return { started: true }
  }

  cancel(id: string): { cancelled: boolean } {
    const download = this.#downloads.get(id)
    download?.controller.abort()
    return { cancelled: Boolean(download) }
  }

  async discard(modelId: string): Promise<{ discarded: boolean }> {
    const model = catalog.find((model) => model.id === modelId)
    if (!model) throw new Error('Unknown speech model.')
    if (this.#downloads.has(modelId))
      throw new Error('Cancel the model download before discarding it.')
    const path = join(this.#root, 'models', `${model.filename}.partial`)
    const exists = Boolean(await stat(path).catch(() => null))
    await rm(path, { force: true })
    this.#models = null
    return { discarded: exists }
  }

  async select(choice: { modelId?: string; path?: string }): Promise<SpeechStatus> {
    await this.#init()
    this.#models = null
    const entry = choice.modelId
      ? (await this.models()).find((model) => model.id === choice.modelId)
      : null
    const path = choice.path ?? (entry?.installed ? entry.installed.path : null)
    if (
      !path ||
      !isAbsolute(path) ||
      !path.toLowerCase().endsWith('.gguf') ||
      !(await stat(path).catch(() => null))?.isFile()
    )
      throw new Error('Choose an installed GGUF model.')
    this.#configurationVersion++
    this.#error = null
    this.#validated = null
    await this.#settings.update({
      speech: { modelId: entry?.id ?? null, modelPath: path, enabled: true },
    })
    await this.#selected()
    if (this.#engine === 'missing') void this.install().catch(() => undefined)
    return this.status()
  }

  async remove(modelId: string): Promise<{ removed: boolean }> {
    if (this.#downloads.has(modelId))
      throw new Error('Cancel the model download before removing it.')
    this.#models = null
    const model = (await this.models()).find((entry) => entry.id === modelId)
    if (!model?.installed || model.installed.source !== 'ari')
      throw new Error('Only models downloaded by Ari can be removed here.')
    const path = model.installed.path
    const resolved = await realpath(path)
    const root = await realpath(join(this.#root, 'models'))
    const inside = relative(root, resolved)
    if (inside.startsWith(`..${sep}`) || inside === '..' || isAbsolute(inside))
      throw new Error('This model belongs to another app and cannot be removed.')
    if (this.#settings.current.speech.modelPath === path) {
      if (this.#preparing) await this.#preparing.catch(() => undefined)
      if (this.#worker) await this.#request('unload', path)
      this.#validated = null
      await this.#settings.update({ speech: { modelId: null, modelPath: null, enabled: false } })
      this.#model = null
    }
    await rm(path)
    await rm(`${path}.partial`, { force: true })
    this.#models = null
    this.#publishStatus()
    return { removed: true }
  }

  async transcribe(pcm: Float32Array, language?: string): Promise<{ text: string }> {
    if (
      !pcm.length ||
      pcm.length > 16_000 * 300 ||
      pcm.some((value) => !Number.isFinite(value) || Math.abs(value) > 1)
    )
      throw new Error('Invalid recording. Record up to five minutes.')
    await this.#init()
    const model = await this.#selected()
    if (!this.#worker && model?.installed && this.#settings.current.speech.enabled && !this.#error)
      await this.#prepare(model)
    if (this.#preparing) await this.#preparing
    if (
      !this.#settings.current.speech.enabled ||
      !model?.installed ||
      this.#validated !== model.installed.path ||
      !this.#worker ||
      this.#engine !== 'ready' ||
      this.#error
    )
      throw new Error(this.#error ?? 'Set up speech to text in Settings.')
    return this.#request('transcribe', model.installed.path, pcm, language, model.size)
  }

  async #request(
    kind: 'load' | 'transcribe' | 'unload',
    path: string,
    pcm?: Float32Array,
    language?: string,
    modelSize?: number,
  ): Promise<{ text: string }> {
    let worker = await this.#getWorker()
    while (worker !== this.#worker || this.#workerState.get(worker)?.stopping)
      worker = await this.#getWorker()
    const id = ++this.#nextId
    return new Promise((resolve, reject) => {
      this.#pending.set(id, {
        resolve,
        reject,
        worker,
        kind,
        budget: speechRequestTimeout(kind, pcm?.length, modelSize),
      })
      worker.postMessage({ id, kind, path, pcm, language })
    })
  }

  async #getWorker(): Promise<UtilityProcess> {
    if (this.#worker && !this.#workerState.get(this.#worker)?.stopping) return this.#worker
    this.#workerStarting ??= this.#spawnWorker().finally(() => {
      this.#workerStarting = null
    })
    return this.#workerStarting
  }

  async #spawnWorker(): Promise<UtilityProcess> {
    return this.#queueEngine(async () => {
      if (this.#worker && this.#workerState.get(this.#worker)?.stopping)
        await this.#stopWorkerAndWait(this.#worker)
      if (this.#installFailed) throw new Error(this.#engineError ?? 'Speech engine install failed.')
      if (!this.#verifiedForSpawnAt || Date.now() - this.#verifiedForSpawnAt >= 60_000) {
        if (Date.now() < this.#retryAt) await delay(this.#retryAt - Date.now())
        await this.#inspectEngine(true)
      }
      if (this.#disposed) throw new Error('Speech service stopped.')
      if (!this.#worker) {
        if (!this.#library || this.#engine !== 'ready')
          throw new Error('Download the speech engine in Settings.')
        const child = utilityProcess.fork(join(import.meta.dirname, 'speech-worker.js'), [], {
          serviceName: 'Speech to text',
          env: { ...process.env, TRANSCRIBE_LIBRARY: this.#library },
        })
        this.#worker = child
        this.#verifiedForSpawnAt = 0
        const state = {
          hasLoaded: false,
          knownCause: false,
          stopping: false,
        }
        this.#workerState.set(child, state)
        child.on(
          'message',
          (message: {
            id: number
            started?: boolean
            result?: { text: string }
            error?: string
          }) => {
            const pending = this.#pending.get(message.id)
            if (!pending || pending.worker !== child) return
            if (message.started) {
              if (pending.timeout) return
              if (!state.stopping) state.knownCause = false
              // A queued request gets its own budget only after inference dequeues it.
              pending.timeout = setTimeout(() => {
                this.#pending.delete(message.id)
                pending.reject(
                  new Error(
                    'Speech to text took too long. Try a smaller model or a shorter recording.',
                  ),
                )
                this.#stopWorker(child)
              }, pending.budget)
              return
            }
            clearTimeout(pending.timeout)
            this.#pending.delete(message.id)
            if (message.error) {
              state.knownCause = true
              pending.reject(new Error(message.error))
            } else {
              if (pending.kind === 'load') state.hasLoaded = true
              pending.resolve(message.result ?? { text: '' })
            }
          },
        )
        child.on('exit', (code: number) => {
          const message = speechWorkerExitError(
            process.platform,
            code,
            state.hasLoaded,
            state.knownCause,
          )
          if (this.#worker === child) {
            this.#worker = null
            this.#validated = null
            this.#publishStatus()
          }
          for (const [id, pending] of this.#pending) {
            if (pending.worker !== child) continue
            clearTimeout(pending.timeout)
            pending.reject(new Error(message))
            this.#pending.delete(id)
          }
        })
      }
      return this.#worker
    })
  }

  #stopWorker(worker: UtilityProcess): boolean {
    const state = this.#workerState.get(worker)
    if (state) {
      state.knownCause = true
      state.stopping = true
    }
    return worker.kill()
  }

  async #stopWorkerAndWait(worker: UtilityProcess): Promise<void> {
    await new Promise<void>((resolve) => {
      worker.once('exit', () => resolve())
      if (!this.#stopWorker(worker)) {
        if (this.#worker === worker) {
          this.#worker = null
          this.#validated = null
          this.#publishStatus()
        }
        resolve()
      }
    })
  }

  dispose(): void {
    this.#disposed = true
    clearTimeout(this.#retryTimer)
    for (const { controller } of this.#downloads.values()) controller.abort()
    if (this.#worker) this.#stopWorker(this.#worker)
  }
}

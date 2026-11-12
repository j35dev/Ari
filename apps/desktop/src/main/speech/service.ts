import { stat, rm, realpath, mkdir, writeFile, rename } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { utilityProcess, type UtilityProcess } from 'electron'
import type { SettingsStore } from '@ari/engine/settings'
import type { SpeechModel, SpeechProgress, SpeechStatus } from '@ari/contracts/rpc'
import { catalog, discoverModels, modelRoots } from './discovery'
import { downloadFile, prunePartialDownloads, PARTIAL_DOWNLOAD_MAX_AGE } from './download'
import {
  ENGINE_VERSION,
  ENGINE_READ_ERROR,
  verifyInstalledEngine,
  engineStampMatches,
  installEngine,
  EngineIoError,
} from './engine'
import { discoverVoiceModel, KOKORO_ID, KOKORO_FILES, KOKORO_MODEL } from './voice-model'
import { verifyDownload } from './download'
import { GroqSpeech, withLocalFallback } from './groq'
import { WINDOWS_SPEECH_RUNTIME_HINT } from './runtime-hint'

const WORKER_ACK_TIMEOUT_MS = 60_000

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
  #settingsReady = false
  #engineQueue: Promise<void> = Promise.resolve()
  #checkQueued = false
  #installQueued = false
  #verifiedForSpawnAt = 0
  #lastVerifiedAt = 0
  #verifiedStamp: string | null = null
  #inspection: 'unknown' | 'present' | 'absent' = 'unknown'
  #engineIoError = false
  #installFailed = false
  #reinstallAllowed = false
  #autoInstallPath: string | null = null
  #refreshing: Promise<void> | null = null
  #refreshAgain = false
  #publishedStatus = ''
  #model: SpeechModel | null = null
  #disposed = false
  #engineError: string | null = null
  #workerStarting: Promise<UtilityProcess> | null = null
  #error: string | null = null
  #validated: string | null = null
  #configurationVersion = 0
  #preparing: Promise<void> | null = null
  #preparingPath: string | null = null
  #selecting: Promise<unknown> | null = null
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
    {
      hasLoaded: boolean
      knownCause: boolean
      stopping: boolean
      acknowledgment?: ReturnType<typeof setTimeout>
    }
  >()
  #progress = new Map<string, SpeechProgress>()
  #models: { at: number; value: SpeechModel[] } | null = null
  groq: GroqSpeech | null = null
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
    const engineFrame = this.#progress.get('engine')
    if (
      engineFrame?.phase === 'error' &&
      (engineFrame.status?.engine !== status.engine ||
        engineFrame.status?.engineError !== status.engineError)
    )
      this.#emit({
        id: 'engine',
        phase: 'complete',
        received: engineFrame.received,
        total: engineFrame.total,
        status,
      })
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
      this.#settingsReady = true
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
      this.#preparing ||
      this.#workerStarting
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
      if (!this.#recentlyVerified())
        await this.#inspectEngine(this.#engineIoError || this.#inspection === 'absent')
    })
      .catch(() => undefined)
      .finally(() => {
        this.#checkQueued = false
      })
  }

  #refreshStatus(): void {
    if (this.#disposed) return
    if (this.#refreshing) {
      this.#refreshAgain = true
      return
    }
    this.#refreshing = this.#init()
      .then(async () => {
        const model = await this.#selected()
        if (
          this.#engine === 'missing' &&
          this.#canInstall() &&
          model?.installed &&
          model.installed.path === this.#autoInstallPath &&
          this.#settings.current.speech.enabled
        ) {
          this.#autoInstallPath = null
          void this.install().catch(() => undefined)
        }
        if (
          this.#engine === 'ready' &&
          this.#settings.current.speech.enabled &&
          this.#settings.current.speech.provider !== 'groq' &&
          model?.installed &&
          model.installed.path === this.#settings.current.speech.modelPath &&
          this.#validated !== model.installed.path &&
          !this.#preparing &&
          !this.#selecting &&
          !this.#error &&
          !this.#engineError
        ) {
          this.#autoInstallPath = null
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
      throw this.#recordEngineError(error)
    }
    if (this.#disposed) return
    const wasIoError = this.#engineIoError
    this.#engineIoError = false
    this.#reinstallAllowed = false
    this.#inspection = library ? 'present' : 'absent'
    if (library) {
      this.#installFailed = false
      this.#engineError = null
      this.#library = library
      this.#engine = 'ready'
      if (full) {
        this.#autoInstallPath = null
        this.#verifiedForSpawnAt = Date.now()
        this.#lastVerifiedAt = this.#verifiedForSpawnAt
        this.#verifiedStamp = stamp
      } else if (stamp !== this.#verifiedStamp) {
        this.#verifiedForSpawnAt = 0
        this.#lastVerifiedAt = 0
      }
    } else {
      const wasInstalled = this.#library !== null
      this.#library = null
      this.#verifiedForSpawnAt = 0
      this.#lastVerifiedAt = 0
      this.#engine = 'missing'
      if (wasIoError) this.#engineError = null
      this.#validated = null
      this.#publishStatus()
      if (this.#worker) await this.#stopWorkerAndWait(this.#worker)
      if (wasInstalled)
        this.#engineError = 'The speech engine is missing or changed. Download it again.'
    }
    this.#publishStatus()
    this.#refreshStatus()
  }

  #recordEngineError(error: unknown, installFailed = false): Error {
    this.#engineIoError = error instanceof EngineIoError
    this.#installFailed = installFailed
    if (!this.#engineIoError) this.#reinstallAllowed = false
    const failure = this.#engineIoError
      ? new EngineIoError(ENGINE_READ_ERROR, { cause: error })
      : error instanceof Error
        ? error
        : new Error(String(error))
    this.#engineError = failure.message
    this.#verifiedForSpawnAt = 0
    this.#lastVerifiedAt = 0
    this.#publishStatus()
    return failure
  }

  #canInstall(): boolean {
    return this.#inspection === 'absent' && !this.#engineIoError
  }

  #recentlyVerified(): boolean {
    return (
      !this.#engineError && this.#lastVerifiedAt > 0 && Date.now() - this.#lastVerifiedAt < 60_000
    )
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
    value.push(await discoverVoiceModel(join(this.#root, 'models')))
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
    if (this.#settingsReady && !this.#engineError && !this.#recentlyVerified())
      this.#scheduleCheck()
    this.#refreshStatus()
    this.#publishStatus()
    return this.#currentStatus()
  }

  #currentStatus(): SpeechStatus {
    const model = this.#model
    const cloud =
      this.#settingsReady &&
      this.#settings.current.experimental.ariaEnabled &&
      this.#settings.current.speech.enabled &&
      this.#settings.current.speech.provider === 'groq'
    return {
      engine: this.#engine,
      engineError: this.#engineError,
      engineInstallable: this.#canInstall() && !this.#installFailed,
      engineReinstallable: this.#reinstallAllowed,
      model,
      loading: Boolean(this.#preparing && this.#settings.current.speech.enabled),
      ready:
        cloud ||
        (this.#settings.current.speech.enabled &&
          Boolean(
            model?.installed &&
            this.#validated === model.installed.path &&
            model.installed.path === this.#settings.current.speech.modelPath,
          ) &&
          this.#engine === 'ready' &&
          !this.#error),
      error: this.#error ?? this.#engineError,
    }
  }

  async #prepare(model: SpeechModel): Promise<void> {
    if (this.#selecting) await this.#selecting.catch(() => undefined)
    if (!model.installed) return
    const path = model.installed.path
    if (this.#preparing) {
      const pending = this.#preparing
      await (this.#preparingPath === path ? pending : pending.catch(() => undefined))
      return this.#prepare(model)
    }
    if (
      this.#settings.current.speech.modelPath !== path ||
      (this.#worker && this.#validated === path)
    )
      return
    const version = this.#configurationVersion
    this.#preparingPath = path
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
          if (!(error instanceof EngineIoError) && !this.#engineError)
            this.#error = error instanceof Error ? error.message : String(error)
        }
        throw error
      } finally {
        this.#preparing = null
        this.#preparingPath = null
        this.#publishStatus()
        this.#refreshStatus()
      }
    })()
    this.#publishStatus()
    return this.#preparing
  }

  install(): Promise<{ started: boolean }> {
    return this.#install('download')
  }

  reinstall(): Promise<{ started: boolean }> {
    return this.#install('reinstall')
  }

  async check(): Promise<SpeechStatus> {
    await this.#init()
    const retryInstall = await this.#queueEngine(async () => {
      if (this.#installFailed) return true
      try {
        await this.#inspectEngine(true)
      } catch (error) {
        if (!(error instanceof EngineIoError)) throw error
      }
      return false
    })
    if (retryInstall) {
      await this.#install('retry')
      await this.#downloads.get('engine')?.done
    }
    if (this.#engineIoError) {
      this.#reinstallAllowed = true
      this.#publishStatus()
    }
    this.#refreshStatus()
    return this.#currentStatus()
  }

  async #install(reason: 'download' | 'retry' | 'reinstall'): Promise<{ started: boolean }> {
    if (this.#disposed) throw new Error('Speech service stopped.')
    await this.#init()
    if (this.#installQueued) return { started: false }
    const allowed = (): boolean =>
      reason === 'reinstall'
        ? this.#reinstallAllowed
        : reason === 'retry'
          ? this.#installFailed
          : this.#canInstall()
    if (
      !allowed() &&
      (reason !== 'download' ||
        this.#inspection !== 'unknown' ||
        this.#engineIoError ||
        !this.#checkQueued)
    )
      return { started: false }
    this.#installQueued = true
    const task = this.#start('engine', (signal) =>
      this.#queueEngine(async () => {
        signal.throwIfAborted()
        if (reason === 'download' && this.#engine === 'error' && this.#canInstall())
          await this.#inspectEngine(true)
        if (!allowed() || this.#engine === 'downloading') return
        const prior = this.#engine
        this.#configurationVersion++
        this.#engine = 'downloading'
        this.#error = null
        this.#engineError = null
        this.#engineIoError = false
        this.#installFailed = false
        this.#reinstallAllowed = false
        this.#verifiedForSpawnAt = 0
        this.#lastVerifiedAt = 0
        this.#validated = null
        this.#publishStatus()
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
          this.#inspection = 'present'
          this.#verifiedForSpawnAt = Date.now()
          this.#lastVerifiedAt = this.#verifiedForSpawnAt
        } catch (error) {
          this.#engine = signal.aborted ? prior : 'error'
          this.#installFailed = !signal.aborted
          if (!signal.aborted && error instanceof EngineIoError) {
            this.#engine = prior
            throw this.#recordEngineError(error, true)
          }
          this.#engineError = signal.aborted
            ? null
            : error instanceof Error
              ? error.message
              : String(error)
          throw error
        } finally {
          this.#publishStatus()
        }
      }),
    )
    void task.finally(() => {
      this.#installQueued = false
      this.#refreshStatus()
    })
    return { started: true }
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
        this.#emit({ ...terminal, status: this.#currentStatus() })
      })
    this.#downloads.set(id, { controller, done })
    return done
  }

  async download(modelId: string): Promise<{ started: boolean }> {
    await this.#init()
    if (modelId === KOKORO_ID) return this.#downloadVoice()
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

  async #downloadVoice(): Promise<{ started: boolean }> {
    if (this.#downloads.has(KOKORO_ID)) return { started: false }
    if ([...this.#downloads.keys()].some((id) => id !== 'engine'))
      throw new Error('Wait for the current model download or cancel it first.')
    const path = join(this.#root, 'models', KOKORO_ID)
    if ((await discoverVoiceModel(join(this.#root, 'models'))).installed) return { started: false }
    void this.#start(KOKORO_ID, async (signal) => {
      await mkdir(path, { recursive: true })
      let completed = 0
      for (const file of KOKORO_FILES) {
        const target = join(path, file.name)
        if ((await stat(target).catch(() => null))?.size === file.size) {
          try {
            await verifyDownload(target, file.sha256)
            completed += file.size
            continue
          } catch {
            await rm(target, { force: true })
          }
        }
        await downloadFile({
          id: KOKORO_ID,
          url: `https://huggingface.co/${KOKORO_MODEL.repository}/resolve/${KOKORO_MODEL.revision}/${file.name}`,
          path: target,
          size: file.size,
          sha256: file.sha256,
          signal,
          progress: (frame) =>
            this.#emit({
              ...frame,
              received: completed + frame.received,
              total: KOKORO_MODEL.size,
            }),
        })
        completed += file.size
      }
      signal.throwIfAborted()
      await writeFile(join(path, 'verified.json.tmp'), JSON.stringify(KOKORO_FILES))
      await rename(join(path, 'verified.json.tmp'), join(path, 'verified.json'))
      this.#emit({
        id: KOKORO_ID,
        phase: 'complete',
        received: KOKORO_MODEL.size,
        total: KOKORO_MODEL.size,
      })
    })
    return { started: true }
  }

  cancel(id: string): { cancelled: boolean } {
    const download = this.#downloads.get(id)
    download?.controller.abort()
    return { cancelled: Boolean(download) }
  }

  async discard(modelId: string): Promise<{ discarded: boolean }> {
    if (modelId === KOKORO_ID) {
      if (this.#downloads.has(modelId)) throw new Error('Cancel the model download first.')
      for (const file of KOKORO_FILES)
        await rm(join(this.#root, 'models', KOKORO_ID, `${file.name}.partial`), { force: true })
      this.#models = null
      return { discarded: true }
    }
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
    const updating = this.#settings.update({
      speech: { modelId: entry?.id ?? null, modelPath: path, enabled: true },
    })
    this.#selecting = updating
    try {
      await updating
    } finally {
      if (this.#selecting === updating) this.#selecting = null
    }
    this.#configurationVersion++
    this.#autoInstallPath = path
    this.#error = null
    this.#validated = null
    const model = await this.#selected()
    if (model && this.#engine === 'ready' && !this.#installQueued) {
      this.#autoInstallPath = null
      if (!this.#engineError) void this.#prepare(model).catch(() => undefined)
    }
    this.#publishStatus()
    this.#refreshStatus()
    return this.#currentStatus()
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
    if (modelId === KOKORO_ID) await rm(path, { recursive: true })
    else await rm(path)
    await rm(`${path}.partial`, { force: true })
    this.#models = null
    this.#publishStatus()
    return { removed: true }
  }

  async transcribe(pcm: Float32Array, language?: string): Promise<{ text: string }> {
    if (!pcm.length || pcm.some((value) => !Number.isFinite(value) || Math.abs(value) > 1))
      throw new Error('Invalid recording.')
    await this.#init()
    if (
      this.#settings.current.experimental.ariaEnabled &&
      this.#settings.current.speech.enabled &&
      this.#settings.current.speech.provider === 'groq' &&
      this.groq
    )
      return withLocalFallback(
        () => this.groq!.transcribe(pcm, this.#settings.current.speech.groqModel, language),
        () => this.#transcribeLocal(pcm, language),
        (message) =>
          this.#emit({ id: 'groq', phase: 'error', received: 0, total: 0, error: message }),
      )
    return this.#transcribeLocal(pcm, language)
  }

  async #transcribeLocal(pcm: Float32Array, language?: string): Promise<{ text: string }> {
    if (this.#selecting) await this.#selecting.catch(() => undefined)
    const model = await this.#selected()
    if (
      (!this.#worker || (model?.installed && this.#validated !== model.installed.path)) &&
      model?.installed &&
      this.#settings.current.speech.enabled &&
      !this.#error
    )
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
      this.#watchAcknowledgment(worker)
      try {
        worker.postMessage({ id, kind, path, pcm, language })
      } catch {
        this.#stopWorker(worker, 'The speech engine could not receive the request. Please retry.')
      }
    })
  }

  #watchAcknowledgment(worker: UtilityProcess): void {
    const state = this.#workerState.get(worker)
    if (!state) return
    const pending = [...this.#pending.values()].filter((request) => request.worker === worker)
    // The worker posts started before model loading/inference. Queued work must
    // never spend this idle/bootstrap budget while another request is running.
    if (state.stopping || !pending.length || pending.some((request) => request.timeout)) {
      clearTimeout(state.acknowledgment)
      state.acknowledgment = undefined
      return
    }
    // Additional queued requests do not extend an already stalled dispatch.
    state.acknowledgment ??= setTimeout(() => {
      this.#stopWorker(worker, 'The speech engine did not start the request. Please retry.')
    }, WORKER_ACK_TIMEOUT_MS)
  }

  async #getWorker(): Promise<UtilityProcess> {
    if (this.#disposed) throw new Error('Speech service stopped.')
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
      if (this.#verifiedForSpawnAt && Date.now() - this.#verifiedForSpawnAt < 60_000) {
        try {
          if (
            !this.#verifiedStamp ||
            !(await engineStampMatches(
              join(this.#root, 'engine', ENGINE_VERSION),
              this.#verifiedStamp,
            ))
          )
            this.#verifiedForSpawnAt = 0
        } catch (error) {
          throw this.#recordEngineError(error)
        }
      }
      if (!this.#verifiedForSpawnAt || Date.now() - this.#verifiedForSpawnAt >= 60_000) {
        await this.#inspectEngine(true)
      }
      if (this.#disposed) throw new Error('Speech service stopped.')
      if (!this.#worker) {
        if (!this.#library || this.#engine !== 'ready')
          throw new Error(this.#engineError ?? 'Download the speech engine in Settings.')
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
                this.#stopWorker(
                  child,
                  'Speech to text took too long. Try a smaller model or a shorter recording.',
                )
              }, pending.budget)
              this.#watchAcknowledgment(child)
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
            this.#watchAcknowledgment(child)
          },
        )
        child.on('exit', (code: number) => {
          clearTimeout(this.#workerState.get(child)?.acknowledgment)
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

  #stopWorker(worker: UtilityProcess, message = 'The speech engine stopped. Please retry.'): void {
    const state = this.#workerState.get(worker)
    if (state?.stopping) return
    if (state) {
      state.knownCause = true
      state.stopping = true
      clearTimeout(state.acknowledgment)
      state.acknowledgment = undefined
    }
    // kill/exit is not an acknowledgment guarantee. Settle our requests now,
    // and ignore late messages by removing their worker-scoped identities.
    for (const [id, pending] of this.#pending) {
      if (pending.worker !== worker) continue
      clearTimeout(pending.timeout)
      this.#pending.delete(id)
      pending.reject(new Error(message))
    }
    try {
      worker.kill()
    } catch {
      // A failed kill is not an exit. The stop waiter retains the identity and
      // reports its bounded failure without spawning another inference worker.
    }
  }

  async #stopWorkerAndWait(worker: UtilityProcess): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timeout)
        worker.removeListener('exit', finish)
        resolve()
      }
      const timeout = setTimeout(() => {
        worker.removeListener('exit', finish)
        // Keep the stopping identity rather than spawning a duplicate worker.
        reject(new Error('The speech engine did not stop. Please retry.'))
      }, 5000)
      worker.once('exit', finish)
      this.#stopWorker(worker)
    })
  }

  dispose(): void {
    this.#disposed = true
    for (const { controller } of this.#downloads.values()) controller.abort()
    if (this.#worker) this.#stopWorker(this.#worker, 'Speech service stopped.')
  }
}

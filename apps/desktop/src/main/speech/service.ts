import { stat, rm, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { utilityProcess, type UtilityProcess } from 'electron'
import type { SettingsStore } from '@ari/engine/settings'
import type { SpeechModel, SpeechProgress, SpeechStatus } from '@ari/contracts/rpc'
import { catalog, discoverModels, modelRoots } from './discovery'
import { downloadFile, prunePartialDownloads } from './download'
import { ENGINE_VERSION, verifyInstalledEngine, installEngine } from './engine'

export function speechRequestTimeout(kind: string, samples = 0, modelSize = 0): number {
  if (kind !== 'transcribe') return 15 * 60_000
  // CPU-only machines can take many times the recording length on larger models.
  const factor = modelSize >= 1_000_000_000 ? 60 : 30
  return 10 * 60_000 + (samples / 16_000) * factor * 1000
}

export class SpeechService {
  readonly #root: string
  readonly #settings: SettingsStore
  #engine: SpeechStatus['engine'] = 'missing'
  #library: string | null = null
  #initialized: Promise<void> | null = null
  #error: string | null = null
  #validated: string | null = null
  #preparing: Promise<void> | null = null
  #worker: UtilityProcess | null = null
  #nextId = 0
  #pending = new Map<
    number,
    {
      resolve: (result: { text: string }) => void
      reject: (error: Error) => void
      worker: UtilityProcess
      budget: number
      timeout?: ReturnType<typeof setTimeout>
    }
  >()
  #downloads = new Map<string, { controller: AbortController; done: Promise<void> }>()
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

  async #init(): Promise<void> {
    this.#initialized ??= (async () => {
      await this.#settings.load()
      if (!this.#settings.current.speech.shortcut)
        await this.#settings.update({
          speech: { shortcut: process.platform === 'darwin' ? 'ctrl+alt+space' : 'ctrl+space' },
        })
      await this.#checkEngine(true)
    })()
    return this.#initialized
  }

  async #checkEngine(full = false): Promise<void> {
    if (this.#engine === 'downloading') return
    const library = await verifyInstalledEngine(
      join(this.#root, 'engine', ENGINE_VERSION),
      full || this.#engine !== 'ready',
    )
    if (library) {
      this.#library = library
      this.#engine = 'ready'
    } else {
      const wasInstalled = this.#library !== null
      this.#library = null
      this.#engine = 'missing'
      this.#validated = null
      this.#worker?.kill()
      if (wasInstalled) {
        this.#error = 'The speech engine is missing or changed. Download it again.'
        this.#emit({
          id: 'configuration',
          phase: 'error',
          received: 0,
          total: 0,
          error: this.#error,
        })
      }
    }
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
    if (!modelPath) return null
    const known = (await this.models(false)).find(
      (entry) => entry.installed && entry.installed.path === modelPath,
    )
    if (known) return known
    const file = await stat(modelPath).catch(() => null)
    if (!file?.isFile() || !modelPath.toLowerCase().endsWith('.gguf') || !file.size) return null
    return {
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
  }

  async status(): Promise<SpeechStatus> {
    await this.#init()
    await this.#checkEngine()
    const model = await this.#selected()
    if (
      this.#engine === 'ready' &&
      this.#settings.current.speech.enabled &&
      model?.installed &&
      this.#validated !== model.installed.path &&
      !this.#error
    ) {
      void this.#prepare(model).catch(() => undefined)
    }
    return {
      engine: this.#engine,
      model,
      ready:
        this.#settings.current.speech.enabled &&
        Boolean(model?.installed && this.#validated === model.installed.path) &&
        this.#engine === 'ready' &&
        !this.#error,
      error: this.#error,
    }
  }

  async #prepare(model: SpeechModel): Promise<void> {
    if (!model.installed) return
    const path = model.installed.path
    if (this.#preparing) return this.#preparing
    this.#preparing = (async () => {
      try {
        await this.#checkEngine(true)
        if (this.#engine !== 'ready') throw new Error('Download the speech engine in Settings.')
        await this.#request('load', path)
        this.#validated = path
        this.#error = null
        this.#emit({ id: 'configuration', phase: 'complete', received: 0, total: 0 })
      } catch (error) {
        await this.#checkEngine(true)
        this.#validated = null
        this.#error = error instanceof Error ? error.message : String(error)
        this.#emit({
          id: 'configuration',
          phase: 'error',
          received: 0,
          total: 0,
          error: this.#error,
        })
        throw error
      } finally {
        this.#preparing = null
      }
    })()
    return this.#preparing
  }

  async install(): Promise<{ started: boolean }> {
    await this.#init()
    await this.#checkEngine(true)
    if (this.#engine === 'downloading' || this.#engine === 'ready') return { started: false }
    this.#engine = 'downloading'
    this.#error = null
    this.#start('engine', async (signal) => {
      this.#library = await installEngine(join(this.#root, 'engine'), signal, (frame) =>
        this.#emit(frame),
      )
      this.#engine = 'ready'
      this.#validated = null
      const model = await this.#selected()
      if (model) await this.#prepare(model).catch(() => undefined)
    })
    return { started: true }
  }

  #start(id: string, run: (signal: AbortSignal) => Promise<void>): void {
    const controller = new AbortController()
    this.#emit({ id, phase: 'downloading', received: 0, total: 0 })
    const done = Promise.resolve()
      .then(() => run(controller.signal))
      .then(() => {
        this.#models = null
        const prior = this.#progress.get(id)!
        this.#emit({ ...prior, phase: 'complete' })
      })
      .catch((error: unknown) => {
        const cancelled = controller.signal.aborted
        const message = error instanceof Error ? error.message : String(error)
        if (id === 'engine') {
          this.#engine = cancelled ? 'missing' : 'error'
          this.#error = cancelled ? null : message
        }
        this.#models = null
        this.#emit({
          ...this.#progress.get(id)!,
          phase: cancelled ? 'cancelled' : 'error',
          ...(cancelled ? {} : { error: message }),
        })
      })
      .finally(() => {
        this.#downloads.delete(id)
        this.#models = null
      })
    this.#downloads.set(id, { controller, done })
  }

  async download(modelId: string): Promise<{ started: boolean }> {
    await this.#init()
    const model = catalog.find((entry) => entry.id === modelId)
    if (!model) throw new Error('Unknown speech model.')
    if (this.#downloads.has(modelId)) return { started: false }
    if ([...this.#downloads.keys()].some((id) => id !== 'engine'))
      throw new Error('Wait for the current model download or cancel it first.')
    await this.#discardOtherPartials(modelId)
    const existing = (await this.models()).find((entry) => entry.id === modelId && entry.installed)
    if (existing) {
      await this.select({ modelId })
      return { started: false }
    }
    const path = join(this.#root, 'models', model.filename)
    this.#start(modelId, async (signal) => {
      await downloadFile({
        id: modelId,
        url: `https://huggingface.co/${model.repository}/resolve/${model.revision}/${model.filename}`,
        path,
        size: model.size,
        sha256: model.sha256!,
        signal,
        progress: (frame) => this.#emit(frame),
      })
      this.#models = null
      await this.select({ modelId })
    })
    return { started: true }
  }

  cancel(id: string): { cancelled: boolean } {
    const download = this.#downloads.get(id)
    download?.controller.abort()
    return { cancelled: Boolean(download) }
  }

  async #discardOtherPartials(keepId?: string): Promise<void> {
    for (const [id, task] of this.#downloads) {
      if (id === 'engine' || id === keepId) continue
      task.controller.abort()
      await task.done
    }
    const keep = new Set(
      catalog.filter((model) => model.id === keepId).map((model) => `${model.filename}.partial`),
    )
    await prunePartialDownloads(join(this.#root, 'models'), keep, 0)
    this.#models = null
  }

  async discard(modelId: string): Promise<{ discarded: boolean }> {
    const model = catalog.find((model) => model.id === modelId)
    if (!model) throw new Error('Unknown speech model.')
    const task = this.#downloads.get(modelId)
    if (task) {
      task.controller.abort()
      await task.done
    }
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
    await this.#discardOtherPartials(entry?.id)
    if (this.#preparing) await this.#preparing.catch(() => undefined)
    this.#error = null
    this.#validated = null
    await this.#settings.update({
      speech: { modelId: entry?.id ?? null, modelPath: path, enabled: true },
    })
    if (this.#engine !== 'ready') await this.install()
    else {
      const selected = await this.#selected()
      if (selected) await this.#prepare(selected)
    }
    this.#emit({ id: 'configuration', phase: 'complete', received: 0, total: 0 })
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
    }
    await rm(path)
    await rm(`${path}.partial`, { force: true })
    this.#models = null
    this.#emit({ id: 'configuration', phase: 'complete', received: 0, total: 0 })
    return { removed: true }
  }

  async transcribe(pcm: Float32Array, language?: string): Promise<{ text: string }> {
    if (
      !pcm.length ||
      pcm.length > 16_000 * 300 ||
      pcm.some((value) => !Number.isFinite(value) || Math.abs(value) > 1)
    )
      throw new Error('Invalid recording. Record up to five minutes.')
    const status = await this.status()
    if (this.#preparing) await this.#preparing
    await this.#checkEngine(true)
    if (
      !this.#settings.current.speech.enabled ||
      !status.model?.installed ||
      this.#validated !== status.model.installed.path ||
      this.#engine !== 'ready' ||
      this.#error
    )
      throw new Error(this.#error ?? 'Set up speech to text in Settings.')
    return this.#request(
      'transcribe',
      status.model.installed.path,
      pcm,
      language,
      status.model.size,
    )
  }

  #request(
    kind: 'load' | 'transcribe' | 'unload',
    path: string,
    pcm?: Float32Array,
    language?: string,
    modelSize?: number,
  ): Promise<{ text: string }> {
    if (!this.#worker) {
      if (!this.#library)
        return Promise.reject(new Error('Download the speech engine in Settings.'))
      const child = utilityProcess.fork(join(import.meta.dirname, 'speech-worker.js'), [], {
        serviceName: 'Speech to text',
        env: { ...process.env, TRANSCRIBE_LIBRARY: this.#library },
      })
      this.#worker = child
      child.on(
        'message',
        (message: { id: number; started?: boolean; result?: { text: string }; error?: string }) => {
          const pending = this.#pending.get(message.id)
          if (!pending || pending.worker !== child) return
          if (message.started) {
            if (pending.timeout) return
            // A queued request gets its own budget only after inference dequeues it.
            pending.timeout = setTimeout(() => {
              this.#pending.delete(message.id)
              pending.reject(
                new Error(
                  'Speech to text took too long. Try a smaller model or a shorter recording.',
                ),
              )
              child.kill()
            }, pending.budget)
            return
          }
          clearTimeout(pending.timeout)
          this.#pending.delete(message.id)
          if (message.error) pending.reject(new Error(message.error))
          else pending.resolve(message.result ?? { text: '' })
        },
      )
      child.on('exit', () => {
        if (this.#worker === child) {
          this.#worker = null
          this.#validated = null
        }
        for (const [id, pending] of this.#pending) {
          if (pending.worker !== child) continue
          clearTimeout(pending.timeout)
          pending.reject(new Error('The speech engine stopped. Please retry.'))
          this.#pending.delete(id)
        }
      })
    }
    const id = ++this.#nextId
    return new Promise((resolve, reject) => {
      const worker = this.#worker!
      this.#pending.set(id, {
        resolve,
        reject,
        worker,
        budget: speechRequestTimeout(kind, pcm?.length, modelSize),
      })
      worker.postMessage({ id, kind, path, pcm, language })
    })
  }

  dispose(): void {
    for (const { controller } of this.#downloads.values()) controller.abort()
    this.#worker?.kill()
  }
}

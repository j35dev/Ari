import { stat, rm, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { utilityProcess, type UtilityProcess } from 'electron'
import type { SettingsStore } from '@ari/engine/settings'
import type { SpeechModel, SpeechProgress, SpeechStatus } from '@ari/contracts/rpc'
import { catalog, discoverModels, modelRoots } from './discovery'
import { downloadFile } from './download'
import { ENGINE_VERSION, findLibrary, installEngine } from './engine'

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
      timeout: ReturnType<typeof setTimeout>
    }
  >()
  #downloads = new Map<string, AbortController>()
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
          speech: { shortcut: process.platform === 'darwin' ? 'alt+space' : 'ctrl+space' },
        })
      this.#library = await findLibrary(join(this.#root, 'engine', ENGINE_VERSION))
      if (this.#library) this.#engine = 'ready'
    })()
    return this.#initialized
  }

  async models(refresh = true): Promise<SpeechModel[]> {
    if (!refresh && this.#models && Date.now() - this.#models.at < 10_000) return this.#models.value
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
        await this.#request('load', path)
        this.#validated = path
        this.#error = null
        this.#emit({ id: 'configuration', phase: 'complete', received: 0, total: 0 })
      } catch (error) {
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
    this.#downloads.set(id, controller)
    this.#emit({ id, phase: 'downloading', received: 0, total: 0 })
    void run(controller.signal)
      .then(() => {
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
  }

  async download(modelId: string): Promise<{ started: boolean }> {
    await this.#init()
    const model = catalog.find((entry) => entry.id === modelId)
    if (!model) throw new Error('Unknown speech model.')
    if ([...this.#downloads.keys()].some((id) => id !== 'engine'))
      throw new Error('Wait for the current model download or cancel it first.')
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
    download?.abort()
    return { cancelled: Boolean(download) }
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
    if (
      !this.#settings.current.speech.enabled ||
      !status.model?.installed ||
      this.#validated !== status.model.installed.path ||
      this.#engine !== 'ready' ||
      this.#error
    )
      throw new Error(this.#error ?? 'Set up speech to text in Settings.')
    return this.#request('transcribe', status.model.installed.path, pcm, language)
  }

  #request(
    kind: 'load' | 'transcribe' | 'unload',
    path: string,
    pcm?: Float32Array,
    language?: string,
  ): Promise<{ text: string }> {
    if (!this.#worker) {
      if (!this.#library)
        return Promise.reject(new Error('Download the speech engine in Settings.'))
      const child = utilityProcess.fork(join(import.meta.dirname, 'speech-worker.js'), [], {
        serviceName: 'Speech to text',
        env: { ...process.env, TRANSCRIBE_LIBRARY: this.#library },
      })
      this.#worker = child
      child.on('message', (message: { id: number; result?: { text: string }; error?: string }) => {
        const pending = this.#pending.get(message.id)
        if (!pending) return
        clearTimeout(pending.timeout)
        this.#pending.delete(message.id)
        if (message.error) pending.reject(new Error(message.error))
        else pending.resolve(message.result ?? { text: '' })
      })
      child.on('exit', () => {
        if (this.#worker === child) this.#worker = null
        this.#validated = null
        for (const pending of this.#pending.values()) {
          clearTimeout(pending.timeout)
          pending.reject(
            new Error(
              process.platform === 'win32'
                ? 'The speech engine stopped. Check that Microsoft Visual C++ 2015–2022 Redistributable 14.40 or newer is installed, then retry.'
                : 'The speech engine stopped. Please retry.',
            ),
          )
        }
        this.#pending.clear()
      })
    }
    const id = ++this.#nextId
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#worker?.kill()
      }, 5 * 60_000)
      this.#pending.set(id, { resolve, reject, timeout })
      this.#worker!.postMessage({ id, kind, path, pcm, language })
    })
  }

  dispose(): void {
    for (const controller of this.#downloads.values()) controller.abort()
    this.#worker?.kill()
  }
}

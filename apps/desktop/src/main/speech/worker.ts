import type { TranscribeModel as Model } from 'transcribe-cpp'
import { WINDOWS_SPEECH_RUNTIME_HINT } from './runtime-hint'

let model: Model | null = null
let loadedPath: string | null = null
let hasLoaded = false
let idle: ReturnType<typeof setTimeout> | undefined
let queue = Promise.resolve()

function unload(): void {
  model?.dispose()
  model = null
  loadedPath = null
}

interface Request {
  id: number
  kind: 'load' | 'transcribe' | 'unload'
  path?: string
  pcm?: Float32Array
  language?: string
}

process.parentPort?.on('message', (event: { data: Request }) => {
  const request = event.data
  queue = queue.then(async () => {
    clearTimeout(idle)
    process.parentPort?.postMessage({ id: request.id, started: true })
    let loadingLibrary = false
    try {
      if (request.kind === 'unload') unload()
      else {
        if (loadedPath !== request.path) {
          unload()
          loadingLibrary = true
          const { TranscribeModel } = await import('transcribe-cpp')
          model = await TranscribeModel.load(request.path!)
          loadingLibrary = false
          loadedPath = request.path!
          hasLoaded = true
        }
        const result =
          request.kind === 'transcribe'
            ? await model!.transcribe(
                request.pcm!,
                request.language ? { language: request.language } : {},
              )
            : null
        process.parentPort?.postMessage({ id: request.id, result: { text: result?.text ?? '' } })
        return
      }
      process.parentPort?.postMessage({ id: request.id, result: { text: '' } })
    } catch (error) {
      unload()
      const message = String(error)
      process.parentPort?.postMessage({
        id: request.id,
        error:
          loadingLibrary &&
          !hasLoaded &&
          process.platform === 'win32' &&
          /shared library|specified module|\.dll/i.test(message)
            ? `${message} ${WINDOWS_SPEECH_RUNTIME_HINT}`
            : message,
      })
    } finally {
      idle = setTimeout(unload, 5 * 60_000)
    }
  })
})

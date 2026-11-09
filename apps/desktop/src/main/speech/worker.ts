import type { TranscribeModel as Model } from 'transcribe-cpp'

let model: Model | null = null
let loadedPath: string | null = null
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
    try {
      if (request.kind === 'unload') unload()
      else {
        if (loadedPath !== request.path) {
          unload()
          const { TranscribeModel } = await import('transcribe-cpp')
          model = await TranscribeModel.load(request.path!)
          loadedPath = request.path!
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
          process.platform === 'win32' && /shared library|specified module|\.dll/i.test(message)
            ? `${message} Install Microsoft Visual C++ 2015–2022 Redistributable 14.40 or newer and retry.`
            : message,
      })
    } finally {
      idle = setTimeout(unload, 5 * 60_000)
    }
  })
})

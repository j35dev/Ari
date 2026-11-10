import { createWindowsDictation } from './windows-dictation'
import type { WindowsDictationTarget } from './windows-dictation'

const targets = new Map<string, WindowsDictationTarget>()
try {
  const native = createWindowsDictation()
  process.parentPort?.on(
    'message',
    (event: {
      data: { id: number; kind: string; target: string; text?: string; window?: string }
    }) => {
      const request = event.data
      void (async () => {
        try {
          let result: unknown
          if (request.kind === 'capture') {
            targets.get(request.target)?.cancel()
            targets.set(request.target, native.capture(request.window))
          } else if (request.kind === 'cancel') {
            targets.get(request.target)?.cancel()
            targets.delete(request.target)
          } else {
            const target = targets.get(request.target)
            if (!target) throw new Error('The dictation target is no longer available.')
            if (request.kind === 'snapshot') result = target.snapshot()
            else if (request.kind === 'insert') {
              try {
                await target.insert(
                  request.text ?? '',
                  () => targets.get(request.target) === target,
                )
              } finally {
                targets.delete(request.target)
              }
            } else throw new Error('Unknown dictation operation.')
          }
          process.parentPort?.postMessage({ id: request.id, result })
        } catch (error) {
          process.parentPort?.postMessage({
            id: request.id,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      })()
    },
  )
  process.parentPort?.postMessage({ ready: true })
} catch (error) {
  process.parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) })
}

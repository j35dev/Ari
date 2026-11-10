import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DuckingState, type DuckedVolume, type OutputBackend } from './audio-ducking-state'
import { pulseOutputBackend } from './audio-ducking-linux'

async function run(): Promise<void> {
  let excluded = new Set<number>([process.pid, process.ppid])
  const path = process.argv[2]!
  await mkdir(dirname(path), { recursive: true })
  let backend: OutputBackend
  let lastError = ''
  if (process.platform === 'win32') {
    const { windowsOutputBackend } = await import('./audio-ducking-windows')
    backend = windowsOutputBackend(() => excluded)
  } else backend = pulseOutputBackend(() => excluded)
  const state = new DuckingState(
    backend,
    {
      async read() {
        try {
          const entries = JSON.parse(await readFile(path, 'utf8')) as DuckedVolume[]
          if (
            !Array.isArray(entries) ||
            entries.some(
              (entry) =>
                typeof entry.id !== 'string' ||
                !Array.isArray(entry.original) ||
                !Array.isArray(entry.applied) ||
                [...entry.original, ...entry.applied].some(
                  (value) => !Number.isFinite(value) || value < 0,
                ),
            )
          )
            throw new Error('Invalid audio restoration journal')
          return entries
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
          throw error
        }
      },
      async write(entries) {
        await writeFile(`${path}.tmp`, JSON.stringify(entries), { mode: 0o600 })
        await rename(`${path}.tmp`, path)
      },
    },
    (error) => {
      const message = String(error)
      if (message !== lastError) {
        lastError = message
        send({ error: message })
      }
    },
  )
  let closing = false
  const close = async (): Promise<void> => {
    if (closing) return
    closing = true
    clearInterval(timer)
    await state.close()
    process.exit(0)
  }
  process.on('message', (message: { active: boolean; excluded: number[] }) => {
    if (closing) return
    excluded = new Set([...message.excluded, process.pid])
    void state.setActive(message.active)
  })
  // IPC closes when Ari dies, including an abrupt main-process exit.
  process.on('disconnect', () => void close())
  process.on('SIGTERM', () => void close())
  process.on('SIGINT', () => void close())
  const timer = setInterval(() => {
    if (!closing && state.needsReconcile) void state.reconcile()
  }, 500)
  await state.reconcile()
  if (!process.connected) await close()
  else send({ ready: true })
}
function send(message: { error?: string; ready?: boolean }): void {
  if (!process.connected) return
  try {
    process.send?.(message, () => undefined)
  } catch {
    /* Parent exited while restoring audio. */
  }
}
void run().catch((error: unknown) => {
  send({ error: String(error) })
  process.exit(1)
})

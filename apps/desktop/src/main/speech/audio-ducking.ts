import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { createLogger } from '@ari/shared/logger'

const log = createLogger('desktop:audio-ducking')
export interface AudioDucking {
  setActive(owner: string, active: boolean): void
}

/** Shared across widget replacements: overlapping owners share one baseline. */
export class AudioDuckingController implements AudioDucking {
  private owners = new Set<string>()
  private child: ChildProcess | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private failures = 0
  constructor(
    private readonly launch: () => ChildProcess,
    private readonly ownPids: () => number[],
    private readonly warn: (error: unknown) => void = (error) =>
      log.warn('audio ducking unavailable', { error: String(error) }),
    recoverOnStart = false,
  ) {
    if (recoverOnStart) this.start()
  }

  setActive(owner: string, active: boolean): void {
    const wasActive = this.owners.size > 0
    if (active) this.owners.add(owner)
    else this.owners.delete(owner)
    if (!wasActive && this.owners.size) this.failures = 0
    if (this.owners.size && !this.child && !this.retry && this.failures <= 3) {
      this.start()
    }
    this.send()
    if (this.owners.size && !this.timer) {
      this.timer = setInterval(() => this.send(), 1000)
      this.timer.unref()
    } else if (!this.owners.size && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private start(): void {
    try {
      const child = this.launch()
      this.child = child
      child.on('message', (message: { ready?: boolean; error?: string }) => {
        if (child !== this.child) return
        if (message.error) this.warn(message.error)
        if (message.ready) {
          this.send()
        }
      })
      child.on('error', (error) => this.warn(error))
      const restart = (): void => {
        if (this.child !== child) return
        this.child = null
        if (++this.failures > 3) return
        // Restart even after release: recover the journal left by a failed helper.
        this.retry = setTimeout(() => {
          this.retry = null
          this.start()
          this.send()
        }, 1000 * this.failures)
        this.retry.unref()
      }
      child.once('exit', restart)
      // A failed spawn emits close without necessarily emitting exit.
      child.once('close', restart)
      child.unref()
      child.channel?.unref()
    } catch (error) {
      this.warn(error)
    }
  }

  private send(): void {
    try {
      if (this.child?.connected)
        this.child.send({ active: this.owners.size > 0, excluded: this.ownPids() }, (error) => {
          if (error) this.warn(error)
        })
    } catch (error) {
      this.warn(error)
    }
  }
}

let controller: AudioDucking | undefined
export function getAudioDucking(): AudioDucking {
  if (controller) return controller
  if (process.platform !== 'win32' && process.platform !== 'linux')
    return (controller = { setActive() {} })
  const path = join(app.getPath('userData'), 'speech', 'audio-ducking.json')
  let recover: boolean
  try {
    recover = (JSON.parse(readFileSync(path, 'utf8')) as unknown[]).length > 0
  } catch (error) {
    recover = (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
  controller = new AudioDuckingController(
    () =>
      spawn(process.execPath, [join(import.meta.dirname, 'audio-ducking-worker.js'), path], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        windowsHide: true,
      }),
    () => [process.pid, ...app.getAppMetrics().map((metric) => metric.pid)],
    undefined,
    recover,
  )
  return controller
}

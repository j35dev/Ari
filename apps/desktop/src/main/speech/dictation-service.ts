import { join } from 'node:path'
import { utilityProcess, type UtilityProcess } from 'electron'
import type { DictationTarget } from '../../shared/dictation'

/** UI Automation runs on its own COM MTA thread, away from Electron's UI thread. */
export class WindowsDictationService {
  private child: UtilityProcess | null = null
  private boot: Promise<void> | null = null
  private next = 0
  private foreground: (() => string | null) | null = null
  private readonly pending = new Map<
    number,
    {
      resolve(value: unknown): void
      reject(error: Error): void
      timer: ReturnType<typeof setTimeout>
    }
  >()

  async prepare(): Promise<void> {
    this.foreground ??= (await import('./windows-foreground')).foregroundWindow
    if (this.boot) return this.boot
    this.boot = new Promise<void>((resolve, reject) => {
      const child = utilityProcess.fork(join(import.meta.dirname, 'dictation-worker.js'), [], {
        serviceName: 'Windows dictation',
        stdio: 'pipe',
      })
      this.child = child
      const timer = setTimeout(() => {
        reject(new Error('Windows dictation did not start. Try again.'))
        this.close()
      }, 10_000)
      child.on(
        'message',
        (message: { ready?: boolean; id?: number; result?: unknown; error?: string }) => {
          if (this.child !== child) return
          if (message.ready) {
            clearTimeout(timer)
            resolve()
            return
          }
          if (message.id === undefined) {
            clearTimeout(timer)
            reject(new Error(message.error ?? 'Windows dictation is unavailable.'))
            this.close()
            return
          }
          const pending = this.pending.get(message.id)
          if (!pending) return
          this.pending.delete(message.id)
          clearTimeout(pending.timer)
          if (message.error) pending.reject(new Error(message.error))
          else pending.resolve(message.result)
        },
      )
      child.once('exit', () => {
        clearTimeout(timer)
        reject(new Error('Windows dictation stopped. Try again.'))
        if (this.child === child) this.close()
      })
    })
    return this.boot
  }

  private async request(
    kind: string,
    target: string,
    text?: string,
    window?: string | null,
  ): Promise<unknown> {
    await this.prepare()
    const child = this.child
    if (!child) throw new Error('Windows dictation stopped. Try again.')
    return new Promise((resolve, reject) => {
      const id = ++this.next
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Windows could not access the dictation target. Try again.'))
        // A provider may be unresponsive; never retain a late insertion request.
        this.close()
      }, 10_000)
      this.pending.set(id, { resolve, reject, timer })
      try {
        child.postMessage({ id, kind, target, text, window })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async capture(id: string): Promise<DictationTarget> {
    if (!this.foreground) await this.prepare()
    const window = this.foreground!()
    if (!window) throw new Error('Focus a text field before dictating.')
    await this.request('capture', id, undefined, window)
    return {
      cancel: () => {
        if (this.child) void this.request('cancel', id).catch(() => undefined)
      },
      insert: async (text, current = () => true) => {
        if (!current()) {
          void this.request('cancel', id).catch(() => undefined)
          throw new Error('The dictation target changed.')
        }
        await this.request('insert', id, text)
      },
    }
  }

  /** Used by the native integration check to verify the actual editor contents. */
  async snapshot(id: string): Promise<{ text: string; start: number; end: number }> {
    return (await this.request('snapshot', id)) as { text: string; start: number; end: number }
  }

  close(): void {
    const child = this.child
    this.child = null
    this.boot = null
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Windows dictation stopped. Try again.'))
    }
    this.pending.clear()
    child?.kill()
  }
}

import type { Readable } from 'node:stream'
import type { AgentEvent } from '@ari/contracts/agent-event'

/**
 * Structural process surface the pump depends on. Real spawned children
 * satisfy it; so do test doubles built from PassThrough streams.
 */
export interface PumpableProcess {
  stdout: Readable
  stderr: Readable
  on(event: 'close', listener: (code: number | null) => void): unknown
}

/**
 * Generic stdout JSONL pump shared by all CLI drivers: buffers partial
 * lines, maps complete lines via the driver's mapper, guarantees exactly one
 * terminal `done`, and surfaces non-zero exits as errors.
 */
export function streamProcessEvents(
  child: PumpableProcess,
  mapLine: (line: string) => AgentEvent[],
  options: { label: string; stderrLog?: (text: string) => void } = { label: 'provider' },
): AsyncIterable<AgentEvent> {
  async function* generate(): AsyncGenerator<AgentEvent, void, undefined> {
    let buffer = ''
    const queue: AgentEvent[] = []
    let notify: (() => void) | null = null
    let closed = false
    // Bounded stderr tail (comet #95): the actionable part of a crash is the
    // LAST few lines, not the first — keep appending, trim on report.
    const stderrTail: string[] = []
    const push = (event: AgentEvent): void => {
      queue.push(event)
      notify?.()
      notify = null
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index !== -1) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line.trim().length > 0) {
          for (const event of mapLine(line)) push(event)
        }
        index = buffer.indexOf('\n')
      }
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      options.stderrLog?.(chunk)
      stderrTail.push(chunk)
      while (stderrTail.length > 8) stderrTail.shift()
    })

    void new Promise<number | null>((resolve) => {
      child.on('close', (code) => resolve(code))
    }).then((code) => {
      closed = true
      if (code !== 0 && code !== null) {
        const tail = stderrTail.join('').trim().split('\n').slice(-4).join('\n')
        push({
          type: 'error',
          message:
            `${options.label} exited with code ${code}` +
            (tail.length > 0 ? `\n${tail}` : ''),
          rawJson: null,
        })
      }
      push({ type: 'done' })
      notify?.()
      notify = null
    })

    while (true) {
      while (queue.length > 0) {
        const event = queue.shift()
        if (event) yield event
        if (event?.type === 'done') return
      }
      if (closed && queue.length === 0) return
      await new Promise<void>((resolve) => {
        notify = resolve
        // Re-check after subscribing to avoid missed-notification races.
        if (queue.length > 0 || closed) resolve()
      })
    }
  }

  return generate()
}

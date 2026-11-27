import type { AgentEvent } from '@ari/contracts/agent-event'
import { PiMessageMapper } from './mapper'
import type { PiRecord } from './rpc-connection'

/** agent_end is a low-level boundary. Only agent_settled completes a native RPC turn. */
export class PiRpcMapper {
  readonly #messages = new PiMessageMapper()
  readonly #visibleText = new Set<string | undefined>()
  #hadTool = false
  #error: string | null = null

  map(record: PiRecord): AgentEvent[] {
    if (record.type === 'agent_settled') {
      const stopped = record.aborted === true
      const output = this.#hadTool || this.#visibleText.size > 0
      const error = stopped
        ? null
        : (this.#error ?? (output ? null : 'Pi completed without assistant output or tool calls.'))
      return [
        ...(error ? [{ type: 'error' as const, message: error, rawJson: null }] : []),
        { type: 'done', stopReason: stopped ? 'interrupted' : error ? 'error' : 'completed' },
      ]
    }
    if (record.type === 'message_end') {
      const message = record.message as
        { role?: string; stopReason?: string; errorMessage?: string } | undefined
      if (message?.role === 'assistant')
        this.#error =
          message.stopReason === 'error'
            ? message.errorMessage || 'Pi model request failed without an error message.'
            : null
    }
    if (record.type === 'auto_retry_start')
      return [
        {
          type: 'notice',
          message: `Pi retrying: ${typeof record.errorMessage === 'string' ? record.errorMessage : 'provider request failed'}`,
        },
      ]
    if (record.type === 'auto_retry_end' && record.success === false)
      this.#error =
        typeof record.finalError === 'string' ? record.finalError : 'Pi exhausted its retries.'
    if (
      record.type === 'auto_compaction_end' &&
      record.aborted !== true &&
      typeof record.errorMessage === 'string'
    )
      this.#error ??= record.errorMessage
    const events = this.#messages
      .map(record)
      .filter((event) => event.type !== 'done' && event.type !== 'error')
    for (const event of events) {
      if (event.type === 'text-delta') {
        if (event.text.trim()) this.#visibleText.add(event.streamId)
        else if (event.replace) this.#visibleText.delete(event.streamId)
      }
      if (event.type === 'tool-started') this.#hadTool = true
    }
    return events
  }
}

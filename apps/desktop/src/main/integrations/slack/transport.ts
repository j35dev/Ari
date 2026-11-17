import { SocketModeClient, LogLevel, type Logger } from '@slack/socket-mode'
import { WebClient, WebAPIPlatformError, WebAPIRateLimitedError } from '@slack/web-api'

export interface SlackPlainText {
  type: 'plain_text'
  text: string
  emoji?: boolean
}
export type SlackBlock =
  | { type: 'section'; text: SlackPlainText }
  | {
      type: 'actions'
      elements: { type: 'button'; text: SlackPlainText; action_id: string; value: string }[]
    }
export interface SlackReply {
  text: string
  blocks?: SlackBlock[]
}
export interface SlackModal {
  type: 'modal'
  callback_id: 'ari_question'
  private_metadata: string
  title: SlackPlainText
  submit: SlackPlainText
  close: SlackPlainText
  blocks: {
    type: 'input'
    block_id: string
    label: SlackPlainText
    optional?: boolean
    element:
      | { type: 'plain_text_input'; action_id: 'answer'; multiline: boolean; max_length: number }
      | {
          type: 'static_select' | 'multi_static_select'
          action_id: 'answer'
          options: { text: SlackPlainText; value: string }[]
        }
  }[]
}
export interface SlackEnvelope {
  type: string
  body: unknown
  envelopeId: string
}
export interface SlackIdentity {
  workspaceId: string
  workspaceName: string
  botUserId: string
  appId: string | null
}
export interface SlackTransport {
  identity(): Promise<SlackIdentity>
  start(
    onEnvelope: (envelope: SlackEnvelope) => Promise<unknown>,
    onState: (state: 'connected' | 'reconnecting' | 'error') => void,
  ): Promise<void>
  post(channel: string, thread: string, reply: SlackReply): Promise<string>
  update(channel: string, messageTs: string, reply: SlackReply): Promise<string>
  openModal(triggerId: string, modal: SlackModal): Promise<void>
  close(): Promise<void>
}

export class SlackTransportError extends Error {
  constructor(
    readonly kind: 'rejected' | 'uncertain' | 'rate_limit',
    message: string,
    readonly retryAfter = 0,
  ) {
    super(message)
  }
}

// SDK debug and error logs can contain full payloads and authentication details.
// Ari exposes only bounded, purpose-specific errors from the wrapper below.
const quietLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  setLevel: () => undefined,
  setName: () => undefined,
  getLevel: () => LogLevel.ERROR,
}

function transportError(error: unknown): SlackTransportError {
  if (error instanceof WebAPIRateLimitedError)
    return new SlackTransportError(
      'rate_limit',
      'Slack asked Ari to wait before posting.',
      error.retryAfter,
    )
  if (error instanceof WebAPIPlatformError)
    return new SlackTransportError(
      'rejected',
      'Slack refused the request. Check the tokens, scopes and bot channel membership.',
    )
  return new SlackTransportError(
    'uncertain',
    'Slack did not confirm the request. Its outcome needs inspection.',
  )
}

function fallbackText(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .slice(0, 12_000)
}

/** Official SDK transport, with application-controlled ACKs and no mutation retries. */
export function createSlackTransport(botToken: string, appToken: string): SlackTransport {
  const options = {
    logger: quietLogger,
    retryConfig: { retries: 0 },
    timeout: 10_000,
    rejectRateLimitedCalls: true,
  }
  const web = new WebClient(botToken, options)
  const socket = new SocketModeClient({
    appToken,
    logger: quietLogger,
    autoReconnectEnabled: true,
    clientOptions: { retryConfig: { retries: 0 }, timeout: 10_000 },
  })
  let closed = false
  return {
    async identity() {
      try {
        const result = await web.auth.test()
        if (!result.ok || !result.team_id || !result.user_id || !result.bot_id)
          throw new SlackTransportError(
            'rejected',
            'Use the installed app’s bot OAuth token, starting with xoxb-.',
          )
        return {
          workspaceId: result.team_id,
          workspaceName: result.team ?? 'Slack workspace',
          botUserId: result.user_id,
          appId: result.app_id ?? null,
        }
      } catch (error) {
        throw error instanceof SlackTransportError ? error : transportError(error)
      }
    },
    async start(onEnvelope, onState) {
      socket.on('connected', () => {
        if (!closed) onState('connected')
      })
      socket.on('reconnecting', () => {
        if (!closed) onState('reconnecting')
      })
      socket.on('disconnected', () => {
        if (!closed) onState('reconnecting')
      })
      socket.on('error', () => {
        if (!closed) onState('error')
      })
      socket.on(
        'slack_event',
        (event: {
          type: string
          body: unknown
          envelope_id: string
          ack: (payload?: unknown) => Promise<void>
        }) => {
          if (closed) return
          void onEnvelope({ type: event.type, body: event.body, envelopeId: event.envelope_id })
            .then((payload) => event.ack(payload))
            .catch(() => {
              if (!closed) onState('error')
            })
        },
      )
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          socket.start(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new SlackTransportError(
                    'rejected',
                    'The Slack connection timed out. Check the app token and Socket Mode.',
                  ),
                ),
              20_000,
            )
            timer.unref()
          }),
        ])
      } catch (error) {
        await socket.disconnect().catch(() => undefined)
        throw error instanceof SlackTransportError ? error : transportError(error)
      } finally {
        if (timer) clearTimeout(timer)
      }
    },
    async post(channel, thread, reply) {
      if (closed) throw new SlackTransportError('rejected', 'The Slack connection is closed.')
      try {
        const result = await web.chat.postMessage({
          channel,
          thread_ts: thread,
          text: fallbackText(reply.text),
          blocks: reply.blocks,
          mrkdwn: false,
          parse: 'none',
          unfurl_links: false,
          unfurl_media: false,
        })
        if (!result.ok || !result.ts)
          throw new SlackTransportError('uncertain', 'Slack did not return a message receipt.')
        return result.ts
      } catch (error) {
        throw error instanceof SlackTransportError ? error : transportError(error)
      }
    },
    async openModal(triggerId, modal) {
      try {
        await web.views.open({ trigger_id: triggerId, view: modal })
      } catch (error) {
        throw transportError(error)
      }
    },
    async update(channel, messageTs, reply) {
      if (closed) throw new SlackTransportError('rejected', 'The Slack connection is closed.')
      try {
        const result = await web.chat.update({
          channel,
          ts: messageTs,
          text: fallbackText(reply.text),
          blocks: reply.blocks ?? [],
          parse: 'none',
        })
        if (!result.ok)
          throw new SlackTransportError('uncertain', 'Slack did not confirm the status update.')
        return result.ts ?? messageTs
      } catch (error) {
        throw error instanceof SlackTransportError ? error : transportError(error)
      }
    },
    async close() {
      closed = true
      await socket.disconnect()
      socket.removeAllListeners()
    },
  }
}

import { z } from 'zod'
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { externalRequestSchema } from '@ari/contracts/external'
import { slackRouteSchema, slackUserIdSchema } from '@ari/contracts/slack'
import { permissionModeSchema } from '@ari/contracts/common'

const id = z.string().min(1).max(300)
const connectionSchema = z
  .object({
    id,
    workspaceId: id,
    workspaceName: z.string().max(200),
    botUserId: id,
    appId: id.nullable(),
    ownerUserId: slackUserIdSchema,
    permissionMode: permissionModeSchema,
    routes: z.array(slackRouteSchema).max(32),
  })
  .strict()
const bindingSchema = z
  .object({
    key: id,
    sessionId: id,
    projectId: id,
    ownerId: id,
    connectorId: id,
    workspaceId: id,
    channelId: id,
    threadId: id,
    creationRequestId: id,
    state: z.enum(['reserved', 'ready', 'unavailable']),
    lastResultTurnId: id.nullable(),
    lastStatus: z.string().max(200).nullable(),
    progressMessageTs: id.nullable(),
    notifications: z.array(id).max(200),
    cursor: z.number().int().min(-1),
  })
  .strict()
const requestSchema = z
  .object({
    request: externalRequestSchema,
    fingerprint: id,
    revision: z.number().int().nonnegative(),
    phase: z.enum([
      'received',
      'creating',
      'created',
      'submitting',
      'completed',
      'failed',
      'uncertain',
    ]),
    sessionId: id.nullable(),
    kind: z.enum(['message', 'callback', 'open-question']),
    callbackId: id.nullable(),
    value: z.string().max(64_000).nullable(),
    triggerId: z.string().max(300).nullable(),
    error: z.string().max(2000).nullable(),
    at: z.number().int().nonnegative(),
  })
  .strict()
const callbackSchema = z
  .object({
    id,
    bindingKey: id,
    revision: z.number().int().nonnegative(),
    sessionId: id,
    turnId: id,
    requestId: id,
    kind: z.enum(['approval', 'input']),
    value: z.string().max(32_000).nullable(),
    prompt: z.string().max(16_000),
    choicesJson: z.string().max(256_000).nullable(),
    at: z.number().int().nonnegative(),
  })
  .strict()
const plain = z
  .object({
    type: z.literal('plain_text'),
    text: z.string().max(3000),
    emoji: z.boolean().optional(),
  })
  .strict()
const replySchema = z
  .object({
    text: z.string().max(12_000),
    blocks: z
      .array(
        z.discriminatedUnion('type', [
          z.object({ type: z.literal('section'), text: plain }).strict(),
          z
            .object({
              type: z.literal('actions'),
              elements: z
                .array(
                  z
                    .object({
                      type: z.literal('button'),
                      text: plain,
                      action_id: id,
                      value: z.string().max(2000),
                    })
                    .strict(),
                )
                .max(5),
            })
            .strict(),
        ]),
      )
      .max(50)
      .optional(),
  })
  .strict()
const outboxSchema = z
  .object({
    id,
    bindingKey: id.nullable(),
    projectId: id,
    connectorId: id,
    ownerId: id,
    revision: z.number().int().nonnegative(),
    channelId: id,
    threadId: id,
    reply: replySchema,
    purpose: z.enum(['message', 'progress', 'result']),
    turnId: id.nullable(),
    state: z.enum(['pending', 'sending', 'sent', 'uncertain', 'failed', 'cancelled']),
    messageTs: id.nullable(),
    retryAt: z.number().int().nonnegative(),
    at: z.number().int().nonnegative(),
  })
  .strict()
const boundedRecords = <T extends z.ZodType>(schema: T, max: number) =>
  z
    .record(z.string(), schema)
    .refine((value) => Object.keys(value).length <= max, 'Slack pilot history capacity exceeded.')

export const slackStateSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative(),
    enabled: z.boolean(),
    connection: connectionSchema.nullable(),
    secrets: z
      .object({ bot: z.string().max(16_000), app: z.string().max(16_000) })
      .strict()
      .nullable(),
    bindings: boundedRecords(bindingSchema, 200),
    requests: boundedRecords(requestSchema, 1000),
    callbacks: boundedRecords(callbackSchema, 2000),
    outbox: boundedRecords(outboxSchema, 4000),
  })
  .strict()
export type SlackState = z.infer<typeof slackStateSchema>
export type SlackBinding = z.infer<typeof bindingSchema>
export type SlackStoredRequest = z.infer<typeof requestSchema>
export type SlackCallback = z.infer<typeof callbackSchema>
export type SlackOutbound = z.infer<typeof outboxSchema>

export function emptySlackState(): SlackState {
  return {
    version: 1,
    revision: 0,
    enabled: false,
    connection: null,
    secrets: null,
    bindings: {},
    requests: {},
    callbacks: {},
    outbox: {},
  }
}

/** Flushed, atomic snapshots. A failed write leaves the prior in-memory and disk state intact. */
export class SlackStore {
  #state = emptySlackState()
  #writes: Promise<unknown> = Promise.resolve()
  #loaded = false
  constructor(readonly path: string) {}
  get state(): Readonly<SlackState> {
    return this.#state
  }
  async load(): Promise<void> {
    if (this.#loaded) return
    try {
      if ((await stat(this.path)).size > 64 * 1024 * 1024)
        throw new Error('Slack history is too large.')
      this.#state = slackStateSchema.parse(JSON.parse(await readFile(this.path, 'utf8')))
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
        throw new Error(
          'Slack connection records could not be read. Forget this connection explicitly before setting it up again.',
          { cause: error },
        )
    }
    this.#loaded = true
  }
  update(mutator: (draft: SlackState) => void): Promise<void> {
    const operation = this.#writes
      .catch(() => undefined)
      .then(async () => {
        if (!this.#loaded) throw new Error('Slack records are unavailable.')
        const next = structuredClone(this.#state)
        mutator(next)
        const validated = slackStateSchema.parse(next)
        await this.#save(validated)
        this.#state = validated
      })
    this.#writes = operation
    return operation
  }
  async reset(): Promise<void> {
    const operation = this.#writes
      .catch(() => undefined)
      .then(async () => {
        await this.#save(emptySlackState())
        this.#state = emptySlackState()
        this.#loaded = true
      })
    this.#writes = operation
    await operation
  }
  async #save(state: SlackState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    const file = await open(temporary, 'wx', 0o600)
    try {
      try {
        await file.writeFile(JSON.stringify(state), 'utf8')
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(temporary, this.path)
    } finally {
      await unlink(temporary).catch(() => undefined)
    }
  }
}

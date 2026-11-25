import type { PermissionMode } from '@ari/contracts/common'
import type { QuestionItem } from '../acp/client-requests'
import type { CatalogModel } from '../catalogs'
import { OcHttpError } from './http'
import type { OcHttp } from './http'
import type {
  OcCatalog,
  OcEvent,
  OcPermissionReply,
  OcPromptInput,
  OcQuestionShape,
  OpencodeWire,
} from './wire'
import {
  asRecord,
  contextHint,
  encodeId,
  num,
  permissionRules,
  str,
  tokensOf,
  variantLabel,
} from './wire'

/**
 * Classic OpenCode (1.x) server. Events come from `/global/event`, which
 * carries every project directory's instance on one stream: `/event` only
 * reports the directory it was opened for. Text streams as
 * `message.part.delta`; everything else as whole-part `message.part.updated`.
 */
export class WireV1 implements OpencodeWire {
  readonly generation = 'v1' as const
  readonly eventPath = '/global/event'
  /** Part kinds by id: deltas name only the part, not whether it is reasoning. */
  readonly #parts = new Map<string, 'text' | 'reasoning'>()

  constructor(private readonly http: OcHttp) {}

  normalize(raw: unknown): OcEvent[] {
    const envelope = asRecord(raw)
    const event = asRecord(envelope?.['payload']) ?? envelope
    const type = str(event?.['type'])
    const props = asRecord(event?.['properties']) ?? {}
    const sessionID = str(props['sessionID']) ?? ''
    switch (type) {
      case 'session.created':
      case 'session.updated': {
        const info = asRecord(props['info']) ?? {}
        const id = str(info['id'])
        if (!id) return []
        const parentID = str(info['parentID'])
        const title = str(info['title'])
        return [
          {
            type: 'session',
            sessionID: id,
            ...(parentID ? { parentID } : {}),
            ...(title ? { title } : {}),
          },
        ]
      }
      case 'message.part.delta': {
        const partID = str(props['partID'])
        const delta = str(props['delta'])
        if (!partID || !delta || props['field'] !== 'text') return []
        return [{ type: this.#parts.get(partID) ?? 'text', sessionID, partID, delta }]
      }
      case 'message.part.updated':
        return this.#part(asRecord(props['part']) ?? {})
      case 'session.status': {
        const status = asRecord(props['status']) ?? {}
        if (status['type'] === 'busy') return sessionID ? [{ type: 'busy', sessionID }] : []
        if (status['type'] !== 'retry') return []
        return [
          {
            type: 'retry',
            sessionID,
            attempt: num(status['attempt']),
            message: str(status['message']) ?? 'Retrying',
          },
        ]
      }
      case 'session.idle':
        return sessionID ? [{ type: 'idle', sessionID, outcome: 'completed' }] : []
      case 'session.error': {
        const error = asRecord(props['error']) ?? {}
        // An abort is the interrupt Ari asked for; the idle after it ends the turn.
        if (str(error['name']) === 'MessageAbortedError') return []
        const data = asRecord(error['data']) ?? {}
        const message = str(data['message']) ?? str(error['name']) ?? 'OpenCode error'
        return [{ type: 'error', ...(sessionID ? { sessionID } : {}), message }]
      }
      case 'permission.asked': {
        const id = str(props['id'])
        if (!id) return []
        const tool = asRecord(props['tool'])
        const callID = str(tool?.['callID'])
        return [
          {
            type: 'permission',
            id,
            sessionID,
            action: str(props['permission']) ?? 'permission',
            resources: Array.isArray(props['patterns'])
              ? props['patterns'].filter((p): p is string => typeof p === 'string')
              : [],
            ...(props['metadata'] !== undefined ? { metadata: props['metadata'] } : {}),
            ...(callID ? { callID } : {}),
          },
        ]
      }
      case 'question.asked': {
        const id = str(props['id'])
        if (!id) return []
        const questions = questionsV1(props['questions'])
        return [
          {
            type: 'question',
            id,
            sessionID,
            prompt: questions.map((q) => q.question).join('\n'),
            questions,
            shape: { kind: 'v1' },
          },
        ]
      }
      default:
        return []
    }
  }

  #part(part: Record<string, unknown>): OcEvent[] {
    const sessionID = str(part['sessionID']) ?? ''
    const partID = str(part['id']) ?? ''
    switch (part['type']) {
      case 'text':
      case 'reasoning': {
        const kind = part['type']
        if (part['synthetic'] === true || part['ignored'] === true) return []
        const time = asRecord(part['time'])
        if (time?.['end'] !== undefined) this.#parts.delete(partID)
        else this.#parts.set(partID, kind)
        const text = str(part['text']) ?? ''
        return [{ type: kind, sessionID, partID, text }]
      }
      case 'tool': {
        const state = asRecord(part['state']) ?? {}
        const status = str(state['status'])
        const callID = str(part['callID'])
        if (
          !callID ||
          (status !== 'pending' &&
            status !== 'running' &&
            status !== 'completed' &&
            status !== 'error')
        )
          return []
        const output = str(state['output'])
        const error = str(state['error'])
        return [
          {
            type: 'tool',
            sessionID,
            callID,
            name: str(part['tool']) ?? 'tool',
            status,
            input: state['input'] ?? {},
            ...(output !== undefined ? { output } : {}),
            ...(error !== undefined ? { error } : {}),
          },
        ]
      }
      case 'step-finish':
        return [
          {
            type: 'usage',
            sessionID,
            tokens: tokensOf(part['tokens']),
            cost: typeof part['cost'] === 'number' ? part['cost'] : null,
          },
        ]
      default:
        return []
    }
  }

  #rules(mode: PermissionMode) {
    return permissionRules(mode, 'bash').map((rule) => ({
      permission: rule.action,
      pattern: '*',
      action: rule.effect,
    }))
  }

  async createSession(directory: string, mode: PermissionMode): Promise<string> {
    const created = await this.http.request<{ id?: unknown }>('POST', '/session', {
      directory,
      body: { permission: this.#rules(mode) },
    })
    const id = str(asRecord(created)?.['id'])
    if (!id) throw new Error('OpenCode did not return a session id.')
    return id
  }

  async sessionExists(sessionID: string, directory: string): Promise<boolean> {
    try {
      await this.http.request('GET', `/session/${encodeId(sessionID)}`, { directory })
      return true
    } catch (error) {
      if (error instanceof OcHttpError && (error.status === 404 || error.status === 400))
        return false
      throw error
    }
  }

  async setPermissions(sessionID: string, directory: string, mode: PermissionMode): Promise<void> {
    await this.http.request('PATCH', `/session/${encodeId(sessionID)}`, {
      directory,
      body: { permission: this.#rules(mode) },
    })
  }

  #promptBody(input: OcPromptInput) {
    return {
      parts: [
        { type: 'text', text: input.text },
        ...input.files.map((file) => ({
          type: 'file',
          mime: file.mime,
          url: file.url,
          filename: file.name,
        })),
      ],
      ...(input.model ? { model: input.model } : {}),
      ...(input.variant ? { variant: input.variant } : {}),
    }
  }

  async prompt(sessionID: string, directory: string, input: OcPromptInput): Promise<void> {
    await this.http.request('POST', `/session/${encodeId(sessionID)}/prompt_async`, {
      directory,
      body: this.#promptBody(input),
    })
  }

  /**
   * The classic server queues a prompt sent while it works and answers it
   * before going idle, so a steer lands as a follow-up inside the same turn.
   */
  async steer(sessionID: string, directory: string, input: OcPromptInput): Promise<void> {
    await this.prompt(sessionID, directory, input)
  }

  async interrupt(sessionID: string, directory: string): Promise<void> {
    await this.http.request('POST', `/session/${encodeId(sessionID)}/abort`, { directory })
  }

  async replyPermission(
    _sessionID: string,
    requestID: string,
    directory: string,
    reply: OcPermissionReply,
  ): Promise<void> {
    await this.http.request('POST', `/permission/${encodeId(requestID)}/reply`, {
      directory,
      body: { reply },
    })
  }

  async replyQuestion(
    _sessionID: string,
    requestID: string,
    directory: string,
    _shape: OcQuestionShape,
    questions: QuestionItem[],
    answers: Record<string, string | string[]>,
  ): Promise<void> {
    await this.http.request('POST', `/question/${encodeId(requestID)}/reply`, {
      directory,
      body: { answers: answersV1(questions, answers) },
    })
  }

  async rejectQuestion(_sessionID: string, requestID: string, directory: string): Promise<void> {
    await this.http.request('POST', `/question/${encodeId(requestID)}/reject`, { directory })
  }

  async commands(directory: string) {
    const list = await this.http.request<unknown>('GET', '/command', { directory })
    return commandList(list)
  }

  async command(
    sessionID: string,
    directory: string,
    name: string,
    args: string,
    input: OcPromptInput,
  ): Promise<void> {
    await this.http.request('POST', `/session/${encodeId(sessionID)}/command`, {
      directory,
      body: {
        command: name,
        arguments: args,
        ...(input.model ? { model: `${input.model.providerID}/${input.model.modelID}` } : {}),
        ...(input.variant ? { variant: input.variant } : {}),
        ...(input.files.length > 0
          ? {
              parts: input.files.map((file) => ({
                type: 'file',
                mime: file.mime,
                url: file.url,
                filename: file.name,
              })),
            }
          : {}),
      },
      // The classic server answers once the command's reply is complete.
      timeoutMs: 24 * 60 * 60_000,
    })
  }

  async catalog(directory: string): Promise<OcCatalog> {
    const [providers, config] = await Promise.all([
      this.http.request<unknown>('GET', '/config/providers', { directory }),
      this.http.request<unknown>('GET', '/config', { directory }).catch(() => null),
    ])
    const list = asRecord(providers)?.['providers']
    const models: CatalogModel[] = []
    for (const provider of Array.isArray(list) ? list : []) {
      const p = asRecord(provider)
      const providerID = str(p?.['id'])
      if (!p || !providerID) continue
      const providerName = str(p['name']) ?? providerID
      const entries = Object.values(asRecord(p['models']) ?? {})
        .map((model) => asRecord(model))
        .filter((model): model is Record<string, unknown> => model !== null)
        .sort((a, b) => (str(a['name']) ?? '').localeCompare(str(b['name']) ?? ''))
      for (const model of entries) {
        const modelID = str(model['id'])
        if (!modelID) continue
        const variants = Object.keys(asRecord(model['variants']) ?? {})
        models.push(
          catalogModel(
            `${providerID}/${modelID}`,
            `${providerName}/${str(model['name']) ?? modelID}`,
            num(asRecord(model['limit'])?.['context']),
            variants,
            str(model['family']),
          ),
        )
      }
    }
    const defaultModel = str(asRecord(config)?.['model'])
    return { models, defaultModelId: defaultModel ?? null }
  }
}

/** One catalog row; variants become the model's effort levels, as OpenCode's ACP shows them. */
export function catalogModel(
  id: string,
  label: string,
  context: number,
  variants: string[],
  family?: string,
): CatalogModel {
  const levels = [...new Set([...variants.filter((v) => v !== 'default'), 'default'])]
  const hint = contextHint(context)
  return {
    id,
    label,
    ...(hint ? { contextHint: hint } : {}),
    ...(family ? { family } : {}),
    ...(variants.length > 0
      ? {
          efforts: levels.map((level) => ({
            id: level,
            label: variantLabel(level),
            ...(level === 'default' ? { current: true } : {}),
          })),
          effortsSource: 'agent' as const,
        }
      : { efforts: [], effortsSource: 'agent' as const }),
  }
}

/** `[{ name, description, source }]`, bare or wrapped in `data`. */
export function commandList(
  raw: unknown,
): { name: string; description: string; source?: string }[] {
  const list = Array.isArray(raw) ? raw : asRecord(raw)?.['data']
  return (Array.isArray(list) ? list : []).flatMap((item) => {
    const command = asRecord(item)
    const name = str(command?.['name'])
    if (!name) return []
    const source = str(command?.['source'])
    return [
      { name, description: str(command?.['description']) ?? '', ...(source ? { source } : {}) },
    ]
  })
}

export function questionsV1(raw: unknown): QuestionItem[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item, index) => {
    const q = asRecord(item)
    if (!q) return []
    const question = str(q['question']) ?? str(q['header']) ?? `Question ${index + 1}`
    const header = str(q['header'])
    const options = Array.isArray(q['options']) ? q['options'] : []
    return [
      {
        id: String(index),
        question,
        ...(header && header !== question ? { header } : {}),
        options: options.flatMap((option, i) => {
          const o = asRecord(option)
          const label = str(o?.['label'])
          if (!label) return []
          const description = str(o?.['description'])
          return [{ id: `opt-${i}`, label, ...(description ? { description } : {}) }]
        }),
        multiSelect: q['multiple'] === true,
      },
    ]
  })
}

/** The classic reply: one list of picked labels per question, in question order. */
export function answersV1(
  questions: QuestionItem[],
  answers: Record<string, string | string[]>,
): string[][] {
  return questions.map((question) => {
    const answer = answers[question.id] ?? answers[question.question]
    if (answer === undefined) return []
    return (Array.isArray(answer) ? answer : [answer]).filter((value) => value.length > 0)
  })
}

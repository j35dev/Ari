import type { PermissionMode } from '@ari/contracts/common'
import type { QuestionItem } from '../acp/client-requests'
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
  ADMISSION_TIMEOUT_MS,
  asRecord,
  encodeId,
  num,
  permissionRules,
  str,
  tokensOf,
} from './wire'
import { catalogModel, commandList } from './wire-v1'

type FieldType = Extract<OcQuestionShape, { kind: 'v2' }>['fields'][string]

/**
 * OpenCode 2 server (`/api/*`). One global `/api/event` stream carries every
 * location's sessions as `{ type, data }`. Text, reasoning and tools stream as
 * `session.*` events keyed by assistant message and ordinal; a turn ends with
 * `session.execution.{succeeded,failed,interrupted}`.
 */
export class WireV2 implements OpencodeWire {
  readonly generation = 'v2' as const
  readonly eventPath = '/api/event'
  /** Tool names arrive on `input.started`; later tool events carry only the id. */
  readonly #toolNames = new Map<string, string>()

  constructor(
    private readonly http: OcHttp,
    /** The model snapshot can be empty until plugins settle after start; one retry waits this long. */
    private readonly catalogRetryMs = 3000,
  ) {}

  normalize(raw: unknown): OcEvent[] {
    const event = asRecord(raw)
    const type = str(event?.['type'])
    const data = asRecord(event?.['data']) ?? {}
    const sessionID = str(data['sessionID']) ?? ''
    const part = () => `${str(data['assistantMessageID']) ?? ''}:${num(data['ordinal'])}`
    switch (type) {
      case 'session.created': {
        if (!sessionID) return []
        const parentID = str(data['parentID'])
        const title = str(data['title'])
        const agent = str(data['agent'])
        return [
          {
            type: 'session',
            sessionID,
            ...(parentID ? { parentID } : {}),
            ...(title ? { title } : {}),
            ...(agent ? { agent } : {}),
          },
        ]
      }
      case 'session.text.delta':
      case 'session.reasoning.delta': {
        const delta = str(data['delta'])
        if (!delta) return []
        return [
          {
            type: type === 'session.text.delta' ? 'text' : 'reasoning',
            sessionID,
            partID: part(),
            delta,
          },
        ]
      }
      case 'session.text.ended':
      case 'session.reasoning.ended':
        return [
          {
            type: type === 'session.text.ended' ? 'text' : 'reasoning',
            sessionID,
            partID: part(),
            text: str(data['text']) ?? '',
          },
        ]
      case 'session.tool.input.started': {
        const id = str(data['id'])
        const name = str(data['name'])
        if (!id) return []
        if (name) this.#toolNames.set(id, name)
        return [
          { type: 'tool', sessionID, callID: id, ...(name ? { name } : {}), status: 'pending' },
        ]
      }
      case 'session.tool.called': {
        const id = str(data['id'])
        if (!id) return []
        const name = this.#toolNames.get(id) ?? str(data['name'])
        return [
          {
            type: 'tool',
            sessionID,
            callID: id,
            ...(name ? { name } : {}),
            status: 'running',
            input: data['input'] ?? {},
          },
        ]
      }
      case 'session.tool.success':
      case 'session.tool.failed': {
        const id = str(data['id'])
        if (!id) return []
        const name = this.#toolNames.get(id)
        this.#toolNames.delete(id)
        const content = Array.isArray(data['content']) ? data['content'] : []
        const text = content
          .map((item) => asRecord(item))
          .filter((item) => item?.['type'] === 'text')
          .map((item) => str(item?.['text']) ?? '')
          .join('\n')
        const files = content.flatMap((item) => {
          const file = asRecord(item)
          const uri = str(file?.['uri'])
          const mime = str(file?.['mime'])
          return file?.['type'] === 'file' && uri && mime
            ? [{ uri, mime, name: str(file['name']) ?? null }]
            : []
        })
        const failed = type === 'session.tool.failed'
        return [
          {
            type: 'tool',
            sessionID,
            callID: id,
            ...(name ? { name } : {}),
            status: failed ? 'error' : 'completed',
            output: text,
            ...(failed
              ? { error: str(asRecord(data['error'])?.['message']) ?? (text || 'Tool failed') }
              : {}),
            ...(files.length > 0 ? { files } : {}),
          },
        ]
      }
      case 'session.step.ended':
        return [
          {
            type: 'usage',
            sessionID,
            tokens: tokensOf(data['tokens']),
            cost: typeof data['cost'] === 'number' ? data['cost'] : null,
          },
        ]
      case 'session.status': {
        const status = asRecord(data['status']) ?? {}
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
      case 'session.execution.started':
        return sessionID ? [{ type: 'busy', sessionID }] : []
      case 'session.execution.succeeded':
        return [{ type: 'idle', sessionID, outcome: 'completed' }]
      case 'session.execution.interrupted':
        return [{ type: 'idle', sessionID, outcome: 'interrupted' }]
      case 'session.execution.failed': {
        const error = asRecord(data['error'])
        return [
          {
            type: 'idle',
            sessionID,
            outcome: 'error',
            error: str(error?.['message']) ?? str(error?.['type']) ?? 'OpenCode run failed',
          },
        ]
      }
      case 'permission.asked': {
        const id = str(data['id'])
        if (!id) return []
        const callID = str(asRecord(data['source'])?.['id'])
        return [
          {
            type: 'permission',
            id,
            sessionID,
            action: str(data['action']) ?? 'permission',
            resources: Array.isArray(data['resources'])
              ? data['resources'].filter((r): r is string => typeof r === 'string')
              : [],
            ...(data['metadata'] !== undefined ? { metadata: data['metadata'] } : {}),
            ...(callID ? { callID } : {}),
          },
        ]
      }
      case 'form.created': {
        const form = asRecord(data['form']) ?? {}
        const id = str(form['id'])
        const formSession = str(form['sessionID'])
        if (!id || !formSession) return []
        const { questions, fields } = questionsV2(form['fields'])
        if (questions.length === 0) return []
        const title = str(form['title'])
        return [
          {
            type: 'question',
            id,
            sessionID: formSession,
            prompt: title ?? questions.map((q) => q.question).join('\n'),
            questions,
            shape: { kind: 'v2', fields },
          },
        ]
      }
      default:
        return []
    }
  }

  #rules(mode: PermissionMode) {
    return permissionRules(mode, 'shell').map((rule) => ({
      action: rule.action,
      resource: '*',
      effect: rule.effect,
    }))
  }

  async createSession(directory: string, mode: PermissionMode) {
    const created = await this.http.request<unknown>('POST', '/api/session', {
      directory,
      body: { location: { directory }, permissions: this.#rules(mode) },
    })
    const info = asRecord(asRecord(created)?.['data'])
    const id = str(info?.['id'])
    if (!id) throw new Error('OpenCode did not return a session id.')
    // A server that stored the rules reports them back on the session; one that
    // predates session rules drops the field without complaint.
    return { id, rulesApplied: Array.isArray(info?.['permissions']) }
  }

  async deleteSession(sessionID: string, directory: string): Promise<void> {
    await this.http.request('DELETE', `/api/session/${encodeId(sessionID)}`, { directory })
  }

  async sessionExists(sessionID: string, directory: string): Promise<boolean> {
    try {
      await this.http.request('GET', `/api/session/${encodeId(sessionID)}`, { directory })
      return true
    } catch (error) {
      if (error instanceof OcHttpError && (error.status === 404 || error.status === 400))
        return false
      throw error
    }
  }

  async setPermissions(sessionID: string, directory: string, mode: PermissionMode): Promise<void> {
    await this.http.request('PATCH', `/api/session/${encodeId(sessionID)}`, {
      directory,
      body: { permissions: this.#rules(mode) },
    })
  }

  async setEnvironment(
    sessionID: string,
    directory: string,
    env: Record<string, string>,
  ): Promise<void> {
    await this.http.request('PUT', `/api/session/${encodeId(sessionID)}/environment`, {
      directory,
      body: { variables: env },
    })
  }

  async #model(sessionID: string, directory: string, input: OcPromptInput) {
    if (!input.model) return
    await this.http.request('POST', `/api/session/${encodeId(sessionID)}/model`, {
      directory,
      timeoutMs: ADMISSION_TIMEOUT_MS,
      body: {
        model: {
          id: input.model.modelID,
          providerID: input.model.providerID,
          ...(input.variant ? { variant: input.variant } : {}),
        },
      },
    })
  }

  async #send(sessionID: string, directory: string, input: OcPromptInput, steer: boolean) {
    if (!steer) await this.#model(sessionID, directory, input)
    await this.http.request('POST', `/api/session/${encodeId(sessionID)}/prompt`, {
      directory,
      timeoutMs: ADMISSION_TIMEOUT_MS,
      body: {
        text: input.text,
        ...(input.files.length > 0
          ? { files: input.files.map((file) => ({ uri: file.url, name: file.name })) }
          : {}),
        delivery: 'steer',
      },
    })
  }

  prompt(sessionID: string, directory: string, input: OcPromptInput): Promise<void> {
    return this.#send(sessionID, directory, input, false)
  }

  /** `steer` delivery lands before the agent's next model call, even mid-work. */
  steer(sessionID: string, directory: string, input: OcPromptInput): Promise<void> {
    return this.#send(sessionID, directory, input, true)
  }

  async interrupt(sessionID: string, directory: string): Promise<void> {
    await this.http.request('POST', `/api/session/${encodeId(sessionID)}/interrupt`, { directory })
  }

  async replyPermission(
    sessionID: string,
    requestID: string,
    directory: string,
    reply: OcPermissionReply,
  ): Promise<void> {
    await this.http.request(
      'POST',
      `/api/session/${encodeId(sessionID)}/permission/${encodeId(requestID)}/reply`,
      { directory, body: { decision: reply } },
    )
  }

  async replyQuestion(
    sessionID: string,
    requestID: string,
    directory: string,
    shape: OcQuestionShape,
    questions: QuestionItem[],
    answers: Record<string, string | string[]>,
  ): Promise<void> {
    await this.http.request(
      'POST',
      `/api/session/${encodeId(sessionID)}/form/${encodeId(requestID)}/reply`,
      { directory, body: { answer: answersV2(shape, questions, answers) } },
    )
  }

  async rejectQuestion(sessionID: string, requestID: string, directory: string): Promise<void> {
    await this.http.request(
      'DELETE',
      `/api/session/${encodeId(sessionID)}/form/${encodeId(requestID)}`,
      { directory },
    )
  }

  async commands(directory: string) {
    return commandList(await this.http.request<unknown>('GET', '/api/command', { directory }))
  }

  async command(
    sessionID: string,
    directory: string,
    name: string,
    args: string,
    input: OcPromptInput,
  ): Promise<void> {
    if (input.model) await this.#model(sessionID, directory, input)
    await this.http.request('POST', `/api/session/${encodeId(sessionID)}/command`, {
      directory,
      timeoutMs: ADMISSION_TIMEOUT_MS,
      body: {
        name,
        text: args,
        ...(input.files.length > 0
          ? { files: input.files.map((file) => ({ uri: file.url, name: file.name })) }
          : {}),
      },
    })
  }

  async catalog(directory: string): Promise<OcCatalog> {
    const first = await this.#catalog(directory)
    if (first.models.length > 0 || this.catalogRetryMs <= 0) return first
    await new Promise((resolve) => setTimeout(resolve, this.catalogRetryMs))
    return this.#catalog(directory)
  }

  async #catalog(directory: string): Promise<OcCatalog> {
    const [models, providers, fallback] = await Promise.all([
      this.http.request<unknown>('GET', '/api/model', { directory }),
      this.http.request<unknown>('GET', '/api/provider', { directory }).catch(() => null),
      this.http.request<unknown>('GET', '/api/model/default', { directory }).catch(() => null),
    ])
    const names = new Map<string, string>()
    const providerList = asRecord(providers)?.['data']
    for (const provider of Array.isArray(providerList) ? providerList : []) {
      const p = asRecord(provider)
      const id = str(p?.['id'])
      if (id) names.set(id, str(p?.['name']) ?? id)
    }
    const list = asRecord(models)?.['data']
    const rows = (Array.isArray(list) ? list : [])
      .map((model) => asRecord(model))
      .filter((model): model is Record<string, unknown> => model !== null)
      .filter((model) => model['enabled'] !== false)
      .sort((a, b) => (str(a['name']) ?? '').localeCompare(str(b['name']) ?? ''))
    const catalog = rows.flatMap((model) => {
      const id = str(model['id'])
      const providerID = str(model['providerID'])
      if (!id || !providerID) return []
      const variants = (Array.isArray(model['variants']) ? model['variants'] : []).flatMap((v) => {
        const variant = str(asRecord(v)?.['id'])
        return variant ? [variant] : []
      })
      return [
        catalogModel(
          `${providerID}/${id}`,
          `${names.get(providerID) ?? providerID}/${str(model['name']) ?? id}`,
          num(asRecord(model['limit'])?.['context']),
          variants,
          str(model['family']),
        ),
      ]
    })
    const current = asRecord(asRecord(fallback)?.['data'])
    const defaultId =
      current && str(current['providerID']) && str(current['id'])
        ? `${str(current['providerID'])}/${str(current['id'])}`
        : null
    return { models: catalog, defaultModelId: defaultId }
  }
}

/** A form's fields as Ari questions. External (URL) fields cannot be answered here. */
export function questionsV2(raw: unknown): {
  questions: QuestionItem[]
  fields: Record<string, FieldType>
} {
  const questions: QuestionItem[] = []
  const fields: Record<string, FieldType> = {}
  for (const item of Array.isArray(raw) ? raw : []) {
    const field = asRecord(item)
    const key = str(field?.['key'])
    const type = str(field?.['type'])
    if (!field || !key || field['hidden'] === true) continue
    if (
      type !== 'string' &&
      type !== 'number' &&
      type !== 'integer' &&
      type !== 'boolean' &&
      type !== 'multiselect'
    )
      continue
    fields[key] = type
    const question = str(field['title']) ?? str(field['description']) ?? key
    const description = str(field['description'])
    const rawOptions = Array.isArray(field['options']) ? field['options'] : []
    const options =
      type === 'boolean'
        ? [
            { id: 'true', label: 'Yes', value: 'true' },
            { id: 'false', label: 'No', value: 'false' },
          ]
        : rawOptions.flatMap((option, i) => {
            const o = asRecord(option)
            const value = str(o?.['value'])
            if (!value) return []
            const label = str(o?.['label']) ?? value
            const detail = str(o?.['description'])
            return [
              {
                id: `opt-${i}`,
                label,
                ...(value !== label ? { value } : {}),
                ...(detail ? { description: detail } : {}),
              },
            ]
          })
    questions.push({
      id: key,
      question,
      ...(description && description !== question ? { header: description } : {}),
      options,
      multiSelect: type === 'multiselect',
    })
  }
  return { questions, fields }
}

/** Answers keyed by field, in each field's own type. */
export function answersV2(
  shape: OcQuestionShape,
  questions: QuestionItem[],
  answers: Record<string, string | string[]>,
): Record<string, string | number | boolean | string[]> {
  const fields = shape.kind === 'v2' ? shape.fields : {}
  const out: Record<string, string | number | boolean | string[]> = {}
  for (const question of questions) {
    const answer = answers[question.id] ?? answers[question.question]
    if (answer === undefined) continue
    const first = Array.isArray(answer) ? (answer[0] ?? '') : answer
    switch (fields[question.id]) {
      case 'multiselect':
        out[question.id] = Array.isArray(answer) ? answer : answer.length > 0 ? [answer] : []
        break
      case 'boolean':
        out[question.id] = /^(true|yes)$/i.test(first.trim())
        break
      case 'number':
      case 'integer': {
        const value = Number(first)
        if (first.trim().length > 0 && Number.isFinite(value)) out[question.id] = value
        break
      }
      default:
        if (first.length > 0) out[question.id] = first
    }
  }
  return out
}

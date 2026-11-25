import type { PermissionMode } from '@ari/contracts/common'
import type { QuestionItem } from '../acp/client-requests'
import type { CatalogModel } from '../catalogs'

/**
 * One internal event vocabulary for both OpenCode server generations. The
 * classic server (`/event`, parts and deltas) and OpenCode 2 (`/api/event`,
 * `session.*` streams) are normalized onto this by their wire adapters, so the
 * mapper onto Ari's AgentEvents is written once.
 */

export interface OcTokens {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

/** What a reply to a question needs to know about how it was asked. */
export type OcQuestionShape =
  | { kind: 'v1' }
  /** OpenCode 2 forms answer by field key, with the field's own value type. */
  | {
      kind: 'v2'
      fields: Record<string, 'string' | 'number' | 'integer' | 'boolean' | 'multiselect'>
    }

export type OcEvent =
  /** A session appeared; a child (`parentID`) is a sub-agent. */
  | { type: 'session'; sessionID: string; parentID?: string; title?: string; agent?: string }
  /** Text streaming. `text` carries the whole part so far, `delta` a suffix. */
  | { type: 'text' | 'reasoning'; sessionID: string; partID: string; delta?: string; text?: string }
  | {
      type: 'tool'
      sessionID: string
      callID: string
      name?: string
      status: 'pending' | 'running' | 'completed' | 'error'
      input?: unknown
      output?: string
      error?: string
      /** OpenCode 2 file results (images the tool produced). */
      files?: { uri: string; mime: string; name?: string | null }[]
    }
  | { type: 'usage'; sessionID: string; tokens: OcTokens; cost: number | null }
  | { type: 'retry'; sessionID: string; attempt: number; message: string }
  | {
      type: 'permission'
      id: string
      sessionID: string
      action: string
      resources: string[]
      metadata?: unknown
      callID?: string
    }
  | {
      type: 'question'
      id: string
      sessionID: string
      prompt: string
      questions: QuestionItem[]
      shape: OcQuestionShape
    }
  /** The session finished its work: the turn is over. */
  | {
      type: 'idle'
      sessionID: string
      outcome: 'completed' | 'interrupted' | 'error'
      error?: string
    }
  /** An error that does not end the turn by itself (the classic server follows it with idle). */
  | { type: 'error'; sessionID?: string; message: string }
  /** The session started working on a prompt. */
  | { type: 'busy'; sessionID: string }

export interface OcPromptInput {
  text: string
  /** Images as data: URLs. */
  files: { url: string; mime: string; name: string }[]
  model: { providerID: string; modelID: string } | null
  variant: string | null
}

export type OcPermissionReply = 'once' | 'always' | 'reject'

/** A provider/model/effort list read from a running server. */
export interface OcCatalog {
  models: CatalogModel[]
  defaultModelId: string | null
}

/**
 * The HTTP calls the driver makes, per server generation. Every method is a
 * thin translation; none holds session state.
 */
export interface OpencodeWire {
  readonly generation: 'v1' | 'v2'
  /** The SSE path that carries every session's events. */
  readonly eventPath: string
  /** Normalizes one SSE `data:` payload. Total: unknown shapes map to []. */
  normalize(raw: unknown): OcEvent[]
  createSession(directory: string, mode: PermissionMode): Promise<string>
  sessionExists(sessionID: string, directory: string): Promise<boolean>
  setPermissions(sessionID: string, directory: string, mode: PermissionMode): Promise<void>
  /** Only OpenCode 2 runs shell tools in a per-session environment. */
  setEnvironment?(sessionID: string, directory: string, env: Record<string, string>): Promise<void>
  prompt(sessionID: string, directory: string, input: OcPromptInput): Promise<void>
  /** Adds a message to a running turn. Absent when the server cannot. */
  steer?(sessionID: string, directory: string, input: OcPromptInput): Promise<void>
  interrupt(sessionID: string, directory: string): Promise<void>
  replyPermission(
    sessionID: string,
    requestID: string,
    directory: string,
    reply: OcPermissionReply,
  ): Promise<void>
  replyQuestion(
    sessionID: string,
    requestID: string,
    directory: string,
    shape: OcQuestionShape,
    questions: QuestionItem[],
    answers: Record<string, string | string[]>,
  ): Promise<void>
  rejectQuestion(sessionID: string, requestID: string, directory: string): Promise<void>
  catalog(directory: string): Promise<OcCatalog>
  /** Named commands (project, user, skills, MCP prompts) the server can run. */
  commands(directory: string): Promise<{ name: string; description: string; source?: string }[]>
  /**
   * Runs a named command as the turn's prompt. Resolves when the server
   * accepted it; the classic server answers only once the command finished.
   */
  command(
    sessionID: string,
    directory: string,
    name: string,
    args: string,
    input: OcPromptInput,
  ): Promise<void>
}

/** Ari's permission modes as OpenCode rules: the last matching rule wins on both servers. */
export function permissionRules(
  mode: PermissionMode,
  shellAction: 'bash' | 'shell',
): { action: string; effect: 'allow' | 'ask' }[] {
  if (mode === 'full') return [{ action: '*', effect: 'allow' }]
  return [
    { action: 'edit', effect: mode === 'allow-edits' ? 'allow' : 'ask' },
    { action: shellAction, effect: 'ask' },
    { action: 'webfetch', effect: 'ask' },
  ]
}

/** `provider/model` as Ari stores it; the model part may itself contain slashes. */
export function splitModelId(id: string | null): { providerID: string; modelID: string } | null {
  if (id === null || id === 'default') return null
  const slash = id.indexOf('/')
  if (slash <= 0 || slash === id.length - 1) return null
  return { providerID: id.slice(0, slash), modelID: id.slice(slash + 1) }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function tokensOf(value: unknown): OcTokens {
  const t = asRecord(value) ?? {}
  const cache = asRecord(t['cache']) ?? {}
  return {
    input: num(t['input']),
    output: num(t['output']),
    reasoning: num(t['reasoning']),
    cache: { read: num(cache['read']), write: num(cache['write']) },
  }
}

/**
 * How long prompt-path calls (model selection, prompt, command) may take to be
 * admitted. Admission can wait on the server resolving the model and its
 * provider package, which on a first use is far longer than a plain read.
 */
export const ADMISSION_TIMEOUT_MS = 10 * 60_000

/** `ses_…` session ids only: anything else would be spliced into a URL path. */
export function encodeId(id: string): string {
  return encodeURIComponent(id)
}

/** Effort labels the way OpenCode's own ACP adapter shows variants. */
export function variantLabel(variant: string): string {
  return variant
    .split(/[_-]/)
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(' ')
}

/** `200k`, `1m` from a context window size. */
export function contextHint(tokens: number): string | undefined {
  if (!(tokens > 0)) return undefined
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}m`.replace('.0m', 'm')
  return `${Math.round(tokens / 1000)}k`
}

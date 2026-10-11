import type { AgentEvent } from '@ari/contracts/agent-event'
import type { DriverKind, PermissionMode } from '@ari/contracts/common'
import type { Detection } from './types'

/** One staged image handed to an adapter; `path` is null when unresolvable. */
export interface SessionAttachment {
  id: string
  name: string
  mimeType: string
  path: string | null
}

/** One turn of work handed to a provider adapter. */
export interface AdapterSession {
  /** Ari-side session id (journal owner). */
  sessionId: string
  workspacePath: string
  /** Complete per-session process environment; never mutate process.env. */
  runtimeEnv?: Record<string, string | undefined>
  prompt: string
  modelId: string | null
  permissionMode: PermissionMode
  /**
   * Thought/reasoning level id advertised by the harness, when the user
   * picked one. Absent/null leaves the agent's own default.
   */
  effort?: string | null
  /** Provider-native session id to resume, when continuing a thread. */
  resumeOf: string | null
  /**
   * What the host application wants the agent to know about its environment.
   * Only passed to drivers that declare {@link Driver.systemInstructions}:
   * they deliver it through the provider's system channel, where it reads as
   * configuration rather than as text of unknown origin inside the user's
   * message. One line, no line breaks.
   */
  instructions?: string | null
  /**
   * Staged images for this turn. Transports with an image channel send the
   * bytes; one-shot CLIs reference the staged files in text instead. Absent
   * (or empty) when the turn carries none.
   */
  attachments?: SessionAttachment[]
}

export interface ProviderAdapter {
  start(): AsyncIterable<AgentEvent>
  interrupt(): void
  dispose(): Promise<void>
  /**
   * Answers a pending in-band approval request (M16.8). Optional: one-shot
   * CLIs without an approval channel cannot act on decisions.
   */
  respondApproval?(approvalId: string, decision: AdapterApprovalDecision): void
  /**
   * Steers a running turn with an additional user message mid-flight
   * (M17.1). Optional: transports without a writable control channel
   * cannot accept steering.
   *
   * Resolves true only when the text is durably in the provider's hands and
   * will be processed — either inside the running turn or as a prompt chained
   * onto it. False means the transport could not take it (missing control
   * channel, dead stdin, provider rejected the steer), and the caller must
   * keep the message queued so it still runs as the follow-up turn.
   */
  steer?(text: string): boolean | Promise<boolean>
  /**
   * Answers a pending `input-requested` question. Optional: one-shot CLIs
   * without an input channel cannot act on the answer.
   */
  respondInput?(inputId: string, value: string): void
}

/**
 * Decision vocabulary shared with the `approval.respond` command contract.
 *
 * The string form is the coarse intent vocabulary, kept while adapters
 * migrate. `{ optionId }` names the exact option the provider offered, which
 * is the only form that can distinguish two options of one kind — Codex
 * advertises both a session-scoped and a prefix-scoped persistent grant as
 * `allow_always`, and picking between them by kind is a guess.
 */
export type AdapterApprovalDecision = 'allow' | 'deny' | 'always-allow' | { optionId: string }

export interface Driver {
  kind: DriverKind
  /** True when {@link AdapterSession.instructions} reaches the provider's system prompt. */
  systemInstructions?: boolean
  create(session: AdapterSession): Promise<ProviderAdapter>
}

export type { Detection }

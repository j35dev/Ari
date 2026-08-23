import type { AgentEvent } from '@ari/contracts/agent-event'
import type { DriverKind, PermissionMode } from '@ari/contracts/common'
import type { Detection } from './types'

/** One turn of work handed to a provider adapter. */
export interface AdapterSession {
  /** Ari-side session id (journal owner). */
  sessionId: string
  workspacePath: string
  prompt: string
  modelId: string | null
  permissionMode: PermissionMode
  /** Provider-native session id to resume, when continuing a thread. */
  resumeOf: string | null
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
   */
  steer?(text: string): void
}

/** Decision vocabulary shared with the `approval.respond` command contract. */
export type AdapterApprovalDecision = 'allow' | 'deny' | 'always-allow'

export interface Driver {
  kind: DriverKind
  create(session: AdapterSession): Promise<ProviderAdapter>
}

export type { Detection }

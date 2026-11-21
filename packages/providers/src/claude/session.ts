import type { AgentEvent } from '@ari/contracts/agent-event'
import type { ProviderAdapter } from '../driver'

/** A continuous Claude conversation, independently of its per-turn adapter. */
export interface ClaudeSessionProcess {
  readonly transport?: 'sdk' | 'cli'
  readonly ready?: Promise<void>
  readonly closed: boolean
  readonly sessionRef: string | null
  readonly lastActivity: number
  readonly hasRunningTasks: boolean
  readonly hasPendingResponses?: boolean
  onBackground: ((events: AgentEvent[]) => void) | null
  onEnded: (() => void) | null
  beginTurn(prompt?: unknown, park?: () => boolean, continuing?: boolean): ProviderAdapter
  shutdown(): Promise<void>
  respondApproval?: ProviderAdapter['respondApproval']
  respondInput?: ProviderAdapter['respondInput']
}

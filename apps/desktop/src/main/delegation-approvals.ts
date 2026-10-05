import { newTypedId } from '@ari/shared/ids'
import type { Session } from '@ari/contracts/session'
import type { AdapterApprovalDecision } from '@ari/providers/driver'
import type { Engine } from './engine'
import { createLogger } from '@ari/shared/logger'

const log = createLogger('engine:delegation-approval')

/**
 * The two choices a delegation request offers. The ids are stable so a
 * response naming one resolves exactly, the same way a provider approval's
 * own option ids do — a delegation card is not a special case downstream.
 */
const DELEGATION_OPTIONS = [
  { optionId: 'delegation_allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'delegation_deny', name: 'Deny', kind: 'reject_once' },
] as const

/**
 * The ids in {@linkcode DELEGATION_OPTIONS} are this request's whole
 * vocabulary, so an exact answer needs no translation. An id this host never
 * offered is treated as a denial: a delegation spawns child sessions that run
 * unattended, which is not something to start by accident.
 */
function allows(decision: AdapterApprovalDecision): boolean {
  if (typeof decision !== 'object') return decision !== 'deny'
  return decision.optionId === 'delegation_allow'
}

/** Delegation requests use the existing durable approval card and response command. */
export class DelegationApprovals {
  readonly #pending = new Map<string, { root: string; answer: (allowed: boolean) => void }>()
  constructor(readonly engine: Engine) {}

  async request(root: Session, maxChildren: number): Promise<boolean> {
    const id = `ari_delegate_${newTypedId('evt')}`
    let answer!: (allowed: boolean) => void
    const result = new Promise<boolean>((resolve) => {
      answer = resolve
    })
    this.#pending.set(id, { root: root.id, answer })
    const timer = setTimeout(() => this.#deny(id, root.id), 300_000)
    try {
      await this.engine.record(root.id, {
        type: 'approval.requested',
        approvalId: id,
        toolName: 'Ari delegation',
        summaryJson: JSON.stringify({
          description: `Allow ${root.title} to create up to ${maxChildren} concurrent child sessions for this task?`,
        }),
        options: [...DELEGATION_OPTIONS],
      })
      return await result
    } finally {
      clearTimeout(timer)
      this.#pending.delete(id)
    }
  }

  respond(id: string, decision: AdapterApprovalDecision): boolean {
    const pending = this.#pending.get(id)
    if (!pending) return id.startsWith('ari_delegate_')
    pending.answer(allows(decision))
    this.#pending.delete(id)
    return true
  }

  cancel(rootId: string): void {
    for (const [id, pending] of this.#pending)
      if (pending.root === rootId) this.#deny(id, pending.root)
  }

  close(): void {
    for (const [id, pending] of this.#pending) this.#deny(id, pending.root)
  }

  #deny(id: string, root: string): void {
    if (!this.#pending.has(id)) return
    this.respond(id, 'deny')
    void this.engine
      .record(root, {
        type: 'approval.responded',
        approvalId: id,
        optionId: 'delegation_deny',
        decision: 'deny',
      })
      .catch(() => log.warn('Failed to persist delegation approval cancellation'))
  }
}

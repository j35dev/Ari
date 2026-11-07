import type {
  OrchestrationMethod,
  OrchestrationParams,
  OrchestrationResults,
} from '@ari/contracts/orchestration'
import { rpc } from '../../lib/rpc'

/** Reuse a receipt key on an explicit retry of the same action. */
export function workActionKey(): string {
  return `work_${crypto.randomUUID()}`
}

export async function invokeWork<M extends OrchestrationMethod>(
  method: M,
  params: OrchestrationParams<M>,
): Promise<OrchestrationResults[M]> {
  return rpc.invoke(method, params)
}

export const workButton =
  'inline-flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:opacity-40'
export const workInput =
  'w-full rounded-md border border-border bg-surface-1 px-2.5 py-2 text-xs leading-relaxed text-fg placeholder:text-fg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring'

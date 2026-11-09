export interface AttentionEvent {
  type: string
  approvalId?: string
  inputId?: string
}

/** Keep request identities so repeated frames cannot inflate the Aria count. */
export function reduceSessionAttention(
  current: ReadonlySet<string>,
  event: AttentionEvent,
): ReadonlySet<string> {
  if (event.type === 'turn.settled') return current.size > 0 ? new Set() : current
  const approval = event.type === 'approval.requested' || event.type === 'approval.responded'
  const input = event.type === 'input.requested' || event.type === 'input.responded'
  if (!approval && !input) return current
  const id = approval ? event.approvalId : event.inputId
  if (id === undefined) return current
  const key = `${approval ? 'approval' : 'input'}:${id}`
  const add = event.type.endsWith('.requested')
  if (current.has(key) === add) return current
  const next = new Set(current)
  if (add) next.add(key)
  else next.delete(key)
  return next
}

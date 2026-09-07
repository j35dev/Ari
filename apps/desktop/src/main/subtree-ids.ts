/** Descendants of `rootId`, deepest first, so a parent can be destroyed as a tree. */
export function descendantIds(
  sessions: readonly { id: string; parentSessionId?: string | null }[],
  rootId: string,
): string[] {
  const children = new Map<string, string[]>()
  for (const session of sessions) {
    const parent = session.parentSessionId
    if (!parent) continue
    const nested = children.get(parent) ?? []
    nested.push(session.id)
    children.set(parent, nested)
  }
  const ids: string[] = []
  const visit = (id: string): void => {
    for (const child of children.get(id) ?? []) {
      visit(child)
      ids.push(child)
    }
  }
  visit(rootId)
  return ids
}

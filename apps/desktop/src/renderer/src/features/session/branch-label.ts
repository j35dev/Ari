/**
 * The words of an Ari child branch. A titled branch
 * `ari/edit-queued-message-c2825b69` reads as `edit-queued-message`.
 * Anything else, including the older `ari/<parent>/<session id>` form, is
 * left unchanged so it can still be matched to git.
 */
export function branchLabel(branch: string): string {
  if (!branch.startsWith('ari/')) return branch
  const leaf = branch.slice('ari/'.length)
  if (leaf.includes('/')) return branch
  const readable = leaf.replace(/-[a-f0-9]{8}(?:-\d+)?$/, '')
  return readable.length > 0 ? readable : leaf
}

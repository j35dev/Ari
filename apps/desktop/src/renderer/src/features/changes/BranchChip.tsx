import { GitBranch } from 'lucide-react'

/** Compact branch indicator for the titlebar/changes header. */
export function BranchChip({ branch }: { branch: string | null }) {
  if (!branch) return null
  return (
    <span className="inline-flex items-center gap-1 rounded-sm bg-surface-2 px-1.5 py-0.5 font-mono text-2xs text-fg-muted">
      <GitBranch size={10} className="shrink-0" />
      {branch}
    </span>
  )
}

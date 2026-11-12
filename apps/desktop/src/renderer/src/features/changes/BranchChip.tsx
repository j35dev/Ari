import { GitBranch } from 'lucide-react'

/** Compact branch indicator for the titlebar/changes header. */
export function BranchChip({ branch }: { branch: string | null }) {
  if (!branch) return null
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] text-fg-muted">
      <GitBranch size={14} className="shrink-0 text-fg-subtle" aria-hidden />
      {branch}
    </span>
  )
}

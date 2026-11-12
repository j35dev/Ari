import { Hand, PencilLine, Zap, type LucideIcon } from 'lucide-react'
import type { PermissionMode } from '@ari/contracts/common'

/**
 * What each level lets the agent do without asking, as a mark. An agent's own
 * mode names vary ("plan", "build", "yolo"); the mark is always Ari's meaning.
 */
export const MODE_ICON: Record<PermissionMode, LucideIcon> = {
  ask: Hand,
  'allow-edits': PencilLine,
  full: Zap,
}

export function ModeMark({ mode }: { mode: PermissionMode }) {
  const Icon = MODE_ICON[mode]
  return <Icon size={15} strokeWidth={1.7} aria-hidden />
}

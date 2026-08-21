import { MessageSquare, FolderGit2, TerminalSquare, GitPullRequest, Settings } from 'lucide-react'

export type RailView = 'sessions' | 'projects' | 'terminal' | 'changes' | 'settings'

const ITEMS: { id: RailView; label: string; icon: typeof MessageSquare }[] = [
  { id: 'sessions', label: 'Sessions', icon: MessageSquare },
  { id: 'projects', label: 'Projects', icon: FolderGit2 },
  { id: 'terminal', label: 'Terminal', icon: TerminalSquare },
  { id: 'changes', label: 'Changes', icon: GitPullRequest },
  { id: 'settings', label: 'Settings', icon: Settings },
]

/** Icon-only navigation rail (PLAN §6.1). */
export function LeftRail({
  active,
  onSelect,
  badgeCounts,
}: {
  active: RailView
  onSelect: (view: RailView) => void
  badgeCounts?: Partial<Record<RailView, number>>
}) {
  return (
    <nav
      aria-label="Primary"
      className="flex w-[var(--ari-rail-width)] shrink-0 flex-col items-center gap-1 border-r border-border bg-surface-0 py-3"
    >
      {ITEMS.map(({ id, label, icon: Icon }) => {
        const isActive = active === id
        const badge = badgeCounts?.[id]
        return (
          <button
            key={id}
            type="button"
            aria-label={label}
            aria-current={isActive ? 'page' : undefined}
            title={label}
            onClick={() => onSelect(id)}
            className={`relative flex h-10 w-10 items-center justify-center rounded-md transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring ${
              isActive
                ? 'bg-accent-subtle text-accent'
                : 'text-fg-subtle hover:bg-surface-1 hover:text-fg'
            }`}
          >
            <Icon size={18} strokeWidth={isActive ? 2.2 : 1.8} />
            {badge !== undefined && badge > 0 ? (
              <span className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-none text-fg-on-accent">
                {badge > 9 ? '9+' : badge}
              </span>
            ) : null}
          </button>
        )
      })}
    </nav>
  )
}

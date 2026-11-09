import { AriaMark } from '@ari/ui/aria-mark'
import type { ariaActivity } from './aria-activity'

export function AriaRow({
  selected,
  activity,
  onOpen,
}: {
  selected: boolean
  activity: ReturnType<typeof ariaActivity>
  onOpen: () => void
}) {
  const count = activity.attention || activity.working
  return (
    <div className="shrink-0 px-2 pb-1">
      <button
        type="button"
        aria-label="Open Aria"
        aria-current={selected ? 'page' : undefined}
        onClick={onOpen}
        title="Open Aria (Mod+0)"
        className={`flex h-7 w-full min-w-0 items-center gap-2 rounded-md pl-2 pr-1 text-left text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring ${selected ? 'bg-accent/15 font-medium text-fg' : 'text-fg-muted hover:bg-surface-2 hover:text-fg'}`}
      >
        <AriaMark size={16} state={activity.state} className="shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate">Aria</span>
        {count > 0 ? (
          <span
            className="pr-1 text-2xs tabular-nums text-accent"
            title={activity.attention > 0 ? `${count} items need you` : `${count} sessions working`}
          >
            {count}
          </span>
        ) : null}
      </button>
    </div>
  )
}

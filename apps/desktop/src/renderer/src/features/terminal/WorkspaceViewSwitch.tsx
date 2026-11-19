import { Gauge, MessagesSquare, PanelLeftClose, Search, TerminalSquare } from 'lucide-react'
import type { WorkspaceView } from './terminal-workspace-state'

export function WorkspaceViewSwitch({
  view,
  onChange,
  disabled = false,
}: {
  view: WorkspaceView
  onChange: (view: WorkspaceView) => void
  disabled?: boolean
}) {
  return (
    <div className="ari-workspace-view-switch" role="group" aria-label="Workspace view">
      <button
        type="button"
        aria-label="Sessions workspace"
        aria-pressed={view === 'sessions'}
        disabled={disabled}
        title="Sessions workspace · Ctrl/Cmd+Shift+M"
        onClick={() => onChange('sessions')}
      >
        <MessagesSquare size={15} aria-hidden />
      </button>
      <button
        type="button"
        aria-label="Terminals workspace"
        aria-pressed={view === 'terminals'}
        disabled={disabled}
        title="Terminals workspace · Ctrl/Cmd+Shift+M"
        onClick={() => onChange('terminals')}
      >
        <TerminalSquare size={15} aria-hidden />
      </button>
    </div>
  )
}

export function TerminalWorkspaceBrand({
  onPalette,
  onToggleProjects,
}: {
  onPalette: () => void
  onToggleProjects: () => void
}) {
  return (
    <div className="ari-terminal-brand">
      <span data-ari-part="brand">
        Ari<b>.</b>
      </span>
      <button
        type="button"
        className="ari-terminal-pane-button"
        aria-label="Terminal command palette"
        title="Commands"
        onClick={onPalette}
      >
        <Search size={15} aria-hidden />
      </button>
      <button
        type="button"
        className="ari-terminal-pane-button"
        aria-label="Toggle terminal project sidebar"
        title="Show or hide projects"
        onClick={onToggleProjects}
      >
        <PanelLeftClose size={15} aria-hidden />
      </button>
    </div>
  )
}

export function TerminalWorkspaceUsageButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="ari-terminal-header-usage"
      aria-label="Provider usage"
      onClick={onClick}
    >
      <Gauge size={14} aria-hidden />
      <span>Usage</span>
    </button>
  )
}

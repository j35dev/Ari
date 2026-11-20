import { useRef, useState, type ReactNode } from 'react'
import {
  ArrowDownToLine,
  ChevronDown,
  ChevronUp,
  GripVertical,
  Maximize2,
  Minimize2,
  Plus,
  RotateCcw,
  Search,
  SplitSquareHorizontal,
  SplitSquareVertical,
  TerminalSquare,
  X,
} from 'lucide-react'
import { TerminalPane } from './TerminalPane'
import { ProviderLogo } from '../composer/provider-logo'
import { SplitSeparator } from '../split/SplitSeparator'
import { usePaneMenu } from '../split/use-pane-menu'
import { leaves, type PaneLeaf, type PaneNode, type PaneEdge } from '../split/split-layout'
import { useTerminalStatus, findTerminalRuntime } from './terminal-runtime'
import { renameTerminalTab, type TerminalTab } from './terminal-dock'
import { useTerminalPreferences } from './terminal-preferences'
import { terminalWorkspaceActions as actions, type TerminalTask } from './terminal-workspace-state'

export function displayTerminalPath(path: string): string {
  const parts = path.replaceAll('\\', '/').replace(/\/$/, '').split('/')
  return parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : path.replaceAll('\\', '/')
}

export interface TerminalGridProps {
  task: TerminalTask
  tabs: readonly TerminalTab[]
  active: boolean
  pending: ReadonlySet<string>
  errors: Readonly<Record<string, string>>
  searchTarget: string | null
  onSearch: (id: string | null) => void
  onLaunch: (task: TerminalTask, paneId: string, edge?: PaneEdge) => void
  onRestart: (task: TerminalTask, tab: TerminalTab, paneId: string) => void
  onStop: (task: TerminalTask, tab: TerminalTab) => void
}

export function TerminalWorkspaceGrid(props: TerminalGridProps) {
  const { task, active } = props
  const count = leaves(task.layout.root).length
  const renderNode = (node: PaneNode): ReactNode => {
    if (node.kind === 'leaf')
      return <WorkspacePane key={node.paneId} {...props} pane={node} canSplit={count < 6} />
    const zoomed = task.layout.zoomedPaneId
    const hasZoom = (child: PaneNode): boolean =>
      leaves(child).some((pane) => pane.paneId === zoomed)
    const hideA = zoomed !== null && !hasZoom(node.a)
    const hideB = zoomed !== null && !hasZoom(node.b)
    const row = node.direction === 'row'
    return (
      <div key={node.nodeId} className={`ari-terminal-split ${row ? 'is-row' : 'is-column'}`}>
        <div
          className="ari-terminal-split-child"
          hidden={hideA}
          inert={hideA}
          style={{ flex: hideA ? undefined : hideB ? 1 : `${node.ratio} 1 0%` }}
        >
          {renderNode(node.a)}
        </div>
        <SplitSeparator
          nodeId={node.nodeId}
          label="Resize terminal panes"
          direction={node.direction}
          ratio={node.ratio}
          onResize={(id, ratio) => actions.resize(task.id, id, ratio)}
          hidden={zoomed !== null}
        />
        <div
          className="ari-terminal-split-child"
          hidden={hideB}
          inert={hideB}
          style={{ flex: hideB ? undefined : hideA ? 1 : `${1 - node.ratio} 1 0%` }}
        >
          {renderNode(node.b)}
        </div>
      </div>
    )
  }
  return (
    <div
      className="ari-terminal-grid"
      role="region"
      aria-label={`${task.title} terminal panes`}
      inert={!active}
    >
      {renderNode(task.layout.root)}
    </div>
  )
}

function PaneButton({
  label,
  onClick,
  disabled = false,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className="ari-terminal-pane-button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
    >
      {children}
    </button>
  )
}

function WorkspacePane({
  task,
  tabs,
  pane,
  active,
  pending,
  errors,
  searchTarget,
  onSearch,
  onLaunch,
  onRestart,
  onStop,
  canSplit,
}: TerminalGridProps & { pane: PaneLeaf; canSplit: boolean }) {
  const prefs = useTerminalPreferences()
  const terminalId = pane.terminalId ?? ''
  const tab = tabs.find((tab) => tab.id === terminalId)
  const status = useTerminalStatus(terminalId)
  const focused = task.layout.focusedPaneId === pane.paneId
  const busy = pending.has(terminalId)
  const error = errors[terminalId] ?? status.error
  const stopped = status.state === 'exited' || status.state === 'missing'
  const label = tab?.title ?? 'Empty terminal pane'
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(label)
  const cancelRename = useRef(false)
  const zoomed = task.layout.zoomedPaneId === pane.paneId
  const directory = status.cwd ?? tab?.cwd ?? task.cwd
  const paneMenu = usePaneMenu({
    paneId: pane.paneId,
    label,
    canSplit,
    terminalInput: true,
    onSplit: (id, edge) => onLaunch(task, id, edge),
    zoomed,
    onToggleZoom:
      leaves(task.layout.root).length > 1 ? (id) => actions.zoom(task.id, id) : undefined,
    onClose: leaves(task.layout.root).length > 1 ? (id) => actions.detach(task.id, id) : undefined,
    onOpenTerminal: tab ? undefined : (id) => onLaunch(task, id),
  })
  const saveName = (): void => {
    if (!cancelRename.current && tab) renameTerminalTab(tab.id, name)
    setRenaming(false)
  }
  return (
    <>
      <section
        className="ari-terminal-pane"
        data-focused={focused}
        data-ari-part="terminal-pane"
        data-header-position={prefs.headerPosition}
        aria-label={label}
        onPointerDownCapture={() => actions.focus(task.id, pane.paneId)}
        onFocusCapture={() => actions.focus(task.id, pane.paneId)}
        onContextMenuCapture={(event) => {
          paneMenu.menuProps.onContextMenu(event)
          if (event.defaultPrevented) actions.focus(task.id, pane.paneId)
        }}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('application/x-ari-terminal-pane'))
            event.preventDefault()
        }}
        onDrop={(event) => {
          const dragged = event.dataTransfer.getData('application/x-ari-terminal-pane')
          if (!dragged || !leaves(task.layout.root).some((item) => item.paneId === dragged)) return
          event.preventDefault()
          actions.swap(task.id, dragged, pane.paneId)
        }}
      >
        <header className="ari-terminal-pane-header" data-ari-part="terminal-header">
          <span
            className="ari-terminal-pane-grip"
            draggable
            title="Drag to swap panes"
            onDragStart={(event) => {
              event.dataTransfer.setData('application/x-ari-terminal-pane', pane.paneId)
              event.dataTransfer.effectAllowed = 'move'
            }}
          >
            <GripVertical size={12} aria-hidden />
          </span>
          <span className="ari-terminal-program-mark">
            {tab?.profile === 'claude' || tab?.profile === 'codex' ? (
              <ProviderLogo kind={tab.profile} size={14} />
            ) : (
              <TerminalSquare size={14} aria-hidden />
            )}
          </span>
          {renaming ? (
            <input
              className="ari-terminal-title-input"
              value={name}
              autoFocus
              aria-label="Terminal name"
              onFocus={(event) => event.target.select()}
              onChange={(event) => setName(event.target.value)}
              onBlur={saveName}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  saveName()
                }
                if (event.key === 'Escape') {
                  cancelRename.current = true
                  setRenaming(false)
                }
              }}
            />
          ) : (
            <button
              type="button"
              className="ari-terminal-pane-title"
              title={`${label} · double-click to rename`}
              onDoubleClick={() => {
                setName(label)
                cancelRename.current = false
                setRenaming(true)
              }}
            >
              {label}
            </button>
          )}
          {prefs.showDirectory && (
            <span className="ari-terminal-pane-directory" title={directory}>
              {displayTerminalPath(directory)}
            </span>
          )}
          <span
            className="ari-terminal-pane-state"
            data-state={error ? 'error' : busy ? 'connecting' : status.state}
            title={
              error ??
              (stopped
                ? status.state === 'missing'
                  ? 'This terminal is no longer running'
                  : `Exited${status.exitCode === null ? '' : ` with code ${status.exitCode}`}`
                : busy
                  ? 'Starting terminal'
                  : 'Terminal running')
            }
            aria-label={
              error
                ? 'Terminal error'
                : busy
                  ? 'Starting terminal'
                  : stopped
                    ? 'Terminal stopped'
                    : 'Terminal running'
            }
          />
          <div className="ari-terminal-pane-actions">
            {tab && (
              <PaneButton
                label="Find in terminal"
                onClick={() => onSearch(searchTarget === terminalId ? null : terminalId)}
              >
                <Search size={13} aria-hidden />
              </PaneButton>
            )}
            <PaneButton
              label="Split terminal right"
              disabled={!canSplit || busy}
              onClick={() => onLaunch(task, pane.paneId, 'right')}
            >
              <SplitSquareHorizontal size={14} aria-hidden />
            </PaneButton>
            <PaneButton
              label="Split terminal below"
              disabled={!canSplit || busy}
              onClick={() => onLaunch(task, pane.paneId, 'below')}
            >
              <SplitSquareVertical size={14} aria-hidden />
            </PaneButton>
            <PaneButton
              label={zoomed ? 'Restore terminal panes' : 'Maximize terminal pane'}
              onClick={() => actions.zoom(task.id, pane.paneId)}
            >
              {zoomed ? <Minimize2 size={13} aria-hidden /> : <Maximize2 size={13} aria-hidden />}
            </PaneButton>
            <PaneButton
              label="Park terminal pane"
              onClick={() => actions.detach(task.id, pane.paneId)}
            >
              <X size={13} aria-hidden />
            </PaneButton>
          </div>
        </header>
        <div className="ari-terminal-pane-body">
          {tab ? (
            <>
              {searchTarget === terminalId && (
                <TerminalSearch id={terminalId} onClose={() => onSearch(null)} />
              )}
              {busy ? (
                <div className="ari-terminal-starting">
                  <span className="ari-terminal-starting-ring" />
                  Starting {label}…
                </div>
              ) : errors[terminalId] && !findTerminalRuntime(terminalId) ? null : (
                <TerminalPane
                  terminalId={terminalId}
                  cwd={tab.cwd}
                  active={active && focused}
                  attachOnly
                />
              )}
              {(error || stopped) && !busy && (
                <div className="ari-terminal-recovery" role={error ? 'alert' : 'status'}>
                  <div>
                    <strong>
                      {error
                        ? 'Terminal could not start'
                        : status.state === 'missing'
                          ? 'This terminal has stopped'
                          : `Process exited${status.exitCode === null ? '' : ` with code ${status.exitCode}`}`}
                    </strong>
                    <p>
                      {error ??
                        'Your output stays here. Start the terminal again when you are ready.'}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="ari-terminal-text-button"
                    onClick={() => onRestart(task, tab, pane.paneId)}
                  >
                    <RotateCcw size={13} aria-hidden />
                    Restart
                  </button>
                </div>
              )}
              {status.scrolledUp && !busy && !stopped && !error && (
                <button
                  type="button"
                  className="ari-terminal-scroll-bottom"
                  aria-label="Scroll terminal to bottom"
                  title="Scroll to bottom"
                  onClick={() => {
                    const runtime = findTerminalRuntime(terminalId)
                    runtime?.scrollToBottom()
                    runtime?.focus()
                  }}
                >
                  <ArrowDownToLine size={13} aria-hidden />
                </button>
              )}
            </>
          ) : (
            <div className="ari-terminal-empty-pane">
              <TerminalSquare size={23} strokeWidth={1.25} aria-hidden />
              <p>Make room for your next tool.</p>
              <button
                type="button"
                className="ari-terminal-text-button"
                onClick={() => onLaunch(task, pane.paneId)}
              >
                <Plus size={13} aria-hidden />
                Open terminal
              </button>
            </div>
          )}
        </div>
        <footer className="ari-terminal-pane-footer">
          <span>
            {tab?.profile === 'claude'
              ? 'Claude Code'
              : tab?.profile === 'codex'
                ? 'Codex CLI'
                : tab?.profile === 'custom'
                  ? 'Command'
                  : 'Shell'}
          </span>
          <span className="ari-terminal-pane-footer-right">
            {status.cols > 0 ? `${status.cols} × ${status.rows}` : ''}
            {tab && (
              <button type="button" title="Stop terminal process" onClick={() => onStop(task, tab)}>
                Stop
              </button>
            )}
          </span>
        </footer>
      </section>
      {paneMenu.element}
    </>
  )
}

function TerminalSearch({ id, onClose }: { id: string; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [found, setFound] = useState(true)
  const find = (value: string, previous = false): void => {
    setFound(!value || (findTerminalRuntime(id)?.find(value, previous) ?? false))
  }
  return (
    <div className="ari-terminal-find" role="search" aria-label="Search terminal output">
      <Search size={13} aria-hidden />
      <input
        autoFocus
        aria-label="Find terminal text"
        placeholder="Find in terminal…"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          find(event.target.value)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            find(query, event.shiftKey)
          }
          if (event.key === 'Escape') {
            event.stopPropagation()
            findTerminalRuntime(id)?.clearSearch()
            onClose()
            findTerminalRuntime(id)?.focus()
          }
        }}
      />
      {!found && <span>No matches</span>}
      <PaneButton label="Previous terminal match" onClick={() => find(query, true)}>
        <ChevronUp size={13} aria-hidden />
      </PaneButton>
      <PaneButton label="Next terminal match" onClick={() => find(query)}>
        <ChevronDown size={13} aria-hidden />
      </PaneButton>
      <PaneButton
        label="Close terminal search"
        onClick={() => {
          findTerminalRuntime(id)?.clearSearch()
          onClose()
        }}
      >
        <X size={13} aria-hidden />
      </PaneButton>
    </div>
  )
}

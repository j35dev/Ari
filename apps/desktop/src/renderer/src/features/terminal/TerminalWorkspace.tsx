import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Plus,
  RotateCcw,
  SquareSplitHorizontal,
  SquareSplitVertical,
  X,
} from 'lucide-react'
import type { RpcResults } from '@ari/contracts/rpc'
import { rpc } from '../../lib/rpc'
import { ContextMenu, type MenuAnchor } from '../../shell/ContextMenu'
import { TerminalA11y } from './TerminalA11y'
import { TerminalPane } from './TerminalPane'
import {
  subscribeTerminalRequests,
  type TerminalTabRequest,
} from './terminal-requests'
import {
  closeLeaf,
  countLeaves,
  firstLeafId,
  hasLeaf,
  setRatio,
  splitLeaf,
  type PaneNode,
  type SplitDir,
} from './terminal-layout'

type Detection = RpcResults['providers.detect'][number]

let paneSeq = 0

function makePaneId(): string {
  return `term_${++paneSeq}_${Math.random().toString(36).slice(2, 8)}`
}

function defaultShellLabel(): string {
  if (navigator.userAgent.toLowerCase().includes('windows')) return 'pwsh'
  if (navigator.userAgent.toLowerCase().includes('mac')) return 'zsh'
  return 'sh'
}

/** Launchable pane presets: a plain shell plus the installed coding CLIs. */
interface PanePreset {
  id: string
  label: string
  /** First command written into the shell after spawn. */
  command?: string
  /** Only offered when this driver kind is detected on the machine. */
  kind?: Detection['kind']
}

const PRESETS: PanePreset[] = [
  { id: 'shell', label: defaultShellLabel() },
  { id: 'claude', label: 'Claude Code', command: 'claude', kind: 'claude' },
  { id: 'codex', label: 'Codex CLI', command: 'codex', kind: 'codex' },
]

interface PaneInfo {
  title: string
  cwd: string
  command?: string
}

/** First-use title dedupe: "pwsh", "pwsh 2", … */
function uniqueTitle(base: string, panes: Record<string, PaneInfo>): string {
  const taken = new Set(Object.values(panes).map((p) => p.title))
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base} ${n}`)) n += 1
  return `${base} ${n}`
}

/**
 * Full-page terminal workspace (M24.1): a herdr-style pane grid for driving
 * several agent CLIs at once. Panes live in a binary split tree — any pane can
 * split right/down, dividers drag and respond to arrow keys, and every pane
 * stays mounted so background pty output keeps flowing while others are
 * resized or focused. Ptys die only when their pane closes.
 */
export function TerminalWorkspace({ cwd }: { cwd?: string }) {
  const [failed, setFailed] = useState<string | null>(null)
  const [resolvedCwd, setResolvedCwd] = useState<string | null>(cwd ?? null)
  const [root, setRoot] = useState<PaneNode | null>(null)
  const [panes, setPanes] = useState<Record<string, PaneInfo>>({})
  const [activePaneId, setActivePaneId] = useState<string | null>(null)
  const [launcherAnchor, setLauncherAnchor] = useState<MenuAnchor | null>(null)
  const [installedKinds, setInstalledKinds] = useState<Set<string>>(new Set())

  useEffect(() => {
    setResolvedCwd(cwd ?? null)
  }, [cwd])

  // The renderer is sandboxed — the shell's working directory comes from the
  // main process. Fall back to the user's home directory.
  useEffect(() => {
    if (resolvedCwd !== null) return
    void rpc
      .invoke('app.info')
      .then((info) => setResolvedCwd(info.homeDir))
      .catch((e: unknown) => setFailed(e instanceof Error ? e.message : String(e)))
  }, [resolvedCwd])

  // Agent presets are only offered for CLIs actually installed; the plain
  // shell preset is always available.
  useEffect(() => {
    void rpc
      .invoke('providers.detect')
      .then((detections) => {
        setInstalledKinds(
          new Set(detections.filter((d) => d.binaryPath !== null).map((d) => d.kind)),
        )
      })
      .catch(() => undefined)
  }, [])

  const addPaneRef = useRef<((info: PaneInfo, dir: SplitDir) => void) | null>(null)

  /**
   * Spawns a pty-backed pane. The first pane takes the whole page; later ones
   * split the focused pane along `dir`. Late-bound through a ref so the
   * mount-once run-script subscription always calls the current closure.
   */
  addPaneRef.current = (info: PaneInfo, dir: SplitDir) => {
    const id = makePaneId()
    setPanes((prev) => ({ ...prev, [id]: info }))
    setRoot((prev) => {
      if (prev === null) return { kind: 'leaf', paneId: id }
      const target = activePaneId
      const anchor = target !== null && hasLeaf(prev, target) ? target : firstLeafId(prev)
      if (anchor === null) return { kind: 'leaf', paneId: id }
      return splitLeaf(prev, anchor, dir, id) ?? prev
    })
    setActivePaneId(id)
  }

  // Run-script requests (M21.3): open a titled pane that executes the command.
  useEffect(
    () =>
      subscribeTerminalRequests((request: TerminalTabRequest) => {
        addPaneRef.current?.({ title: request.title, cwd: request.cwd, command: request.command }, 'row')
      }),
    [],
  )

  // Open the first pane automatically once, on first use; an intentionally
  // emptied workspace stays empty. The first pane is always the bare shell
  // (no numbering needed — the tree is empty or run-script panes beat us here
  // and the effect no-ops).
  const autoOpened = useRef(false)
  useEffect(() => {
    if (autoOpened.current || resolvedCwd === null || root !== null) return
    autoOpened.current = true
    addPaneRef.current?.({ title: defaultShellLabel(), cwd: resolvedCwd }, 'row')
  }, [resolvedCwd, root])

  const spawnPreset = useCallback(
    (preset: PanePreset, dir: SplitDir = 'row') => {
      if (resolvedCwd === null) return
      addPaneRef.current?.(
        { title: uniqueTitle(preset.label, panes), cwd: resolvedCwd, command: preset.command },
        dir,
      )
    },
    [resolvedCwd, panes],
  )

  const closePane = useCallback((id: string) => {
    void rpc.invoke('terminal.kill', { id }).catch(() => undefined)
    setPanes((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    setRoot((prev) => {
      const next = prev === null ? null : closeLeaf(prev, id)
      setActivePaneId((current) => {
        if (current !== id) return current
        return next === null ? null : firstLeafId(next)
      })
      return next
    })
  }, [])

  const availablePresets = PRESETS.filter((p) => p.kind === undefined || installedKinds.has(p.kind))

  if (failed !== null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-bg">
        <p className="max-w-sm text-center text-sm text-danger">Terminal could not start: {failed}</p>
        <button
          type="button"
          onClick={() => {
            setFailed(null)
            setRoot(null)
            setPanes({})
            setActivePaneId(null)
          }}
          className="flex items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
        >
          <RotateCcw size={12} /> Retry
        </button>
      </div>
    )
  }

  const paneCount = root === null ? 0 : countLeaves(root)

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <h1 className="text-xs font-medium text-fg">Terminals</h1>
        {paneCount > 0 ? (
          <span className="text-2xs text-fg-subtle">
            {paneCount} {paneCount === 1 ? 'pane' : 'panes'}
          </span>
        ) : null}
        <div className="flex-1" />
        <ToolbarButton
          label="Split pane right"
          icon={<SquareSplitHorizontal size={13} aria-hidden />}
          disabled={activePaneId === null}
          onClick={() => spawnPreset({ id: 'shell', label: defaultShellLabel() }, 'row')}
        />
        <ToolbarButton
          label="Split pane down"
          icon={<SquareSplitVertical size={13} aria-hidden />}
          disabled={activePaneId === null}
          onClick={() => spawnPreset({ id: 'shell', label: defaultShellLabel() }, 'col')}
        />
        <ToolbarButton
          label="New pane"
          icon={<Plus size={14} aria-hidden />}
          onClick={(e) =>
            setLauncherAnchor({ x: e.currentTarget.getBoundingClientRect().left, y: e.currentTarget.getBoundingClientRect().bottom + 4 })
          }
        />
      </div>

      {launcherAnchor !== null ? (
        <ContextMenu
          anchor={launcherAnchor}
          label="New pane"
          items={availablePresets.map((preset) => ({
            id: preset.id,
            label: preset.command !== undefined ? `${preset.label} (${preset.command})` : preset.label,
            onSelect: () => spawnPreset(preset),
          }))}
          onClose={() => setLauncherAnchor(null)}
        />
      ) : null}

      <TerminalA11y
        title={activePaneId !== null ? (panes[activePaneId]?.title ?? '') : 'none'}
      />

      <div className="relative min-h-0 flex-1">
        {root === null ? (
          <div className="flex h-full flex-col items-center justify-center gap-2">
            <p className="text-xs text-fg-subtle">No terminal panes open.</p>
            <button
              type="button"
              onClick={() => spawnPreset({ id: 'shell', label: defaultShellLabel() })}
              className="flex items-center gap-1.5 rounded-md border border-border bg-surface-1 px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
            >
              <Plus size={12} /> New terminal
            </button>
          </div>
        ) : (
          <PaneTree
            node={root}
            panes={panes}
            activePaneId={activePaneId}
            onFocusPane={setActivePaneId}
            onClosePane={closePane}
            onResize={(splitId, ratio) => setRoot((prev) => (prev === null ? prev : setRatio(prev, splitId, ratio)))}
          />
        )}
      </div>
    </div>
  )
}

function ToolbarButton({
  label,
  icon,
  disabled,
  onClick,
}: {
  label: string
  icon: React.ReactNode
  disabled?: boolean
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:pointer-events-none disabled:opacity-40"
    >
      {icon}
    </button>
  )
}

/** Recursive renderer: leaves become pane frames, splits become flex boxes. */
function PaneTree({
  node,
  panes,
  activePaneId,
  onFocusPane,
  onClosePane,
  onResize,
}: {
  node: PaneNode
  panes: Record<string, PaneInfo>
  activePaneId: string | null
  onFocusPane: (id: string) => void
  onClosePane: (id: string) => void
  onResize: (splitId: string, ratio: number) => void
}) {
  if (node.kind === 'leaf') {
    const info = panes[node.paneId]
    if (info === undefined) return null
    const active = node.paneId === activePaneId
    return (
      <section
        aria-label={`${info.title} terminal pane`}
        className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg"
        onFocus={() => onFocusPane(node.paneId)}
      >
        <header
          className={`flex h-7 shrink-0 items-center gap-1 border-b px-2 transition-colors ${
            active ? 'border-border bg-surface-1' : 'border-border bg-surface-0'
          }`}
        >
          <button
            type="button"
            aria-pressed={active}
            onClick={() => onFocusPane(node.paneId)}
            className={`rounded-sm px-1 py-0.5 font-mono text-2xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring ${
              active ? 'text-fg' : 'text-fg-subtle hover:text-fg-muted'
            }`}
          >
            {info.title}
          </button>
          <div className="flex-1" />
          <button
            type="button"
            aria-label={`Close ${info.title} pane`}
            onClick={() => onClosePane(node.paneId)}
            className="rounded-sm p-0.5 text-fg-subtle transition-colors hover:bg-surface-3 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          >
            <X size={11} />
          </button>
        </header>
        <div className="min-h-0 flex-1">
          <TerminalPane
            terminalId={node.paneId}
            cwd={info.cwd}
            initialCommand={info.command}
            active={active}
          />
        </div>
      </section>
    )
  }

  const col = node.dir === 'col'
  return (
    <div className={`flex min-h-0 min-w-0 flex-1 ${col ? 'flex-col' : 'flex-row'}`}>
      <div
        className="min-h-0 min-w-0 shrink-0 grow-0 overflow-hidden"
        style={{ flexBasis: `${node.ratio * 100}%` }}
      >
        <PaneTree
          node={node.a}
          panes={panes}
          activePaneId={activePaneId}
          onFocusPane={onFocusPane}
          onClosePane={onClosePane}
          onResize={onResize}
        />
      </div>
      <PaneDivider dir={node.dir} splitId={node.splitId} ratio={node.ratio} onResize={onResize} />
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <PaneTree
          node={node.b}
          panes={panes}
          activePaneId={activePaneId}
          onFocusPane={onFocusPane}
          onClosePane={onClosePane}
          onResize={onResize}
        />
      </div>
    </div>
  )
}

/**
 * The hairline between two split children: a 1px visual line with a generous
 * hit area. Drags recompute the split ratio from the parent box; arrow keys
 * nudge by 5% for keyboard-only resizing.
 */
function PaneDivider({
  dir,
  splitId,
  ratio,
  onResize,
}: {
  dir: SplitDir
  splitId: string
  ratio: number
  onResize: (splitId: string, ratio: number) => void
}) {
  const [dragging, setDragging] = useState(false)
  const col = dir === 'col'

  const ratioFromEvent = (e: React.PointerEvent<HTMLDivElement>): number | null => {
    const parent = e.currentTarget.parentElement
    if (parent === null) return null
    const rect = parent.getBoundingClientRect()
    const frac = col
      ? (e.clientY - rect.top) / Math.max(rect.height, 1)
      : (e.clientX - rect.left) / Math.max(rect.width, 1)
    return frac
  }

  return (
    <div
      role="separator"
      aria-label="Resize panes"
      aria-orientation={col ? 'horizontal' : 'vertical'}
      aria-valuemin={15}
      aria-valuemax={85}
      aria-valuenow={Math.round(ratio * 100)}
      tabIndex={0}
      title="Drag to resize · arrow keys to nudge"
      onPointerDown={(e) => {
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        setDragging(true)
      }}
      onPointerMove={(e) => {
        if (!dragging) return
        const frac = ratioFromEvent(e)
        if (frac !== null) onResize(splitId, frac)
      }}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
      onKeyDown={(e) => {
        const decrease = col ? 'ArrowUp' : 'ArrowLeft'
        const increase = col ? 'ArrowDown' : 'ArrowRight'
        if (e.key !== decrease && e.key !== increase) return
        e.preventDefault()
        onResize(splitId, ratio + (e.key === increase ? 0.05 : -0.05))
      }}
      className={`group flex shrink-0 items-center justify-center transition-colors focus-visible:outline-none ${
        col ? 'h-2 w-full cursor-row-resize' : 'h-full w-2 cursor-col-resize'
      } ${dragging ? 'bg-accent-subtle' : 'hover:bg-surface-1'}`}
    >
      <div
        aria-hidden="true"
        className={`${col ? 'h-px w-full' : 'h-full w-px'} transition-colors ${
          dragging
            ? 'bg-accent'
            : 'bg-border group-hover:bg-accent-subtle group-focus-visible:bg-accent'
        }`}
      />
    </div>
  )
}

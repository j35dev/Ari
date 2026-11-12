import { useEffect, useState } from 'react'
import { Folder, Monitor, Plus } from 'lucide-react'
import { remoteProjectSchema, type RemoteProject } from '@ari/contracts/remote'
import { sessionSummarySchema, type SessionSummary } from '@ari/contracts/rpc'
import type { MachineView } from '@ari/contracts/machines'
import { useMachines, machineCan } from './use-machines'
import { messageOf, remoteQuery } from './remote-client'

interface Inventory {
  projects: RemoteProject[]
  sessions: SessionSummary[]
  error: string | null
}
const empty: Inventory = { projects: [], sessions: [], error: null }
const cache = new Map<string, Inventory>()

export function useMachineInventory(machine: MachineView) {
  const [inventory, setInventory] = useState(() => cache.get(machine.id) ?? empty)
  useEffect(() => {
    let alive = true
    let busy = false
    const refresh = async () => {
      if (busy || !machineCan(machine, 'project.list') || !machineCan(machine, 'session.list'))
        return
      busy = true
      try {
        const [projects, sessions] = await Promise.all([
          remoteQuery(machine.id, { op: 'project.list' }),
          remoteQuery(machine.id, { op: 'session.list' }),
        ])
        if (!alive) return
        const next = {
          projects: remoteProjectSchema.array().parse(projects),
          sessions: sessionSummarySchema.array().parse(sessions),
          error: null,
        }
        cache.set(machine.id, next)
        setInventory(next)
      } catch (error) {
        if (alive) setInventory((old) => ({ ...old, error: messageOf(error) }))
      } finally {
        busy = false
      }
    }
    void refresh()
    const interval = setInterval(() => void refresh(), 10_000)
    return () => {
      alive = false
      clearInterval(interval)
    }
  }, [machine.id, machine.status, machine.identity])
  return inventory
}

export function RemoteMachineGroups({
  selected,
  onOpen,
  onManage,
  query = '',
}: {
  selected?: { machineId: string; sessionId: string | null } | null
  onOpen: (machineId: string, sessionId: string | null) => void
  onManage: () => void
  query?: string
}) {
  const { machines } = useMachines()
  if (machines.length === 0) return null
  return (
    <section
      aria-label="Remote computers"
      className="ari-scroll max-h-[40vh] shrink-0 overflow-y-auto border-t border-border/60 px-3 py-3"
    >
      <div className="mb-2 flex items-center justify-between">
        <h2 className="px-2 text-xs font-medium text-fg-subtle">Remote computers</h2>
        <button
          type="button"
          className="rounded px-2 py-1 text-xs text-fg-muted hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent-ring"
          onClick={onManage}
        >
          Manage
        </button>
      </div>
      {machines.map((machine) => (
        <MachineGroup
          key={machine.id}
          machine={machine}
          selected={selected}
          onOpen={onOpen}
          query={query}
        />
      ))}
    </section>
  )
}

function MachineGroup({
  machine,
  selected,
  onOpen,
  query,
}: {
  machine: MachineView
  selected?: { machineId: string; sessionId: string | null } | null
  onOpen: (machineId: string, sessionId: string | null) => void
  query: string
}) {
  const inventory = useMachineInventory(machine)
  const match = query.trim().toLowerCase()
  return (
    <div className="mb-2" data-machine-id={machine.id}>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onOpen(machine.id, null)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-medium text-fg hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent-ring"
        >
          <Monitor size={14} className="shrink-0 text-fg-muted" />
          <span className="truncate">{machine.name}</span>
          <span
            className={`ml-auto text-[10px] ${machine.status === 'connected' ? 'text-success' : 'text-fg-subtle'}`}
          >
            {machine.status}
          </span>
        </button>
        <button
          type="button"
          aria-label={`New session on ${machine.name}`}
          disabled={!machineCan(machine, 'session.create')}
          className="rounded p-1 text-fg-muted hover:bg-surface-2 disabled:opacity-40"
          onClick={() => onOpen(machine.id, null)}
        >
          <Plus size={13} />
        </button>
      </div>
      {inventory.projects.map((project) => {
        const sessions = inventory.sessions.filter(
          (session) =>
            session.projectId === project.id &&
            !session.archived &&
            (!match ||
              `${machine.name} ${project.name} ${session.title}`.toLowerCase().includes(match)),
        )
        if (match && sessions.length === 0) return null
        return (
          <div key={project.id} className="ml-3 border-l border-border/60 pl-2">
            <p className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-fg-subtle">
              <Folder size={11} />
              {project.name}
            </p>
            {sessions.map((session) => (
              <button
                type="button"
                key={session.id}
                title={`${machine.name} / ${project.name} / ${session.title}`}
                aria-current={
                  selected?.machineId === machine.id && selected.sessionId === session.id
                    ? 'page'
                    : undefined
                }
                onClick={() => onOpen(machine.id, session.id)}
                className={`block w-full truncate rounded-md px-2 py-1.5 text-left text-xs hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent-ring ${selected?.machineId === machine.id && selected.sessionId === session.id ? 'bg-accent-subtle text-fg' : 'text-fg-muted'}`}
              >
                {session.title || 'Untitled session'}
              </button>
            ))}
          </div>
        )
      })}
      {inventory.error && <p className="px-2 py-1 text-xs text-warning">{inventory.error}</p>}
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Monitor, Plus } from 'lucide-react'
import { Button } from '@ari/ui/button'
import { Input } from '@ari/ui/input'
import { z } from 'zod'
import type { MachineView } from '@ari/contracts/machines'
import { useMachines, machineCan } from './use-machines'
import { RemoteMachineGroups, useMachineInventory } from './RemoteMachineGroups'
import { messageOf, readReceipt, resolveReceipt, sendRemote } from './remote-client'
import {
  RemoteConfiguration,
  SELECT_CLASS,
  useRemoteCatalog,
} from './RemoteConfiguration'
import { RemoteSession } from './RemoteSession'
import { readCreationDraft, writeCreationDraft, type RemoteCreationDraft } from './remote-drafts'

export interface RemoteTarget {
  machineId: string
  sessionId: string | null
}
export const createdSessionSchema = z.object({ sessionId: z.string().min(1) })

export function RemoteWorkspace({
  target,
  onSelect,
  onBack,
  onManage,
}: {
  target: RemoteTarget
  onSelect: (machineId: string, sessionId: string | null) => void
  onBack: () => void
  onManage: () => void
}) {
  const { machines } = useMachines()
  const machine = machines.find((machine) => machine.id === target.machineId)
  return (
    <div className="flex min-h-0 flex-1" aria-label="Remote workspace">
      <aside className="flex w-[var(--ari-sidebar-width)] shrink-0 flex-col bg-surface-0">
        <div className="p-3">
          <Button variant="ghost" className="w-full justify-start" onClick={onBack}>
            <ArrowLeft size={14} />
            This computer
          </Button>
        </div>
        <RemoteMachineGroups selected={target} onOpen={onSelect} onManage={onManage} />
        <div className="mt-auto border-t border-border p-4 text-xs leading-relaxed text-fg-subtle">
          Remote work runs on the selected computer. Its files and credentials stay there.
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col border-l border-border bg-bg">
        {machine ? (
          <>
            <header className="flex h-[46px] shrink-0 items-center gap-2 border-b border-border px-5">
              <Monitor size={15} className="text-fg-muted" />
              <span className="text-sm font-medium">{machine.name}</span>
              <span className="text-xs text-fg-muted">Remote · {machine.status}</span>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                disabled={!machineCan(machine, 'session.create')}
                onClick={() => onSelect(machine.id, null)}
              >
                <Plus size={13} />
                New session
              </Button>
            </header>
            {machine.status !== 'connected' && (
              <div
                role="status"
                className="border-b border-border bg-surface-1 px-5 py-3 text-sm text-warning"
              >
                {machine.status === 'incompatible'
                  ? 'Update Ari on this host to continue.'
                  : `${machine.name} is ${machine.status}. Reconnect in Machines. Drafts and unconfirmed submissions are retained.`}
                <Button size="sm" variant="ghost" className="ml-3" onClick={onManage}>
                  Open Machines
                </Button>
              </div>
            )}
            {target.sessionId ? (
              <RemoteSession
                key={JSON.stringify([machine.id, target.sessionId])}
                machine={machine}
                sessionId={target.sessionId}
                onOpenSession={(id) => onSelect(machine.id, id)}
              />
            ) : (
              <RemoteNewSession
                key={machine.id}
                machine={machine}
                onCreated={(id) => onSelect(machine.id, id)}
              />
            )}
          </>
        ) : (
          <div className="m-auto space-y-3 text-center text-sm">
            <p>This computer is no longer available.</p>
            <Button onClick={onManage}>Open Machines</Button>
          </div>
        )}
      </main>
    </div>
  )
}

function RemoteNewSession({
  machine,
  onCreated,
}: {
  machine: MachineView
  onCreated: (id: string) => void
}) {
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const { projects, error: inventoryError } = useMachineInventory(machine)
  const { catalog, error: catalogError } = useRemoteCatalog(machine)
  const [draft, setDraft] = useState(() => readCreationDraft(machine.id))
  const { projectId, title, selection } = draft
  const [storageError, setStorageError] = useState<string | null>(null)
  const updateDraft = (next: RemoteCreationDraft) => {
    setDraft(next)
    try { writeCreationDraft(machine.id, next); setStorageError(null) }
    catch { setStorageError('The host creation draft could not be saved. Free browser storage before creating a session.') }
  }
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scope = 'new-session'
  const [pending, setPending] = useState(() => readReceipt(machine.id, scope) !== null)
  const provider =
    catalog?.providers.find(
      (row) => row.driverKind === catalog.defaults?.driverKind && row.available,
    ) ?? catalog?.providers.find((row) => row.available)
  const choice =
    selection ??
    (provider
      ? {
          driverKind: provider.driverKind,
          modelId: provider.defaultModelId ?? provider.models[0]?.id ?? '',
          permissionMode: catalog?.defaults?.permissionMode ?? 'ask',
          effort: null,
        }
      : null)
  const project = projectId || projects[0]?.id || ''
  useEffect(() => {
    if ((!draft.projectId && projects[0]) || (!draft.selection && choice)) {
      updateDraft({ ...draft, projectId: draft.projectId || project, selection: draft.selection ?? choice })
    }
  }, [catalog, projects, draft, machine.id])
  async function create(retry = false, check = false): Promise<void> {
    if (!alive.current || storageError || !machineCan(machine, 'session.create') || (!pending && (!choice || !projects.some((entry) => entry.id === project)))) return
    setBusy(true)
    setError(null)
    try {
      const result = pending
        ? await resolveReceipt(machine.id, scope, retry && !check)
        : await sendRemote(machine.id, scope, {
            op: 'session.create',
            projectId: project,
            ...(title.trim() ? { title: title.trim() } : {}),
            ...choice!,
            ...(choice!.modelId ? { modelId: choice!.modelId } : { modelId: undefined }),
          })
      const id = createdSessionSchema.parse(result).sessionId
      writeCreationDraft(machine.id, { projectId: '', title: '', selection: null })
      if (alive.current) onCreated(id)
    } catch (error) {
      setError(messageOf(error))
    } finally {
      setBusy(false)
      setPending(readReceipt(machine.id, scope) !== null)
    }
  }
  return (
    <div className="ari-scroll min-h-0 flex-1 overflow-y-auto p-8">
      <form
        className="mx-auto max-w-xl space-y-5"
        onSubmit={(event) => {
          event.preventDefault()
          void create()
        }}
      >
        <div>
          <h1 className="text-xl font-semibold">New session on {machine.name}</h1>
          <p className="mt-1 text-sm text-fg-muted">
            Choose a project and provider registered on this host.
          </p>
        </div>
        <label className="block text-xs text-fg-muted">
          Host project
          <select
            className={SELECT_CLASS}
            value={project}
            disabled={busy || pending}
            onChange={(event) => updateDraft({ ...draft, projectId: event.target.value })}
          >
            <option value="" disabled>
              Choose a project
            </option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-fg-muted">
          Session name
          <Input
            className="mt-1 w-full"
            value={title}
            maxLength={200}
            placeholder="New session"
            disabled={busy || pending}
            onChange={(event) => updateDraft({ ...draft, title: event.target.value })}
          />
        </label>
        {catalog && choice && (
          <RemoteConfiguration
            machine={machine}
            catalog={catalog}
            value={choice}
            onChange={(selection) => updateDraft({ ...draft, selection })}
            disabled={busy || pending}
          />
        )}
        {projects.length === 0 && machine.status === 'connected' && (
          <p className="text-sm text-fg-muted">
            No host projects are available. Add a project on that computer.
          </p>
        )}
        {(storageError ?? error ?? inventoryError ?? catalogError) && (
          <p role="alert" className="text-sm text-danger">
            {storageError ?? error ?? inventoryError ?? catalogError}
          </p>
        )}
        {pending ? (
          <div className="space-y-3 rounded-md border border-warning/40 p-3">
            <p className="text-sm text-warning">
              Session creation is unconfirmed. Check its saved receipt on {machine.name}.
            </p>
            <div className="flex gap-2">
              <Button
                disabled={busy || machine.status !== 'connected'}
                onClick={() => void create(false, true)}
              >
                Check creation
              </Button>
              <Button
                disabled={busy || machine.status !== 'connected'}
                onClick={() => void create(true)}
              >
                Retry saved creation
              </Button>
            </div>
          </div>
        ) : (
          <Button
            type="submit"
            variant="primary"
            disabled={busy || storageError !== null || !projects.some((entry) => entry.id === project) || !choice || !machineCan(machine, 'session.create')}
          >
            Create on {machine.name}
          </Button>
        )}
      </form>
    </div>
  )
}

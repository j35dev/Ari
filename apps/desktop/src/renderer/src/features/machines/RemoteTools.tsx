import { useEffect, useState } from 'react'
import { z } from 'zod'
import { Button } from '@ari/ui/button'
import type { MachineView } from '@ari/contracts/machines'
import {
  remoteChangesSchema,
  remoteChangeDiffSchema,
  remoteFileSchema,
  remoteFilesSchema,
  remoteIntegrationPreviewSchema,
  type RemoteQuery,
  type RemoteIntegrationPreview,
} from '@ari/contracts/remote'
import { machineCan } from './use-machines'
import { remoteQuery, messageOf, type RemoteAction } from './remote-client'

function useRemoteRead<T>(machine: MachineView, query: RemoteQuery | null, schema: z.ZodType<T>) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const serialized = JSON.stringify(query)
  useEffect(() => {
    let alive = true
    setData(null)
    setError(null)
    const requested = JSON.parse(serialized) as RemoteQuery | null
    if (requested && machineCan(machine, requested.op))
      void remoteQuery(machine.id, requested)
        .then((raw) => {
          if (alive) setData(schema.parse(raw))
        })
        .catch((error: unknown) => {
          if (alive) setError(messageOf(error))
        })
    return () => {
      alive = false
    }
  }, [machine.id, machine.status, serialized, schema, revision])
  return { data, error, refresh: () => setRevision((value) => value + 1) }
}

export function RemoteFiles({ machine, sessionId }: { machine: MachineView; sessionId: string }) {
  const [path, setPath] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [cursor, setCursor] = useState<string | undefined>()
  const list = useRemoteRead(
    machine,
    { op: 'files.list', sessionId, path, cursor, limit: 100 },
    remoteFilesSchema,
  )
  const file = useRemoteRead(
    machine,
    selected ? { op: 'files.read', sessionId, path: selected } : null,
    remoteFileSchema,
  )
  const openDirectory = (next: string) => {
    setPath(next)
    setCursor(undefined)
    setSelected(null)
  }
  return (
    <div className="flex min-h-0 flex-1">
      <section
        aria-label="Host files"
        className="ari-scroll w-64 shrink-0 overflow-y-auto border-r border-border p-4"
      >
        <div className="mb-3 flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" onClick={() => openDirectory('')}>
            Workspace
          </Button>
          {path && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => openDirectory(path.split('/').slice(0, -1).join('/'))}
            >
              Up
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={machine.status !== 'connected'}
            onClick={list.refresh}
          >
            Refresh
          </Button>
        </div>
        <p className="mb-2 break-all font-mono text-xs text-fg-subtle">
          {path || '/'} · {machine.name}
        </p>
        {list.data?.entries.map((entry) => (
          <button
            key={entry.path}
            type="button"
            className="block w-full truncate rounded-md px-2 py-2 text-left text-xs text-fg-muted hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent-ring"
            onClick={() =>
              entry.kind === 'directory' ? openDirectory(entry.path) : setSelected(entry.path)
            }
          >
            {entry.kind === 'directory' ? '▸ ' : ''}
            {entry.name}
          </button>
        ))}
        {list.data?.nextCursor && (
          <Button size="sm" onClick={() => setCursor(list.data!.nextCursor!)}>
            Next files
          </Button>
        )}
        {cursor && (
          <Button size="sm" onClick={() => setCursor(undefined)}>
            First files
          </Button>
        )}
        {list.data?.entries.length === 0 && (
          <p className="text-xs text-fg-subtle">This folder is empty.</p>
        )}
        {(list.error ?? list.data?.error) && (
          <p role="alert" className="text-xs text-danger">
            {list.error ?? list.data?.error}
          </p>
        )}
        {!machineCan(machine, 'files.list') && (
          <p className="text-xs text-fg-muted">
            Host files are unavailable while disconnected or unsupported.
          </p>
        )}
      </section>
      <section
        aria-label="Host file preview"
        className="ari-scroll min-w-0 flex-1 overflow-auto p-5"
      >
        {selected ? (
          <>
            <h2 className="mb-4 break-all font-mono text-sm">{selected}</h2>
            {file.data?.content !== null && file.data?.content !== undefined ? (
              <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
                {file.data.content}
              </pre>
            ) : (
              <p className="text-sm text-fg-muted">
                {file.error ??
                  file.data?.error ??
                  (file.data?.kind === 'binary'
                    ? 'Binary file preview is unavailable.'
                    : file.data?.kind === 'too-large'
                      ? 'This file exceeds the host preview limit.'
                      : 'Loading host file…')}
              </p>
            )}
          </>
        ) : (
          <p className="m-auto text-sm text-fg-subtle">Select a file on {machine.name}.</p>
        )}
      </section>
    </div>
  )
}

export function RemoteChanges({
  machine,
  sessionId,
  onAction,
  disabled,
}: {
  machine: MachineView
  sessionId: string
  onAction: (action: RemoteAction) => Promise<void>
  disabled: boolean
}) {
  const changes = useRemoteRead(machine, { op: 'changes.files', sessionId }, remoteChangesSchema)
  const [path, setPath] = useState<string | null>(null)
  const diff = useRemoteRead(
    machine,
    path ? { op: 'changes.diff', sessionId, path } : null,
    remoteChangeDiffSchema,
  )
  const [preview, setPreview] = useState<RemoteIntegrationPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  async function previewIntegration(): Promise<void> {
    setBusy(true)
    setError(null)
    setPreview(null)
    try {
      const next = remoteIntegrationPreviewSchema.parse(
        await remoteQuery(machine.id, { op: 'changes.preview', sessionId }),
      )
      if (next.sessionId !== sessionId)
        throw new Error('The host returned another session’s integration.')
      setPreview(next)
    } catch (error) {
      setError(messageOf(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="ari-scroll min-h-0 flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-4xl">
        <div className="mb-4 flex items-center gap-2">
          <h2 className="mr-auto text-lg font-semibold">Changes on {machine.name}</h2>
          <Button
            size="sm"
            onClick={() => {
              changes.refresh()
              diff.refresh()
              setPreview(null)
            }}
            disabled={machine.status !== 'connected'}
          >
            Refresh changes
          </Button>
          {machineCan(machine, 'changes.preview') && (
            <Button size="sm" disabled={busy || disabled} onClick={() => void previewIntegration()}>
              Preview integration
            </Button>
          )}
        </div>
        {(changes.error ?? changes.data?.error ?? error) && (
          <p role="alert" className="mb-3 text-sm text-danger">
            {changes.error ?? changes.data?.error ?? error}
          </p>
        )}
        {changes.data?.files.map((file) => (
          <button
            key={file.path}
            type="button"
            onClick={() => setPath(file.path)}
            className={`mb-1 block w-full rounded-md border border-border px-3 py-2 text-left font-mono text-xs hover:bg-surface-2 ${path === file.path ? 'bg-accent-subtle' : ''}`}
          >
            {file.path}
            {file.isNew
              ? ' · new'
              : file.isDeleted
                ? ' · deleted'
                : file.isBinary
                  ? ' · binary'
                  : ''}
          </button>
        ))}
        {changes.data?.files.length === 0 && (
          <p className="py-8 text-center text-sm text-fg-subtle">
            No changes in this host workspace.
          </p>
        )}
        {path && (
          <section
            aria-label={`Diff for ${path}`}
            className="mt-5 overflow-hidden rounded-lg border border-border"
          >
            <h3 className="border-b border-border bg-surface-1 px-3 py-2 font-mono text-xs">
              {path}
            </h3>
            {diff.data?.file?.hunks.map((hunk, index) => (
              <div key={index} className="overflow-x-auto font-mono text-xs leading-5">
                <p className="bg-surface-2 px-3 text-fg-subtle">{hunk.header}</p>
                {hunk.lines.map((line, index) => (
                  <pre
                    key={index}
                    className={`px-3 ${line.type === 'add' ? 'bg-success/10 text-success' : line.type === 'del' ? 'bg-danger/10 text-danger' : 'text-fg-muted'}`}
                  >
                    {line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' '}
                    {line.content}
                  </pre>
                ))}
              </div>
            ))}
            {(diff.data?.file?.hunks.length ?? 0) === 0 && (
              <p className="p-4 text-xs text-fg-muted">
                {diff.error ??
                  diff.data?.error ??
                  (diff.data?.file?.isBinary ? 'Binary change.' : 'No text diff is available.')}
              </p>
            )}
          </section>
        )}
        {preview && (
          <section
            aria-label="Host integration preview"
            className="mt-5 rounded-lg border border-warning/40 p-4"
          >
            <h3 className="text-sm font-medium">Integrate into the parent on {machine.name}</h3>
            <p className="mt-2 break-all font-mono text-xs text-fg-muted">
              Snapshot {preview.snapshotCommit}
            </p>
            {preview.files.map((file) => (
              <p key={file.path} className="mt-2 font-mono text-xs">
                {file.path} · +{file.additions} −{file.deletions}
              </p>
            ))}
            <div className="mt-4 flex gap-2">
              <Button
                size="sm"
                disabled={disabled || busy || !machineCan(machine, 'changes.integrate')}
                onClick={() => {
                  setBusy(true)
                  void onAction({
                    op: 'changes.integrate',
                    sessionId,
                    snapshotCommit: preview.snapshotCommit,
                    expectedParentSnapshot: preview.expectedParentSnapshot,
                  })
                    .then(() => {
                      setPreview(null)
                      changes.refresh()
                    })
                    .catch((error: unknown) => setError(messageOf(error)))
                    .finally(() => setBusy(false))
                }}
              >
                Confirm host integration
              </Button>
              <Button size="sm" onClick={() => setPreview(null)}>
                Cancel
              </Button>
            </div>
          </section>
        )}
      </div>
    </div>
  )
}

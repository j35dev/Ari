import { useEffect, useMemo, useState } from 'react'
import type { DriverKind } from '@ari/contracts/common'
import type { RpcResults } from '@ari/contracts/rpc'
import { Button } from '@ari/ui/button'
import { Field } from '@ari/ui/field'
import { Select } from '@ari/ui/select'
import type { SelectOption } from '@ari/ui/select'
import { rpc } from '../../lib/rpc'

type Detection = RpcResults['providers.detect'][number]

export interface RaceDialogProps {
  projects: { id: string; name: string }[]
  /** Called after both sessions are created and their first turns started. */
  onLaunched: (sessionAId: string, sessionBId: string) => void
  onClose: () => void
}

function driverLabel(kind: DriverKind): string {
  return kind === 'ari-core' ? 'Ari Core' : kind.charAt(0).toUpperCase() + kind.slice(1)
}

/**
 * A/B provider race launcher (M21.2, Ari's differentiator): one prompt runs
 * simultaneously on two providers in sibling sessions of the same project
 * (each lands in its own worktree); diffs are then comparable from Changes.
 * This slice creates and starts both races — side-by-side comparison lands
 * with M21.2b.
 */
export function RaceDialog({ projects, onLaunched, onClose }: RaceDialogProps) {
  const [installedKinds, setInstalledKinds] = useState<DriverKind[]>([])
  const [projectId, setProjectId] = useState<string>(projects[0]?.id ?? 'adhoc')
  const [kindA, setKindA] = useState<DriverKind | null>(null)
  const [kindB, setKindB] = useState<DriverKind | null>(null)
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void rpc
      .invoke('providers.detect')
      .then((detections: Detection[]) => {
        const kinds = detections
          .filter((d) => d.binaryPath !== null && d.kind !== 'ari-core')
          .map((d) => d.kind as DriverKind)
        // Ari Core always works; put it last so real CLIs lead.
        const all = [...kinds, 'ari-core' as const]
        setInstalledKinds(all)
        setKindA(all[0] ?? 'ari-core')
        setKindB(all[1] ?? all[0] ?? 'ari-core')
      })
      .catch(() => {
        setInstalledKinds(['ari-core'])
        setKindA('ari-core')
        setKindB('ari-core')
      })
  }, [])

  const options = useMemo<SelectOption[]>(
    () => installedKinds.map((k) => ({ value: k, label: driverLabel(k) })),
    [installedKinds],
  )

  const launch = (): void => {
    if (busy || kindA === null || kindB === null) return
    if (prompt.trim().length === 0) {
      setError('Give both racers a prompt.')
      return
    }
    if (kindA === kindB) {
      setError('Pick two different providers for a race.')
      return
    }
    setBusy(true)
    setError(null)
    const text = prompt.trim()
    void rpc
      .invoke('session.create', {
        projectId,
        title: `Race A · ${driverLabel(kindA)}`,
        driverKind: kindA,
        modelId: null,
        permissionMode: 'ask',
      })
      .then((createdA) =>
        rpc
          .invoke('session.create', {
            projectId,
            title: `Race B · ${driverLabel(kindB)}`,
            driverKind: kindB,
            modelId: null,
            permissionMode: 'ask',
          })
          .then((createdB) => ({ createdA, createdB })),
      )
      .then(({ createdA, createdB }) =>
        Promise.all([
          rpc.invoke('command.dispatch', {
            command: { type: 'turn.start', sessionId: createdA.sessionId, text },
          }),
          rpc.invoke('command.dispatch', {
            command: { type: 'turn.start', sessionId: createdB.sessionId, text },
          }),
        ]).then(() => ({ createdA, createdB })),
      )
      .then(({ createdA, createdB }) => onLaunched(createdA.sessionId, createdB.sessionId))
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e))
        setBusy(false)
      })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="New A/B provider race"
        className="w-full max-w-lg rounded-xl border border-border bg-surface-1 p-4 shadow-2"
      >
        <h2 className="text-sm font-semibold text-fg">New A/B provider race</h2>
        <p className="mt-1 text-xs leading-relaxed text-fg-muted">
          The same prompt runs on two providers in sibling worktrees. Watch each transcript, then
          compare their changes in Changes.
        </p>

        <div className="mt-3 flex flex-col gap-3">
          <Field label="Project" hint="Both sessions run inside this workspace's worktrees.">
            {(props) => (
              <Select
                {...props}
                value={projectId}
                onValueChange={(v) => setProjectId(v)}
                options={[
                  ...(projects.length > 0
                    ? projects.map((p) => ({ value: p.id, label: p.name }))
                    : []),
                  { value: 'adhoc', label: 'No project (home dir)' },
                ]}
              />
            )}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Provider A">{(props) => (
              <Select
                {...props}
                value={kindA ?? undefined}
                onValueChange={(v) => setKindA(v as DriverKind)}
                options={options}
              />
            )}</Field>
            <Field label="Provider B">{(props) => (
              <Select
                {...props}
                value={kindB ?? undefined}
                onValueChange={(v) => setKindB(v as DriverKind)}
                options={options}
              />
            )}</Field>
          </div>
          <Field label="Prompt" hint="Sent to both racers at once.">
            {(props) => (
              <textarea
                {...props}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={4}
                placeholder="e.g. Add rate limiting to the login endpoint"
                className="w-full resize-none rounded-md border border-border bg-glass-input px-2.5 py-2 text-sm text-fg placeholder:text-fg-subtle focus:border-border-strong focus:outline-none"
              />
            )}
          </Field>

          {error !== null ? (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          ) : null}

          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={launch} disabled={busy}>
              {busy ? 'Starting…' : 'Start race'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

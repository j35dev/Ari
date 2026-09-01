import { useEffect, useState } from 'react'
import { ArrowLeft, X } from 'lucide-react'
import { Dialog } from '@ari/ui/dialog'
import { SessionImportList } from './SessionImport'

export interface SessionImportDialogProps {
  open: boolean
  project: { id: string; name: string }
  onClose: () => void
  onImported: (sessionId: string) => void | Promise<void>
}

type ImportSource = 'pi'

/** Generic project-scoped import shell. Pi is the only source in V1. */
export function SessionImportDialog({
  open,
  project,
  onClose,
  onImported,
}: SessionImportDialogProps) {
  const [source, setSource] = useState<ImportSource | null>(null)

  useEffect(() => {
    if (!open) setSource(null)
  }, [open])

  const imported = async (sessionId: string): Promise<void> => {
    await onImported(sessionId)
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Content
        size="lg"
        aria-label={`Import into ${project.name}`}
        style={{ width: 'min(920px, 92vw)', height: 'min(680px, 86vh)', overflow: 'hidden' }}
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-border px-5 py-4">
          {source !== null ? (
            <button
              type="button"
              aria-label="Back to import sources"
              onClick={() => setSource(null)}
              className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
            >
              <ArrowLeft size={15} aria-hidden />
            </button>
          ) : null}
          <div className="min-w-0 flex-1">
            <Dialog.Title>Import</Dialog.Title>
            <Dialog.Description className="mt-1">
              Import a session into {project.name}. The source keeps its own copy.
            </Dialog.Description>
          </div>
          <Dialog.Close
            aria-label="Close import"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          >
            <X size={15} aria-hidden />
          </Dialog.Close>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {source === null ? (
            <div className="space-y-3">
              <p className="text-sm font-medium text-fg">Choose a source</p>
              <button
                type="button"
                onClick={() => setSource('pi')}
                className="flex w-full items-center gap-3 rounded-lg border border-border bg-surface-1 px-4 py-3 text-left transition-colors hover:border-accent-ring hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
              >
                <span
                  aria-hidden
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface-3 font-mono text-base font-semibold text-fg"
                >
                  π
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-fg">Pi</span>
                  <span className="block text-xs text-fg-muted">
                    Import sessions stored by the Pi coding agent.
                  </span>
                </span>
              </button>
            </div>
          ) : (
            <section aria-labelledby="project-pi-sessions" className="space-y-3">
              <div>
                <h3 id="project-pi-sessions" className="text-sm font-medium text-fg">
                  Pi sessions
                </h3>
                <p className="mt-1 text-xs text-fg-muted">
                  Only sessions recorded for this project are shown.
                </p>
              </div>
              <SessionImportList
                projectId={project.id}
                emptyMessage="No Pi sessions found for this project."
                onImported={imported}
              />
            </section>
          )}
        </div>
      </Dialog.Content>
    </Dialog>
  )
}

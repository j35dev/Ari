import { useEffect, useState } from 'react'
import { ArrowLeft, X } from 'lucide-react'
import { Dialog } from '@ari/ui/dialog'
import { card, iconButton } from '../../lib/recipes'
import {
  SETTINGS_CAPTION_CLASS,
  SETTINGS_HINT_CLASS,
  SETTINGS_LABEL_CLASS,
} from '../settings/SettingsSection'
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
              className={iconButton}
            >
              <ArrowLeft size={16} strokeWidth={1.7} aria-hidden />
            </button>
          ) : null}
          <div className="min-w-0 flex-1">
            <Dialog.Title>Import</Dialog.Title>
            <Dialog.Description className="mt-1">
              Import a session into {project.name}. The source keeps its own copy.
            </Dialog.Description>
          </div>
          <Dialog.Close aria-label="Close import" className={iconButton}>
            <X size={16} strokeWidth={1.7} aria-hidden />
          </Dialog.Close>
        </header>

        <div className="ari-scroll min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {source === null ? (
            <div>
              <p className={`mb-2.5 ${SETTINGS_CAPTION_CLASS}`}>Choose a source</p>
              <button
                type="button"
                onClick={() => setSource('pi')}
                className={`${card} flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-fg/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring`}
              >
                <span
                  aria-hidden
                  className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-2 font-mono text-sm font-medium text-fg-muted"
                >
                  π
                </span>
                <span className="min-w-0">
                  <span className={`block ${SETTINGS_LABEL_CLASS}`}>Pi</span>
                  <span className={`mt-0.5 block ${SETTINGS_HINT_CLASS}`}>
                    Import sessions stored by the Pi coding agent.
                  </span>
                </span>
              </button>
            </div>
          ) : (
            <section aria-labelledby="project-pi-sessions">
              <div className="mb-1">
                <h3 id="project-pi-sessions" className={SETTINGS_CAPTION_CLASS}>
                  Pi sessions
                </h3>
                <p className={`mt-0.5 ${SETTINGS_HINT_CLASS}`}>
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

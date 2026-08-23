import { useCallback, useEffect, useState } from 'react'
import { Button } from '@ari/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@ari/ui/dialog'
import { rpc } from '../../lib/rpc'

function fileName(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] ?? path
}

interface FileEditorProps {
  /** Absolute path of the file being edited (inside the explorer root). */
  path: string
  /** Closes the editor; unsaved edits are discarded. */
  onClose: () => void
  /** Called after a successful save so listings can refresh. */
  onSaved?: () => void
}

/**
 * Modal text editor for files opened from the FileExplorer. Loads via
 * `fs.readTextFile`, saves through `fs.writeTextFile`; Escape, the scrim and
 * Cancel all close without writing. Files over the edit cap or binary ones
 * render an error instead of an editable buffer.
 */
export function FileEditor({ path, onClose, onSaved }: FileEditorProps) {
  const [original, setOriginal] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    setOriginal(null)
    setDraft('')
    setError(null)
    void rpc
      .invoke('fs.readTextFile', { path })
      .then((result) => {
        if (cancelled) return
        // A truncated read means the file is larger than we hold in memory;
        // saving would silently drop the tail, so editing is refused.
        if (result.truncated) {
          setError('file exceeds the 512 KiB edit cap')
          return
        }
        setOriginal(result.content)
        setDraft(result.content)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [path])

  const dirty = original !== null && draft !== original

  const save = useCallback((): void => {
    if (!dirty || saving) return
    setSaving(true)
    setError(null)
    void rpc
      .invoke('fs.writeTextFile', { path, content: draft })
      .then(() => {
        setOriginal(draft)
        onSaved?.()
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        setSaving(false)
      })
  }, [dirty, draft, onSaved, path, saving])

  const loaded = original !== null

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="lg" aria-label={`Edit ${fileName(path)}`}>
        <header className="flex items-center gap-2 border-b border-border px-5 py-3">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate font-mono text-sm">{fileName(path)}</DialogTitle>
            <DialogDescription className="truncate font-mono text-xs">
              {path}
            </DialogDescription>
          </div>
          {dirty && (
            <span className="shrink-0 font-mono text-xs text-warning">unsaved changes</span>
          )}
        </header>
        <div className="flex min-h-0 flex-1 flex-col px-5 py-3">
          {loaded ? (
            <textarea
              aria-label="File contents"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              spellCheck={false}
              className="h-full min-h-0 w-full flex-1 resize-none rounded-md border border-border bg-surface-1 p-2 font-mono text-xs text-fg outline-none focus:ring-2 focus:ring-accent-ring"
            />
          ) : (
            error != null && (
              <p role="alert" className="font-mono text-xs text-danger">
                {error}
              </p>
            )
          )}
        </div>
        <footer className="flex items-center gap-2 border-t border-border px-5 py-3">
          {error != null && loaded && (
            <p role="alert" className="min-w-0 flex-1 truncate font-mono text-xs text-danger">
              {error}
            </p>
          )}
          <div className={error != null && loaded ? '' : 'flex-1'} />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} disabled={!dirty} onClick={save}>
            Save
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  )
}

import { useEffect, useState } from 'react'
import { Dialog } from '@ari/ui/dialog'
import { Kbd } from '@ari/ui/kbd'
import { resolveChord } from './KeybindingsSettings'
import { APP_SHORTCUTS } from './shortcuts'

interface CheatShortcut {
  /** Stable logical action id, shared with the future keybindings layer. */
  id: string
  /** Human-readable row label. */
  label: string
  /** Logical chord; `Mod` resolves per platform at render time. */
  chord?: string
  /** Literal keys rendered without chord resolution (composites like Y/A/N). */
  keys?: readonly string[]
}

/**
 * The complete logical keyboard map (M13.6): the shared global shortcuts
 * (single source in shortcuts.ts) plus context-local chords for the composer,
 * approvals, and question panel.
 */
const CHEAT_SHEET_SHORTCUTS: readonly CheatShortcut[] = [
  ...APP_SHORTCUTS,
  { id: 'OpenCheatSheet', label: 'Open this cheat sheet', chord: '?' },
  { id: 'SendTurn', label: 'Send message', chord: 'Enter' },
  { id: 'InsertNewline', label: 'New line in composer', chord: 'Shift+Enter' },
  { id: 'StashPrompt', label: 'Stash the composer draft', chord: 'Mod+S' },
  { id: 'AnswerApproval', label: 'Answer an approval card', keys: ['Y', 'A', 'N'] },
  { id: 'PickQuestionOption', label: 'Pick a question option', keys: ['1–9'] },
]

function shortcutKeys(shortcut: CheatShortcut): readonly string[] {
  return shortcut.keys ?? resolveChord(shortcut.chord ?? '')
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/**
 * Keyboard cheat-sheet overlay (M13.6): opens on a bare `?` press anywhere no
 * editable element has focus and lists every logical shortcut in a two-column
 * table. Escape, scrim click, and the close button dismiss it via the shared
 * dialog focus trap.
 */
export function KeyboardCheatSheet() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== '?' || event.ctrlKey || event.metaKey || event.altKey) return
      if (isEditableTarget(event.target)) return
      event.preventDefault()
      setOpen(true)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Dialog.Content className="w-[min(560px,90vw)]">
        <Dialog.Title>Keyboard shortcuts</Dialog.Title>
        <Dialog.Description>Every shortcut the workspace responds to.</Dialog.Description>
        <table className="mt-3 w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className="py-1.5 pr-3 text-left font-medium text-fg-muted">
                Action
              </th>
              <th scope="col" className="py-1.5 text-left font-medium text-fg-muted">
                Keys
              </th>
            </tr>
          </thead>
          <tbody>
            {CHEAT_SHEET_SHORTCUTS.map((shortcut) => {
              const keys = shortcutKeys(shortcut)
              return (
                <tr key={shortcut.id} className="border-b border-border last:border-b-0">
                  <td className="py-1.5 pr-3 align-middle text-fg">{shortcut.label}</td>
                  <td className="py-1.5 align-middle">
                    <span
                      className="flex items-center gap-1"
                      aria-label={`${shortcut.label}: ${keys.join(' plus ')}`}
                    >
                      {keys.map((key) => (
                        <Kbd key={key}>{key}</Kbd>
                      ))}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <div className="mt-4 flex justify-end">
          <Dialog.Close className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-fg-on-accent transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring">
            Close
          </Dialog.Close>
        </div>
      </Dialog.Content>
    </Dialog>
  )
}

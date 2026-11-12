import { Dialog } from '@ari/ui/dialog'
import { SettingsWorkspace, type SettingsWorkspaceProps } from './SettingsWorkspace'

/**
 * Settings as a dialog over the workspace. The conversation stays mounted and
 * visible behind the scrim, so opening settings never loses the user's place.
 * Escape, the scrim and the close button all dismiss it.
 */
export function SettingsDialog({
  open,
  onOpenChange,
  ...workspace
}: Omit<SettingsWorkspaceProps, 'onBack'> & {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Dialog.Content
        size="lg"
        aria-label="Settings"
        aria-labelledby={undefined}
        aria-describedby={undefined}
        className="h-[min(780px,88vh)]! w-[min(1120px,94vw)]! bg-surface-0!"
      >
        <SettingsWorkspace {...workspace} onBack={() => onOpenChange(false)} />
      </Dialog.Content>
    </Dialog>
  )
}

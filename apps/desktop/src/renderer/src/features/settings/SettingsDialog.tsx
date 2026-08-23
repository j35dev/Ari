import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { Dialog } from '@ari/ui/dialog'
import { AppearanceSettings } from './AppearanceSettings'
import { AdvancedSettings } from './AdvancedSettings'
import { KeybindingsSettings } from './KeybindingsSettings'
import { PermissionsSettings } from './PermissionsSettings'
import { SettingsSearch } from './SettingsSearch'
import { ProvidersView } from '../providers'
import { EndpointsManager } from '../endpoints'

export const SETTINGS_SECTIONS = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'providers', label: 'Providers' },
  { id: 'endpoints', label: 'Endpoints' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'keybindings', label: 'Keybindings' },
  { id: 'advanced', label: 'Advanced' },
] as const

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id']

export interface SettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialSection?: SettingsSectionId
}

function isSettingsSection(value: string): value is SettingsSectionId {
  return SETTINGS_SECTIONS.some((section) => section.id === value)
}

/**
 * Overlay settings workspace. Chat stays mounted underneath; Escape / scrim
 * / close dismisses without changing the session pane.
 */
export function SettingsDialog({
  open,
  onOpenChange,
  initialSection = 'appearance',
}: SettingsDialogProps) {
  const [section, setSection] = useState<SettingsSectionId>(initialSection)

  useEffect(() => {
    if (open) setSection(initialSection)
  }, [open, initialSection])

  const handleSearchJump = (searchId: string): void => {
    const slug = searchId.replace(/^settings-/, '')
    if (isSettingsSection(slug)) setSection(slug)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <Dialog.Content size="lg" className="overflow-hidden">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
          <Dialog.Title>Settings</Dialog.Title>
          <Dialog.Description className="sr-only">
            Appearance, providers, endpoints, permissions, keybindings, and advanced options.
          </Dialog.Description>
          <div className="flex-1" />
          <Dialog.Close
            aria-label="Close settings"
            className="flex h-7 w-7 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-glass-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          >
            <X size={14} />
          </Dialog.Close>
        </header>

        <div className="flex min-h-0 flex-1">
          <nav
            aria-label="Settings sections"
            className="flex w-52 shrink-0 flex-col gap-2 border-r border-border p-3"
          >
            <SettingsSearch onJump={handleSearchJump} />
            <div role="tablist" aria-orientation="vertical" className="flex flex-col gap-0.5">
              {SETTINGS_SECTIONS.map((entry) => {
                const selected = entry.id === section
                return (
                  <button
                    key={entry.id}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    id={`settings-tab-${entry.id}`}
                    onClick={() => setSection(entry.id)}
                    className={`rounded-md px-2.5 py-1.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring ${
                      selected
                        ? 'bg-accent-subtle font-medium text-accent'
                        : 'text-fg-muted hover:bg-glass-hover hover:text-fg'
                    }`}
                  >
                    {entry.label}
                  </button>
                )
              })}
            </div>
          </nav>

          <div
            role="tabpanel"
            aria-labelledby={`settings-tab-${section}`}
            className="ari-scroll min-w-0 flex-1 overflow-y-auto"
          >
            {section === 'appearance' ? <AppearanceSettings /> : null}
            {section === 'providers' ? (
              <div id="settings-providers" className="p-8">
                <ProvidersView />
              </div>
            ) : null}
            {section === 'endpoints' ? (
              <div id="settings-endpoints" className="p-8">
                <EndpointsManager />
              </div>
            ) : null}
            {section === 'permissions' ? <PermissionsSettings /> : null}
            {section === 'keybindings' ? <KeybindingsSettings /> : null}
            {section === 'advanced' ? <AdvancedSettings /> : null}
          </div>
        </div>
      </Dialog.Content>
    </Dialog>
  )
}

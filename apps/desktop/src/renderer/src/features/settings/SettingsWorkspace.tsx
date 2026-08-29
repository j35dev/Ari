import { useEffect, useState } from 'react'
import {
  ArrowLeft,
  Cpu,
  Keyboard,
  Palette,
  Plug,
  Shield,
  SlidersHorizontal,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { AppearanceSettings } from './AppearanceSettings'
import { AdvancedSettings } from './AdvancedSettings'
import { KeybindingsSettings } from './KeybindingsSettings'
import { PermissionsSettings } from './PermissionsSettings'
import { SettingsSearch } from './SettingsSearch'
import { ProvidersView } from '../providers'
import { EndpointsManager } from '../endpoints'

export const SETTINGS_SECTIONS = [
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'providers', label: 'Providers', icon: Cpu },
  { id: 'endpoints', label: 'Endpoints', icon: Plug },
  { id: 'permissions', label: 'Permissions', icon: Shield },
  { id: 'keybindings', label: 'Keybindings', icon: Keyboard },
  { id: 'advanced', label: 'Advanced', icon: SlidersHorizontal },
] as const

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id']

export interface SettingsWorkspaceProps {
  section?: SettingsSectionId
  onSectionChange?: (section: SettingsSectionId) => void
  onBack: () => void
}

function isSettingsSection(value: string): value is SettingsSectionId {
  return SETTINGS_SECTIONS.some((entry) => entry.id === value)
}

function sectionLabel(id: SettingsSectionId): string {
  return SETTINGS_SECTIONS.find((entry) => entry.id === id)?.label ?? id
}

/**
 * T3-style settings mode: the sessions sidebar is replaced by a section
 * list + Back, and the main pane shows one page. Chat stays mounted in the
 * parent — this view is swapped in, not overlaid.
 */
export function SettingsWorkspace({
  section: controlledSection,
  onSectionChange,
  onBack,
}: SettingsWorkspaceProps) {
  const [internal, setInternal] = useState<SettingsSectionId>('appearance')
  const section = controlledSection ?? internal

  useEffect(() => {
    if (controlledSection) setInternal(controlledSection)
  }, [controlledSection])

  const setSection = (next: SettingsSectionId): void => {
    setInternal(next)
    onSectionChange?.(next)
  }

  const handleSearchJump = (searchId: string): void => {
    const slug = searchId.replace(/^settings-/, '')
    if (isSettingsSection(slug)) setSection(slug)
  }

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="ari-glass flex w-[var(--ari-sidebar-width)] shrink-0 flex-col">
        <div className="flex items-center px-3 pb-1 pt-3">
          <span className="text-sm font-semibold tracking-tight text-fg">Settings</span>
        </div>
        <div className="px-3 pb-2 pt-1">
          <SettingsSearch onJump={handleSearchJump} />
        </div>
        <nav aria-label="Settings sections" className="min-h-0 flex-1 overflow-y-auto px-2">
          <ul className="flex flex-col gap-0.5">
            {SETTINGS_SECTIONS.map((entry) => {
              const Icon: LucideIcon = entry.icon
              const selected = entry.id === section
              return (
                <li key={entry.id}>
                  <button
                    type="button"
                    aria-current={selected ? 'page' : undefined}
                    onClick={() => setSection(entry.id)}
                    className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring ${
                      selected
                        ? 'bg-accent-subtle font-medium text-fg'
                        : 'text-fg-muted hover:bg-glass-hover hover:text-fg'
                    }`}
                  >
                    <Icon size={15} strokeWidth={1.8} className="shrink-0 opacity-80" aria-hidden />
                    {entry.label}
                  </button>
                </li>
              )
            })}
          </ul>
        </nav>
        <div className="border-t border-border px-2 py-1.5">
          <button
            type="button"
            onClick={onBack}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-fg-muted transition-colors hover:bg-glass-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          >
            <ArrowLeft size={14} aria-hidden />
            Back
          </button>
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col border-l border-border bg-bg">
        <header className="flex h-[46px] shrink-0 items-center gap-1.5 border-b border-border px-4 text-xs">
          <span className="text-fg-muted">Settings</span>
          <span className="text-fg-subtle">/</span>
          <span className="font-medium text-fg">{sectionLabel(section)}</span>
        </header>
        <div className="ari-scroll min-h-0 flex-1 overflow-y-auto">
          {section === 'appearance' ? <AppearanceSettings /> : null}
          {section === 'providers' ? (
            <div id="settings-providers" className="mx-auto max-w-2xl p-8">
              <ProvidersView />
            </div>
          ) : null}
          {section === 'endpoints' ? (
            <div id="settings-endpoints" className="mx-auto max-w-2xl p-8">
              <EndpointsManager />
            </div>
          ) : null}
          {section === 'permissions' ? <PermissionsSettings /> : null}
          {section === 'keybindings' ? <KeybindingsSettings /> : null}
          {section === 'advanced' ? <AdvancedSettings /> : null}
        </div>
      </section>
    </div>
  )
}

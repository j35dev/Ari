import { useEffect, useState } from 'react'
import {
  ArrowLeft,
  Bell,
  Cpu,
  FileCog,
  GitBranch,
  Keyboard,
  Mic,
  Monitor,
  Palette,
  Plug,
  Shield,
  SlidersHorizontal,
  Smartphone,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { AppearanceSettings } from './AppearanceSettings'
import { AdvancedSettings } from './AdvancedSettings'
import { KeybindingsSettings } from './KeybindingsSettings'
import { NotificationsSettings } from './NotificationsSettings'
import { PermissionsSettings } from './PermissionsSettings'
import { RemoteSettings } from './RemoteSettings'
import { MachinesSettings } from './MachinesSettings'
import { SpeechSettings } from './SpeechSettings'
import { SourceControlSettings } from './SourceControlSettings'
import { SettingsPage } from './SettingsPage'
import { SettingsSearch } from './SettingsSearch'
import { ProvidersView, AgentConfigSettings } from '../providers'
import { EndpointsManager } from '../endpoints'

/** Nav order. `group` is the small heading above an entry; ungrouped entries sit at the top, or the bottom when they come last. */
export const SETTINGS_SECTIONS = [
  { id: 'appearance', label: 'Appearance', icon: Palette, group: null },
  { id: 'notifications', label: 'Notifications', icon: Bell, group: null },
  { id: 'keybindings', label: 'Keybindings', icon: Keyboard, group: null },
  { id: 'speech', label: 'Speech to text', icon: Mic, group: null },
  { id: 'providers', label: 'Providers', icon: Cpu, group: 'AI' },
  { id: 'agents', label: 'Agents', icon: FileCog, group: 'AI' },
  { id: 'endpoints', label: 'Endpoints', icon: Plug, group: 'AI' },
  { id: 'permissions', label: 'Permissions', icon: Shield, group: 'AI' },
  { id: 'source-control', label: 'Source control', icon: GitBranch, group: 'Code' },
  { id: 'remote', label: 'Mobile access', icon: Smartphone, group: 'Connections' },
  { id: 'machines', label: 'Machines', icon: Monitor, group: 'Connections' },
  { id: 'advanced', label: 'Advanced', icon: SlidersHorizontal, group: null },
] as const

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id']

type SettingsSectionEntry = (typeof SETTINGS_SECTIONS)[number]

/** Consecutive sections bucketed by group. */
const NAV_GROUPS = SETTINGS_SECTIONS.reduce<
  { group: string | null; entries: SettingsSectionEntry[] }[]
>((groups, entry) => {
  const last = groups[groups.length - 1]
  if (last && last.group === entry.group) last.entries.push(entry)
  else groups.push({ group: entry.group, entries: [entry] })
  return groups
}, [])

export interface SettingsWorkspaceProps {
  section?: SettingsSectionId
  onSectionChange?: (section: SettingsSectionId) => void
  onBack: () => void
  /** Opens setup without clearing existing agents, projects or sessions. */
  onOpenSetup?: () => void
  /**
   * Leaves settings for the Terminal pane. Provider sign-in runs the agent's
   * own login command in a terminal tab, which is no use if the user is left
   * staring at Settings; without this the tab is queued until they navigate.
   */
  onOpenTerminal?: () => void
  /** Active session workspace. Null inventories the home directory. */
  workspacePath?: string | null
  onOpenMachine?: (machineId: string) => void
}

function isSettingsSection(value: string): value is SettingsSectionId {
  return SETTINGS_SECTIONS.some((entry) => entry.id === value)
}

function sectionLabel(id: SettingsSectionId): string {
  return SETTINGS_SECTIONS.find((entry) => entry.id === id)?.label ?? id
}

const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring'

/**
 * T3-style settings mode: the sessions sidebar is replaced by a section
 * list + Back, and the main pane shows one page. Chat stays mounted in the
 * parent — this view is swapped in, not overlaid.
 */
export function SettingsWorkspace({
  section: controlledSection,
  onSectionChange,
  onBack,
  onOpenSetup,
  onOpenTerminal,
  workspacePath = null,
  onOpenMachine,
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
    <div className="ari-enter-fade flex min-h-0 flex-1">
      <aside className="flex w-[var(--ari-sidebar-width)] shrink-0 flex-col bg-surface-0">
        {/* Back leads the header rather than sitting in a footer. The row is
            below the titlebar, so it clears the macOS hiddenInset traffic
            lights without needing a leading inset. */}
        <div className="flex items-center gap-1.5 px-3 pb-1 pt-3">
          <button
            type="button"
            aria-label="Back"
            title="Back to workspace"
            onClick={onBack}
            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg ${FOCUS_RING}`}
          >
            <ArrowLeft size={14} strokeWidth={1.8} aria-hidden />
          </button>
          <span className="text-sm font-semibold tracking-tight text-fg">Settings</span>
        </div>
        <div className="px-3 pb-3 pt-2">
          <SettingsSearch onJump={handleSearchJump} />
        </div>
        <nav
          aria-label="Settings sections"
          className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-3"
        >
          {NAV_GROUPS.map(({ group, entries }, index) => (
            <div
              key={group ?? `ungrouped-${index}`}
              className={group ? 'mt-5' : index > 0 ? 'mt-auto pt-5' : undefined}
            >
              {group ? (
                <p className="mb-1 px-2.5 text-xs font-medium text-fg-subtle">{group}</p>
              ) : null}
              <ul className="flex flex-col gap-0.5">
                {entries.map((entry) => {
                  const Icon: LucideIcon = entry.icon
                  const selected = entry.id === section
                  return (
                    <li key={entry.id}>
                      <button
                        type="button"
                        aria-current={selected ? 'page' : undefined}
                        onClick={() => setSection(entry.id)}
                        className={`flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm transition-colors ${FOCUS_RING} ${
                          selected
                            ? 'bg-accent-subtle font-medium text-fg'
                            : 'text-fg-muted hover:bg-surface-2/70 hover:text-fg'
                        }`}
                      >
                        <Icon
                          size={15}
                          strokeWidth={1.8}
                          className={`shrink-0 ${selected ? 'text-accent' : 'opacity-80'}`}
                          aria-hidden
                        />
                        {entry.label}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </nav>
        {onOpenSetup && (
          <div className="border-t border-border/60 p-3">
            <button
              type="button"
              onClick={onOpenSetup}
              className={`w-full rounded-md px-2.5 py-2 text-left text-xs text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg ${FOCUS_RING}`}
            >
              Run setup again
            </button>
          </div>
        )}
      </aside>

      <section className="flex min-w-0 flex-1 flex-col border-l border-border bg-bg">
        <header className="flex h-[46px] shrink-0 items-center gap-2 border-b border-border pl-5 pr-3 text-sm">
          <span className="text-fg-muted">Settings</span>
          <span className="text-fg-subtle" aria-hidden>
            /
          </span>
          <span className="font-medium text-fg">{sectionLabel(section)}</span>
          <button
            type="button"
            aria-label="Close settings"
            title="Close settings"
            onClick={onBack}
            className={`ml-auto flex size-7 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg ${FOCUS_RING}`}
          >
            <X size={15} strokeWidth={1.8} aria-hidden />
          </button>
        </header>
        <div
          key={section}
          className="ari-enter-rise ari-scroll min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
        >
          {section === 'appearance' ? <AppearanceSettings /> : null}
          {section === 'providers' ? (
            <div id="settings-providers" className="mx-auto w-full max-w-4xl px-8 pb-16 pt-9">
              <ProvidersView
                onOpenTerminal={onOpenTerminal}
                onOpenEndpoints={() => setSection('endpoints')}
              />
            </div>
          ) : null}
          {section === 'agents' ? <AgentConfigSettings workspacePath={workspacePath} /> : null}
          {section === 'endpoints' ? (
            <SettingsPage
              title="Endpoints"
              description="Model servers Ari Core chats through: OpenAI-compatible, Anthropic, or Ollama."
            >
              <EndpointsManager />
            </SettingsPage>
          ) : null}
          {section === 'source-control' ? <SourceControlSettings /> : null}
          {section === 'notifications' ? <NotificationsSettings /> : null}
          {section === 'permissions' ? <PermissionsSettings /> : null}
          {section === 'remote' ? <RemoteSettings /> : null}
          {section === 'machines' ? (
            <MachinesSettings
              onOpenMachine={onOpenMachine}
              onHosting={() => setSection('remote')}
            />
          ) : null}
          {section === 'keybindings' ? <KeybindingsSettings /> : null}
          {section === 'speech' ? <SpeechSettings /> : null}
          {section === 'advanced' ? <AdvancedSettings /> : null}
        </div>
      </section>
    </div>
  )
}

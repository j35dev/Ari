import { useEffect, useState } from 'react'
import {
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
import { SETTINGS_COLUMN_WIDE_CLASS, SettingsPage } from './SettingsPage'
import { SettingsSearch } from './SettingsSearch'
import { cx, iconButton, row, rowSelected, sectionLabel } from '../../lib/recipes'
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

/**
 * The `row` recipe at the frame's nav size (34px, 14px). Colour is set per
 * state rather than layered: `row`'s muted text would outrank `rowSelected`'s
 * in the stylesheet.
 */
const NAV_ROW =
  'flex h-[34px] w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring'
const NAV_ROW_IDLE = 'text-fg-muted hover:bg-fg/5 hover:text-fg'

/**
 * Settings as one panel: the section list on the left, the page on the right.
 * It fills whatever holds it; the app shows it in a dialog over the workspace,
 * so the conversation stays where it was underneath.
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
    <div className="flex h-full min-h-0 flex-1 bg-surface-0">
      <aside className="flex w-[232px] shrink-0 flex-col px-2.5 pb-2.5 pt-3">
        <h2 className="px-2.5 pb-1 text-sm font-semibold text-fg">Settings</h2>
        <div className="pb-2 pt-2">
          <SettingsSearch onJump={handleSearchJump} />
        </div>
        <nav
          aria-label="Settings sections"
          className="ari-scroll -mx-1 flex min-h-0 flex-1 flex-col overflow-y-auto px-1 pb-1"
        >
          {NAV_GROUPS.map(({ group, entries }, index) => (
            <div
              key={group ?? `ungrouped-${index}`}
              className={group ? 'mt-4' : index > 0 ? 'mt-auto pt-4' : undefined}
            >
              {group ? <p className={`mb-1 px-2.5 ${sectionLabel}`}>{group}</p> : null}
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
                        className={cx(NAV_ROW, selected ? rowSelected : NAV_ROW_IDLE)}
                      >
                        <Icon size={16} strokeWidth={1.7} className="shrink-0" aria-hidden />
                        <span className="truncate">{entry.label}</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </nav>
        {onOpenSetup && (
          <button type="button" onClick={onOpenSetup} className={cx(row, 'mt-1 shrink-0')}>
            Run setup again
          </button>
        )}
      </aside>

      <div className="relative flex min-w-0 flex-1 flex-col border-l border-border bg-bg">
        <div
          key={section}
          className="ari-enter-rise ari-scroll min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
        >
          {section === 'appearance' ? <AppearanceSettings /> : null}
          {section === 'providers' ? (
            <div id="settings-providers" className={SETTINGS_COLUMN_WIDE_CLASS}>
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
        {/* After the page in the DOM so it paints over the scroller without a
            z-index. The page title already says where you are. */}
        <button
          type="button"
          aria-label="Close settings"
          title="Close settings"
          onClick={onBack}
          className={`${iconButton} absolute right-3 top-3`}
        >
          <X size={16} strokeWidth={1.7} aria-hidden />
        </button>
      </div>
    </div>
  )
}

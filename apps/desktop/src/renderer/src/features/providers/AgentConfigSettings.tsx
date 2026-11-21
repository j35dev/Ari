import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { DriverKind } from '@ari/contracts/common'
import { Spinner } from '@ari/ui/spinner'
import { createLogger } from '@ari/shared/logger'
import { cx } from '../../lib/recipes'
import { rpc } from '../../lib/rpc'
import { ProviderLogo } from '../composer/provider-logo'
import {
  SETTINGS_COLUMN_CLASS,
  SETTINGS_LEAD_CLASS,
  SETTINGS_TITLE_CLASS,
} from '../settings/SettingsPage'
import { SETTINGS_CARD_CLASS, SETTINGS_HINT_CLASS } from '../settings/SettingsSection'
import { AgentFileEditor, type EditorTarget } from './AgentFileEditor'
import { McpServersTab, SkillsTab } from './ExtensionInventory'
import { SessionImport } from './SessionImport'
import {
  AGENTS,
  agentLabel,
  formatBytes,
  mcpRecords,
  pickInitialAgent,
  skillRecords,
  type AgentTab,
  type ConfigFile,
  type InventoryRecord,
} from './agent-config-model'

const log = createLogger('ui:agent-config')

const LEAD =
  'What each agent loads: its instructions, settings, skills and tools. Ari edits the agent’s own files in place.'

interface Inventory {
  records: InventoryRecord[]
  truncated: boolean
}

/**
 * Settings → Agents: what each agent loads, in its own files.
 *
 * An agent switcher, then three tabs: the agent's config files, its skills
 * and its MCP servers. A file or skill opens in the editor view, which takes
 * the place of the tabs. Ari edits the vendor's own format verbatim rather
 * than offering a form per agent: the formats change with every release, and
 * a form that lags behind one is worse than none. Ari only refuses a JSON
 * file it cannot parse, the one mistake that loses an agent's config.
 */
export function AgentConfigSettings({ workspacePath = null }: { workspacePath?: string | null }) {
  const [kind, setKind] = useState<DriverKind | null>(null)
  const [tab, setTab] = useState<AgentTab>('files')
  const [editing, setEditing] = useState<EditorTarget | null>(null)
  const [dir, setDir] = useState<string | null>(null)
  const [files, setFiles] = useState<ConfigFile[]>([])
  const [filesLoading, setFilesLoading] = useState(true)
  const [inventory, setInventory] = useState<Inventory>({ records: [], truncated: false })
  const [inventoryLoading, setInventoryLoading] = useState(true)
  const [inventoryError, setInventoryError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /** Replies for an agent the user has already switched away from are dropped. */
  const current = useRef<DriverKind | null>(null)
  current.current = kind

  // Open on the user's default agent, else the first one installed.
  useEffect(() => {
    let cancelled = false
    void Promise.allSettled([rpc.invoke('settings.get'), rpc.invoke('providers.detect')]).then(
      ([settings, detected]) => {
        if (cancelled) return
        const defaultKind =
          settings.status === 'fulfilled' ? settings.value.sessions.defaultDriverKind : null
        const installed = new Set(
          detected.status === 'fulfilled'
            ? detected.value.filter((row) => row.installed).map((row) => row.kind)
            : [],
        )
        setKind((chosen) => chosen ?? pickInitialAgent(defaultKind, installed))
      },
    )
    return () => {
      cancelled = true
    }
  }, [])

  const refreshFiles = useCallback(async (next: DriverKind) => {
    try {
      const listed = await rpc.invoke('providers.configFiles', { kind: next })
      if (current.current !== next) return
      setDir(listed.dir)
      setFiles(listed.files)
    } catch (caught: unknown) {
      log.warn('could not list config files', { error: String(caught) })
      if (current.current !== next) return
      setDir(null)
      setFiles([])
    } finally {
      if (current.current === next) setFilesLoading(false)
    }
  }, [])

  const refreshInventory = useCallback(
    async (next: DriverKind) => {
      setInventoryError(null)
      try {
        const listed = await rpc.invoke('providers.extensionInventory', {
          kind: next,
          workspacePath,
        })
        if (current.current !== next) return
        setInventory({ records: listed.records ?? [], truncated: listed.truncated ?? false })
      } catch (caught: unknown) {
        if (current.current !== next) return
        setInventory({ records: [], truncated: false })
        setInventoryError(caught instanceof Error ? caught.message : String(caught))
      } finally {
        if (current.current === next) setInventoryLoading(false)
      }
    },
    [workspacePath],
  )

  useEffect(() => {
    if (kind === null) return
    setFilesLoading(true)
    setInventoryLoading(true)
    void refreshFiles(kind)
    void refreshInventory(kind)
  }, [kind, refreshFiles, refreshInventory])

  const selectAgent = (next: DriverKind): void => {
    if (next === kind) return
    setKind(next)
    setEditing(null)
    setNotice(null)
  }

  const openFolder = (): void => {
    if (kind === null) return
    setNotice(null)
    void rpc
      .invoke('providers.revealPath', { kind, workspacePath, path: null })
      .then((result) => {
        if (!result.revealed)
          setNotice('That folder does not exist yet. The agent creates it on first run.')
      })
      .catch((caught: unknown) =>
        setNotice(caught instanceof Error ? caught.message : String(caught)),
      )
  }

  const label = kind === null ? '' : agentLabel(kind)
  const skills = skillRecords(inventory.records)
  const servers = mcpRecords(inventory.records)

  if (kind !== null && editing !== null) {
    return (
      <div id="settings-agents" className={cx('ari-settings-page', SETTINGS_COLUMN_CLASS)}>
        <AgentFileEditor
          kind={kind}
          agentLabel={label}
          target={editing}
          workspacePath={workspacePath}
          onBack={() => setEditing(null)}
          onSaved={() => void refreshFiles(kind)}
        />
      </div>
    )
  }

  const tabs: { id: AgentTab; label: string; count: number | null }[] = [
    { id: 'files', label: 'Files', count: filesLoading ? null : files.length },
    { id: 'skills', label: 'Skills', count: inventoryLoading ? null : skills.length },
    { id: 'mcp', label: 'MCP servers', count: inventoryLoading ? null : servers.length },
  ]

  return (
    <div id="settings-agents" className={cx('ari-settings-page', SETTINGS_COLUMN_CLASS)}>
      <header className="mb-5">
        <h1 className={SETTINGS_TITLE_CLASS}>Agents</h1>
        <p className={SETTINGS_LEAD_CLASS}>{LEAD}</p>
      </header>

      <div role="group" aria-label="Agent" className="flex flex-wrap gap-1">
        {AGENTS.map((agent) => {
          const selected = agent.kind === kind
          return (
            <button
              key={agent.kind}
              type="button"
              aria-pressed={selected}
              onClick={() => selectAgent(agent.kind)}
              className={cx(
                'inline-flex h-[30px] items-center gap-[7px] rounded-lg border pl-[9px] pr-[11px] text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring [&_svg]:text-current!',
                selected
                  ? 'ari-theme-selected border-border-strong bg-fg/9 text-fg'
                  : 'border-transparent text-fg-muted hover:bg-fg/6 hover:text-fg',
              )}
            >
              <ProviderLogo kind={agent.kind} />
              {agent.label}
            </button>
          )
        })}
      </div>

      {kind === null ? (
        <div className="mt-6">
          <Spinner size="sm" />
        </div>
      ) : (
        <>
          <div className="mb-[18px] mt-3 flex min-h-5 flex-wrap items-center gap-x-2.5 gap-y-1 text-[12.5px]">
            {dir !== null ? (
              <>
                <code className="min-w-0 break-all font-mono text-xs text-fg-subtle">{dir}</code>
                <button
                  type="button"
                  onClick={openFolder}
                  className="rounded-sm text-fg-muted underline decoration-border-strong underline-offset-2 transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
                >
                  Open folder
                </button>
              </>
            ) : kind === 'ari-core' ? (
              <span className="text-fg-subtle">
                Built into Ari. Its models come from Endpoints.
              </span>
            ) : null}
            {notice !== null ? <span className="text-fg-subtle">{notice}</span> : null}
          </div>

          <div
            role="tablist"
            aria-label={`${label} configuration`}
            className="mb-3.5 flex gap-[18px] border-b border-border"
          >
            {tabs.map((entry) => {
              const selected = tab === entry.id
              return (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  id={`agents-tab-${entry.id}`}
                  aria-selected={selected}
                  aria-controls={`agents-panel-${entry.id}`}
                  onClick={() => setTab(entry.id)}
                  className={cx(
                    '-mb-px border-b-2 pb-[9px] text-[13.5px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring',
                    selected
                      ? 'border-fg font-medium text-fg'
                      : 'border-transparent text-fg-subtle hover:text-fg',
                  )}
                >
                  {entry.label}
                  {entry.count !== null ? (
                    <>
                      {' '}
                      <span className="font-normal tabular-nums text-fg-subtle">{entry.count}</span>
                    </>
                  ) : null}
                </button>
              )
            })}
          </div>

          <div role="tabpanel" id={`agents-panel-${tab}`} aria-labelledby={`agents-tab-${tab}`}>
            {tab === 'files' ? (
              <FilesTab
                kind={kind}
                files={files}
                loading={filesLoading}
                onOpen={(file) => setEditing({ type: 'config', file })}
              />
            ) : inventoryLoading ? (
              <Spinner size="sm" />
            ) : inventoryError !== null ? (
              <p role="alert" className="text-[13px] leading-5 text-danger">
                {inventoryError}
              </p>
            ) : tab === 'skills' ? (
              <SkillsTab
                key={kind}
                kind={kind}
                agentLabel={label}
                skills={skills}
                truncated={inventory.truncated}
                workspacePath={workspacePath}
                onOpen={(record) => setEditing({ type: 'skill', record })}
                onChanged={() => void refreshInventory(kind)}
              />
            ) : (
              <McpServersTab
                key={kind}
                kind={kind}
                agentLabel={label}
                servers={servers}
                configFiles={files}
                workspacePath={workspacePath}
                onEditFile={(file) => setEditing({ type: 'config', file })}
                onChanged={() => void refreshInventory(kind)}
              />
            )}
          </div>

          {kind === 'pi' && tab === 'files' ? (
            <div className="mt-[26px]">
              <SessionImport />
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}

function FilesTab({
  kind,
  files,
  loading,
  onOpen,
}: {
  kind: DriverKind
  files: ConfigFile[]
  loading: boolean
  onOpen: (file: ConfigFile) => void
}) {
  if (loading) return <Spinner size="sm" />
  if (files.length === 0) {
    return (
      <p className={SETTINGS_HINT_CLASS}>
        {kind === 'ari-core'
          ? 'Ari Core keeps no config files of its own. Its skills and MCP servers are in the other tabs.'
          : 'Ari has no confirmed config layout for this agent, so it will not guess at a path.'}
      </p>
    )
  }
  return (
    <ul aria-label="Config files" className={cx(SETTINGS_CARD_CLASS, 'overflow-hidden')}>
      {files.map((file) => (
        <li key={file.id}>
          <button
            type="button"
            aria-label={`${file.exists ? 'Edit' : 'Create'} ${file.label}`}
            onClick={() => onOpen(file)}
            className="flex min-h-[46px] w-full min-w-0 items-center gap-3 px-3.5 py-2 text-left transition-colors hover:bg-fg/4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring"
          >
            <span className="shrink-0 font-mono text-[12.5px] font-medium text-fg">
              {file.label}
            </span>
            <span className="shrink-0 text-xs tabular-nums text-fg-subtle">
              {file.exists ? formatBytes(file.size) : 'not created'}
            </span>
            <span
              className="min-w-0 flex-1 truncate text-[12.5px] text-fg-subtle"
              title={file.description}
            >
              {file.description}
            </span>
            <ChevronRight size={14} aria-hidden className="shrink-0 text-fg-subtle" />
          </button>
        </li>
      ))}
    </ul>
  )
}

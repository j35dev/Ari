import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Search } from 'lucide-react'
import type { DriverKind } from '@ari/contracts/common'
import { Switch } from '@ari/ui/switch'
import { Textarea } from '@ari/ui/textarea'
import { cx, outlineButton, primaryButton, quietButton } from '../../lib/recipes'
import { rpc } from '../../lib/rpc'
import {
  SETTINGS_CARD_CLASS,
  SETTINGS_FIELD_CLASS,
  SETTINGS_HINT_CLASS,
  SETTINGS_LABEL_CLASS,
} from '../settings/SettingsSection'
import {
  PROBLEM_LABEL,
  SCOPE_LABEL,
  baseName,
  filterSkills,
  scopeChips,
  type ConfigFile,
  type InventoryRecord,
  type ScopeFilter,
} from './agent-config-model'

/** Rows shown before the list asks you to type instead of scroll. */
export const SKILL_ROW_LIMIT = 30

/** The settings card, clipped so row hovers keep its corners. */
const LIST_CLASS = `${SETTINGS_CARD_CLASS} overflow-hidden`
const ROW_CLASS = 'flex h-[46px] min-w-0 items-center gap-3 px-3.5'
const ROW_BUTTON_CLASS = `${ROW_CLASS} w-full text-left transition-colors hover:bg-fg/4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring`
const NAME_CLASS = 'max-w-[190px] shrink-0 truncate font-mono text-[12.5px] font-medium text-fg'
const SUMMARY_CLASS = 'min-w-0 flex-1 truncate text-[12.5px] text-fg-subtle'
const BADGE_CLASS =
  'shrink-0 rounded-md border border-border px-1.5 py-px text-[11.5px] leading-4 text-fg-subtle'
const WARN_BADGE_CLASS =
  'shrink-0 rounded-md bg-warning-subtle px-1.5 py-px text-[11.5px] leading-4 text-warning'
const NOTE_CLASS = `mt-2.5 ${SETTINGS_HINT_CLASS}`
const LINK_CLASS =
  'rounded-sm text-fg-muted underline decoration-border-strong underline-offset-2 transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring'

function errorText(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught)
}

export interface SkillsTabProps {
  kind: DriverKind
  agentLabel: string
  /** Skill and plugin records for this agent. */
  skills: InventoryRecord[]
  truncated: boolean
  workspacePath: string | null
  onOpen: (skill: InventoryRecord & { sourcePath: string }) => void
  onChanged: () => void
}

/**
 * The skills an agent loads: search, scope chips, then one slim row each.
 * A row opens its SKILL.md in the editor view. Long lists stop at
 * {@link SKILL_ROW_LIMIT} rows and ask you to type.
 */
export function SkillsTab({
  kind,
  agentLabel,
  skills,
  truncated,
  workspacePath,
  onOpen,
  onChanged,
}: SkillsTabProps) {
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<ScopeFilter>('all')
  const [showAll, setShowAll] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const chips = useMemo(() => scopeChips(skills), [skills])
  const matches = useMemo(() => filterSkills(skills, query, scope), [skills, query, scope])
  const visible = showAll ? matches : matches.slice(0, SKILL_ROW_LIMIT)
  const hidden = matches.length - visible.length
  const untrusted = skills.filter((skill) => skill.problem === 'untrusted-project').length

  return (
    <div>
      {skills.length > 0 ? (
        <div className="mb-2.5 flex flex-wrap items-center gap-2">
          <label className="relative min-w-[180px] flex-1">
            <span className="sr-only">Search skills</span>
            <Search
              size={14}
              aria-hidden
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle"
            />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${skills.length} skills`}
              className={cx(SETTINGS_FIELD_CLASS, 'w-full bg-surface-0 pl-8')}
            />
          </label>
          <div
            role="group"
            aria-label="Filter by scope"
            className="flex shrink-0 items-center gap-0.5"
          >
            {chips.map((chip) => (
              <button
                key={chip.id}
                type="button"
                aria-pressed={scope === chip.id}
                onClick={() => setScope(chip.id)}
                className={cx(
                  'inline-flex h-[26px] items-center gap-1 rounded-md px-2 text-[12.5px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring',
                  scope === chip.id
                    ? 'ari-theme-selected bg-fg/9 text-fg'
                    : 'text-fg-subtle hover:bg-fg/6 hover:text-fg',
                )}
              >
                {chip.label}
                {chip.id === 'all' ? null : (
                  <>
                    {' '}
                    <span className="tabular-nums">{chip.count}</span>
                  </>
                )}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {kind === 'ari-core' && untrusted > 0 && workspacePath ? (
        <div className={cx(LIST_CLASS, 'mb-2.5 flex items-center gap-3 px-3.5 py-2.5')}>
          <p className={cx(SETTINGS_HINT_CLASS, 'min-w-0 flex-1')}>
            {untrusted} project {untrusted === 1 ? 'skill stays' : 'skills stay'} off until you
            trust this folder.
          </p>
          <button
            type="button"
            className={outlineButton}
            onClick={() => {
              void rpc
                .invoke('ariCore.skills.trust', { workspacePath, trusted: true })
                .then(onChanged)
                .catch((caught: unknown) => setError(errorText(caught)))
            }}
          >
            Trust skills in this folder
          </button>
        </div>
      ) : null}

      {skills.length === 0 ? (
        <p className={SETTINGS_HINT_CLASS}>No skills found for {agentLabel}.</p>
      ) : matches.length === 0 ? (
        <p className={SETTINGS_HINT_CLASS}>
          No skills match{query.trim() ? ` “${query.trim()}”` : ''}.
        </p>
      ) : (
        <ul aria-label="Skills" className={LIST_CLASS}>
          {visible.map((skill) => (
            <li key={skill.id}>
              <SkillRow skill={skill} onOpen={onOpen} />
            </li>
          ))}
          {hidden > 0 ? (
            <li className="flex items-center gap-3 px-3.5 py-2.5 text-[12.5px] text-fg-subtle">
              <span className="min-w-0 flex-1">{hidden} more · type to filter</span>
              <button type="button" className={LINK_CLASS} onClick={() => setShowAll(true)}>
                Show all
              </button>
            </li>
          ) : null}
        </ul>
      )}

      {error !== null ? (
        <p role="alert" className="mt-2.5 text-[13px] leading-5 text-danger">
          {error}
        </p>
      ) : null}
      {truncated ? (
        <p className={NOTE_CLASS}>The list is cut off; Ari reads at most 80 skills.</p>
      ) : null}
      {skills.length > 0 ? (
        <p className={NOTE_CLASS}>
          {kind === 'ari-core'
            ? 'Ari Core loads these itself. User skills apply on the next message; project skills stay off until you trust the folder.'
            : `${agentLabel} loads these itself; changes apply from the next message. Open a skill to read its SKILL.md.`}
        </p>
      ) : null}
    </div>
  )
}

function SkillRow({ skill, onOpen }: { skill: InventoryRecord; onOpen: SkillsTabProps['onOpen'] }) {
  const body = (
    <>
      <span className={NAME_CLASS} title={skill.name}>
        {skill.name}
      </span>
      <span className={SUMMARY_CLASS} title={skill.summary}>
        {skill.summary ?? (skill.kind === 'plugin' ? 'Plugin' : 'No description')}
      </span>
      {skill.disabled ? <span className={WARN_BADGE_CLASS}>Off</span> : null}
      {skill.problem ? (
        <span className={WARN_BADGE_CLASS}>{PROBLEM_LABEL[skill.problem]}</span>
      ) : null}
      <span className={BADGE_CLASS}>{SCOPE_LABEL[skill.scope]}</span>
    </>
  )
  const sourcePath = skill.sourcePath
  if (skill.kind !== 'skill' || sourcePath === null) {
    return <div className={cx(ROW_CLASS, 'pr-[34px]')}>{body}</div>
  }
  return (
    <button
      type="button"
      className={ROW_BUTTON_CLASS}
      aria-label={`Open ${skill.name}`}
      onClick={() => onOpen({ ...skill, sourcePath })}
    >
      {body}
      <ChevronRight size={14} aria-hidden className="shrink-0 text-fg-subtle" />
    </button>
  )
}

export interface McpServersTabProps {
  kind: DriverKind
  agentLabel: string
  servers: InventoryRecord[]
  /** The agent's config files, so a server's source can open in the editor. */
  configFiles: ConfigFile[]
  workspacePath: string | null
  onEditFile: (file: ConfigFile) => void
  onChanged: () => void
}

/**
 * The MCP servers an agent starts: a status dot, name, transport and
 * command, scope. Ari Core's own servers keep their switch; every row opens
 * its details (argv, env names with values masked, the file it came from).
 */
export function McpServersTab({
  kind,
  agentLabel,
  servers,
  configFiles,
  workspacePath,
  onEditFile,
  onChanged,
}: McpServersTabProps) {
  const [openId, setOpenId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const sources = useMemo(
    () => [...new Set(servers.flatMap((server) => (server.sourcePath ? [server.sourcePath] : [])))],
    [servers],
  )

  const reveal = (path: string): void => {
    void rpc
      .invoke('providers.revealPath', { kind, workspacePath, path })
      .catch((caught: unknown) => setError(errorText(caught)))
  }

  return (
    <div>
      {servers.length === 0 ? (
        <p className={SETTINGS_HINT_CLASS}>No MCP servers found for {agentLabel}.</p>
      ) : (
        <ul aria-label="MCP servers" className={LIST_CLASS}>
          {servers.map((server) => {
            const open = openId === server.id
            const hosted = kind === 'ari-core' && server.delivery === 'hosted'
            const coreId = hosted ? server.id.split(':')[3] : undefined
            return (
              <li key={server.id}>
                <div className="flex min-w-0 items-center">
                  <button
                    type="button"
                    aria-expanded={open}
                    aria-label={`${server.name} details`}
                    onClick={() => setOpenId(open ? null : server.id)}
                    className={cx(ROW_BUTTON_CLASS, 'flex-1', coreId !== undefined && 'pr-3')}
                  >
                    <StatusDot server={server} />
                    <span className={NAME_CLASS} title={server.name}>
                      {server.name}
                    </span>
                    <span className={SUMMARY_CLASS}>{transportLine(server)}</span>
                    {server.problem ? (
                      <span className={WARN_BADGE_CLASS}>{PROBLEM_LABEL[server.problem]}</span>
                    ) : null}
                    <span className={BADGE_CLASS}>{SCOPE_LABEL[server.scope]}</span>
                    {coreId === undefined ? (
                      open ? (
                        <ChevronDown size={14} aria-hidden className="shrink-0 text-fg-subtle" />
                      ) : (
                        <ChevronRight size={14} aria-hidden className="shrink-0 text-fg-subtle" />
                      )
                    ) : null}
                  </button>
                  {coreId !== undefined ? (
                    <span className="flex shrink-0 items-center pr-3.5">
                      <Switch
                        checked={!server.disabled}
                        aria-label={`Turn ${server.name} ${server.disabled ? 'on' : 'off'}`}
                        onCheckedChange={(on) => {
                          void rpc
                            .invoke('ariCore.mcp.upsert', { id: coreId, disabled: !on })
                            .then(onChanged)
                            .catch((caught: unknown) => setError(errorText(caught)))
                        }}
                      />
                    </span>
                  ) : null}
                </div>
                {open ? (
                  <McpDetails
                    server={server}
                    configFiles={configFiles}
                    onReveal={reveal}
                    onEditFile={onEditFile}
                  />
                ) : null}
              </li>
            )
          })}
        </ul>
      )}

      {error !== null ? (
        <p role="alert" className="mt-2.5 text-[13px] leading-5 text-danger">
          {error}
        </p>
      ) : null}

      <p className={NOTE_CLASS}>
        {kind === 'ari-core' ? (
          'Ari Core starts these itself, plus the in-app browser. Env values are stored and never shown again.'
        ) : (
          <>
            {sources.length > 0 ? (
              <>
                Servers come from{' '}
                {sources.map((source, index) => (
                  <span key={source}>
                    {index > 0 ? (index === sources.length - 1 ? ' and ' : ', ') : null}
                    <button
                      type="button"
                      className={cx(LINK_CLASS, 'font-mono text-xs')}
                      title={source}
                      onClick={() => reveal(source)}
                    >
                      {baseName(source)}
                    </button>
                  </span>
                ))}
                .{' '}
              </>
            ) : null}
            {agentLabel} starts them itself; Ari only adds ari-browser. A grey dot means the entry
            is turned off. Changes apply from the next message.
          </>
        )}
      </p>

      {kind === 'ari-core' ? (
        adding ? (
          <CoreMcpForm
            onCancel={() => setAdding(false)}
            onSaved={() => {
              setAdding(false)
              onChanged()
            }}
          />
        ) : (
          <button
            type="button"
            className={cx(outlineButton, 'mt-3')}
            onClick={() => setAdding(true)}
          >
            Add server
          </button>
        )
      ) : null}
    </div>
  )
}

function StatusDot({ server }: { server: InventoryRecord }) {
  const [tone, title] = server.problem
    ? ['bg-warning', PROBLEM_LABEL[server.problem]]
    : server.disabled
      ? ['bg-fg-subtle opacity-50', 'Turned off']
      : ['bg-success', 'Turned on']
  return (
    <span className="inline-flex size-[7px] shrink-0" title={title}>
      <span aria-hidden className={cx('size-[7px] rounded-full', tone)} />
      <span className="sr-only">{title}</span>
    </span>
  )
}

function transportLine(server: InventoryRecord): string {
  const transport = server.transport && server.transport !== 'unknown' ? server.transport : ''
  const target = server.url ?? server.command ?? ''
  return [transport, target].filter((part) => part.length > 0).join(' · ') || (server.summary ?? '')
}

function quoteArg(arg: string): string {
  return /\s/.test(arg) ? `"${arg}"` : arg
}

const DETAIL_LABEL_CLASS = 'text-fg-subtle'
const DETAIL_VALUE_CLASS = 'min-w-0 break-all font-mono text-xs text-fg-muted'

function McpDetails({
  server,
  configFiles,
  onReveal,
  onEditFile,
}: {
  server: InventoryRecord
  configFiles: ConfigFile[]
  onReveal: (path: string) => void
  onEditFile: (file: ConfigFile) => void
}) {
  const command = server.command
    ? [server.command, ...(server.args ?? []).map(quoteArg)].join(' ')
    : null
  const editable =
    server.sourcePath === null
      ? undefined
      : configFiles.find((file) => file.path.toLowerCase() === server.sourcePath?.toLowerCase())
  return (
    <div className="border-t border-border bg-surface-0/60 px-3.5 py-3 pl-[33px]">
      <dl className="grid grid-cols-[84px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12.5px]">
        <dt className={DETAIL_LABEL_CLASS}>Transport</dt>
        <dd className={DETAIL_VALUE_CLASS}>{server.transport ?? 'unknown'}</dd>
        {command !== null ? (
          <>
            <dt className={DETAIL_LABEL_CLASS}>Command</dt>
            <dd className={DETAIL_VALUE_CLASS}>{command}</dd>
          </>
        ) : null}
        {server.url ? (
          <>
            <dt className={DETAIL_LABEL_CLASS}>URL</dt>
            <dd className={DETAIL_VALUE_CLASS}>{server.url}</dd>
          </>
        ) : null}
        {server.envKeys && server.envKeys.length > 0 ? (
          <>
            <dt className={DETAIL_LABEL_CLASS}>Env</dt>
            <dd className={DETAIL_VALUE_CLASS}>
              <ul aria-label="Environment variables">
                {server.envKeys.map((key) => (
                  <li key={key}>
                    {key} = <span aria-label="value hidden">••••</span>
                  </li>
                ))}
              </ul>
            </dd>
          </>
        ) : null}
        {server.summary ? (
          <>
            <dt className={DETAIL_LABEL_CLASS}>About</dt>
            <dd className="min-w-0 text-fg-muted">{server.summary}</dd>
          </>
        ) : null}
        {server.problem === 'missing-binary' ? (
          <>
            <dt className={DETAIL_LABEL_CLASS}>Problem</dt>
            <dd className="text-warning">
              The command is not on disk, so the agent cannot start it.
            </dd>
          </>
        ) : null}
        {server.problem === 'duplicate-name' ? (
          <>
            <dt className={DETAIL_LABEL_CLASS}>Problem</dt>
            <dd className="text-warning">
              This name collides with the in-app browser. Ari still sends its own ari-browser.
            </dd>
          </>
        ) : null}
        <dt className={DETAIL_LABEL_CLASS}>Source</dt>
        <dd className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          {server.sourcePath ? (
            <>
              <span className={DETAIL_VALUE_CLASS}>{server.sourcePath}</span>
              <button
                type="button"
                className={LINK_CLASS}
                onClick={() => onReveal(server.sourcePath ?? '')}
              >
                Open folder
              </button>
              {editable ? (
                <button type="button" className={LINK_CLASS} onClick={() => onEditFile(editable)}>
                  Edit {editable.label}
                </button>
              ) : null}
            </>
          ) : (
            <span className="text-fg-muted">
              {server.delivery === 'injected' ? 'Added by Ari to every session' : 'Saved in Ari'}
            </span>
          )}
        </dd>
      </dl>
    </div>
  )
}

/** Adds an Ari Core MCP server. Env values go in once and are never shown again. */
function CoreMcpForm({ onSaved, onCancel }: { onSaved: () => void; onCancel: () => void }) {
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [env, setEnv] = useState('')
  const [error, setError] = useState<string | null>(null)
  const label = 'block text-[13px] font-medium text-fg'

  return (
    <form
      className={cx(SETTINGS_CARD_CLASS, 'mt-3 space-y-3 divide-y-0 p-4')}
      onSubmit={(event) => {
        event.preventDefault()
        const envRecord: Record<string, string> = {}
        for (const line of env.split('\n')) {
          const eq = line.indexOf('=')
          if (eq <= 0) continue
          envRecord[line.slice(0, eq).trim()] = line.slice(eq + 1)
        }
        void rpc
          .invoke('ariCore.mcp.upsert', {
            name: name.trim(),
            command: command.trim(),
            args: args
              .split('\n')
              .map((line) => line.trim())
              .filter((line) => line.length > 0),
            ...(env.trim().length > 0 ? { env: envRecord } : {}),
          })
          .then(onSaved)
          .catch((caught: unknown) => setError(errorText(caught)))
      }}
    >
      <p className={SETTINGS_LABEL_CLASS}>Add an Ari Core MCP server</p>
      <label className={label}>
        Name
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          className={`${SETTINGS_FIELD_CLASS} mt-1.5 block w-full font-normal`}
          required
        />
      </label>
      <label className={label}>
        Command
        <input
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          className={`${SETTINGS_FIELD_CLASS} mt-1.5 block w-full font-mono font-normal`}
          required
        />
      </label>
      <label className={label}>
        Args, one per line
        <Textarea
          value={args}
          onChange={(event) => setArgs(event.target.value)}
          className="mt-1.5 block font-mono font-normal"
          rows={2}
        />
      </label>
      <label className={label}>
        Env, KEY=value, one per line
        <Textarea
          value={env}
          onChange={(event) => setEnv(event.target.value)}
          className="mt-1.5 block font-mono font-normal"
          rows={2}
        />
      </label>
      {error ? (
        <p role="alert" className="text-[13px] leading-5 text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <button type="submit" className={primaryButton}>
          Add server
        </button>
        <button type="button" className={quietButton} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

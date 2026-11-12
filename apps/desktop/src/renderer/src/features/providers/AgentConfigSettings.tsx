import { useCallback, useEffect, useState } from 'react'
import type { DriverKind } from '@ari/contracts/common'
import type { RpcResults } from '@ari/contracts/rpc'
import { Button } from '@ari/ui/button'
import { Spinner } from '@ari/ui/spinner'
import { Textarea } from '@ari/ui/textarea'
import { createLogger } from '@ari/shared/logger'
import { card, tabSelected } from '../../lib/recipes'
import { SettingsPage } from '../settings/SettingsPage'
import { SETTINGS_ROW_CLASS } from '../settings/SettingsRow'
import {
  SETTINGS_CARD_CLASS,
  SETTINGS_HINT_CLASS,
  SettingsSection,
} from '../settings/SettingsSection'
import { SessionImport } from './SessionImport'
import { ExtensionInventory } from './ExtensionInventory'
import { rpc } from '../../lib/rpc'

const log = createLogger('ui:agent-config')

type ConfigFile = RpcResults['providers.configFiles']['files'][number]

/**
 * Kinds whose config layout Ari knows, in the order they are offered. The main
 * process is the authority — an agent with no mapping answers with an empty
 * file list — but the picker needs names before any call returns.
 */
const CONFIGURABLE: DriverKind[] = ['pi', 'claude', 'codex', 'opencode', 'grok', 'ari-core']

const KIND_LABELS: Partial<Record<DriverKind, string>> = {
  pi: 'pi',
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  grok: 'Grok',
  'ari-core': 'Ari Core',
}

/**
 * Edits the agents' own configuration files from inside Ari — pi's
 * `settings.json` and system prompt, Claude's `settings.json` and `CLAUDE.md`,
 * Codex's `config.toml`, and so on.
 *
 * Deliberately a plain text editor over the vendor's own format rather than a
 * form per agent: the formats change with every release, and a form that lags
 * behind one is worse than no form. Ari stores what you type verbatim and only
 * refuses a JSON file it could not parse, which is the one mistake that loses
 * an agent's configuration silently.
 */
export function AgentConfigSettings({ workspacePath = null }: { workspacePath?: string | null }) {
  const [kind, setKind] = useState<DriverKind>('pi')
  const [dir, setDir] = useState<string | null>(null)
  const [files, setFiles] = useState<ConfigFile[]>([])
  const [loading, setLoading] = useState(true)
  const [openId, setOpenId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [saved, setSaved] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = useCallback(async (next: DriverKind) => {
    setLoading(true)
    try {
      const listed = await rpc.invoke('providers.configFiles', { kind: next })
      setDir(listed.dir)
      setFiles(listed.files)
    } catch (e: unknown) {
      log.warn('could not list config files', { error: String(e) })
      setDir(null)
      setFiles([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh(kind)
  }, [kind, refresh])

  const selectKind = (next: DriverKind): void => {
    setKind(next)
    setOpenId(null)
    setError(null)
    setNotice(null)
  }

  const open = async (file: ConfigFile): Promise<void> => {
    setError(null)
    setNotice(null)
    setBusy(true)
    try {
      const read = await rpc.invoke('providers.readConfig', { kind, fileId: file.id })
      setDraft(read.content)
      setSaved(read.content)
      setOpenId(file.id)
      if (read.truncated)
        setNotice('This file is too large to edit in Ari; saving would truncate it.')
    } catch (e: unknown) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
    }
  }

  const save = async (): Promise<void> => {
    if (openId === null) return
    setError(null)
    setNotice(null)
    setBusy(true)
    try {
      const result = await rpc.invoke('providers.writeConfig', {
        kind,
        fileId: openId,
        content: draft,
      })
      if (!result.ok) {
        setError(result.error)
        return
      }
      setSaved(draft)
      setNotice('Saved. The agent picks this up the next time it starts.')
      await refresh(kind)
    } catch (e: unknown) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(false)
    }
  }

  const openFile = files.find((f) => f.id === openId) ?? null
  const dirty = openFile !== null && draft !== saved

  return (
    <SettingsPage
      title="Agents"
      description="Edit each agent's own configuration — model defaults, extensions, system prompts. Ari saves these files verbatim in the agent's format."
    >
      <SettingsSection title="Agent" headingId="agents-picker-heading" bare>
        {/* The tab recipe, with the colour set per state: the idle colour
            would outrank the selected one in the stylesheet if both applied. */}
        <div className="flex flex-wrap gap-0.5">
          {CONFIGURABLE.map((entry) => (
            <button
              key={entry}
              type="button"
              aria-pressed={entry === kind}
              onClick={() => selectKind(entry)}
              className={`inline-flex h-7 items-center rounded-md px-2.5 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring ${
                entry === kind ? tabSelected : 'text-fg-subtle hover:bg-fg/6 hover:text-fg'
              }`}
            >
              {KIND_LABELS[entry] ?? entry}
            </button>
          ))}
        </div>
        {dir !== null ? (
          <p className="mt-2.5 break-all font-mono text-[12.5px] text-fg-subtle">{dir}</p>
        ) : null}
      </SettingsSection>

      <SettingsSection title="Configuration files" headingId="agents-files-heading" bare>
        {loading ? (
          <Spinner size="sm" />
        ) : files.length === 0 && kind !== 'ari-core' ? (
          <p className={`${card} px-4 py-3.5 ${SETTINGS_HINT_CLASS}`}>
            Ari has no confirmed config layout for this agent, so it will not guess at a path.
          </p>
        ) : files.length === 0 ? null : (
          <ul className={SETTINGS_CARD_CLASS}>
            {files.map((file) => (
              <li key={file.id} className={SETTINGS_ROW_CLASS}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-[13px] font-medium text-fg">{file.label}</span>
                    <span className="shrink-0 text-xs text-fg-subtle">
                      {file.exists ? formatBytes(file.size) : 'not created'}
                    </span>
                  </div>
                  <p className={`mt-0.5 ${SETTINGS_HINT_CLASS}`}>{file.description}</p>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => void open(file)}
                  aria-label={`Edit ${file.label}`}
                >
                  {file.exists ? 'Edit' : 'Create'}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SettingsSection>

      {openFile !== null ? (
        <SettingsSection
          title={openFile.label}
          headingId="agents-editor-heading"
          description={<span className="break-all font-mono text-[12.5px]">{openFile.path}</span>}
          bare
          className="space-y-3"
        >
          <Textarea
            aria-label={`${openFile.label} contents`}
            className="font-mono"
            rows={18}
            spellCheck={false}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={busy || !dirty} onClick={() => void save()}>
              Save
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || !dirty}
              onClick={() => setDraft(saved)}
            >
              Revert
            </Button>
            {openFile.format === 'json' ? (
              <span className="text-[13px] text-fg-subtle">Checked as JSON before saving.</span>
            ) : null}
          </div>
          {error !== null ? (
            <p role="alert" className="text-[13px] leading-5 text-danger">
              {error}
            </p>
          ) : null}
          {notice !== null ? <p className={SETTINGS_HINT_CLASS}>{notice}</p> : null}
        </SettingsSection>
      ) : null}

      <ExtensionInventory kind={kind} workspacePath={workspacePath} />

      {kind === 'pi' ? <SessionImport /> : null}
    </SettingsPage>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${Math.round(bytes / 1024)} KB`
}

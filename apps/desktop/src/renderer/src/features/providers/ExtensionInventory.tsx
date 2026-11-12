import { useCallback, useEffect, useState } from 'react'
import type { DriverKind } from '@ari/contracts/common'
import type { RpcResults } from '@ari/contracts/rpc'
import { Badge } from '@ari/ui/badge'
import { Button } from '@ari/ui/button'
import { Spinner } from '@ari/ui/spinner'
import { Textarea } from '@ari/ui/textarea'
import { card } from '../../lib/recipes'
import { rpc } from '../../lib/rpc'
import {
  SETTINGS_CAPTION_CLASS,
  SETTINGS_CARD_CLASS,
  SETTINGS_FIELD_CLASS,
  SETTINGS_HINT_CLASS,
  SETTINGS_LABEL_CLASS,
} from '../settings/SettingsSection'

/** A form label that wraps its control: 13px, medium, the control below it. */
const FORM_LABEL_CLASS = 'block text-[13px] font-medium text-fg'

type RecordRow = RpcResults['providers.extensionInventory']['records'][number]
type PublicServer = RpcResults['ariCore.mcp.list']['servers'][number]

const DELIVERY: Record<RecordRow['delivery'], string> = {
  delegated: 'Loaded by the agent',
  injected: 'Ari browser',
  hosted: 'Ari Core',
}

const PROBLEM: Record<NonNullable<RecordRow['problem']>, string> = {
  'missing-binary': 'Missing binary',
  unreadable: 'Unreadable',
  'duplicate-name': 'Name collides with ari-browser',
  'untrusted-project': 'Not trusted',
}

/** Badges read in sentence case; the wire values are lowercase identifiers. */
const KIND: Record<RecordRow['kind'], string> = {
  mcp: 'MCP',
  skill: 'Skill',
  plugin: 'Plugin',
}

const SCOPE: Record<RecordRow['scope'], string> = {
  user: 'User',
  project: 'Project',
  plugin: 'Plugin',
  ari: 'Ari',
}

/**
 * Skills and MCP servers the selected agent will see. Pass-through rows are
 * read-only. Ari Core rows can be toggled; env values are write-only.
 */
export function ExtensionInventory({
  kind,
  workspacePath,
}: {
  kind: DriverKind
  workspacePath: string | null
}) {
  const [records, setRecords] = useState<RecordRow[]>([])
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [servers, setServers] = useState<PublicServer[]>([])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const listed = await rpc.invoke('providers.extensionInventory', { kind, workspacePath })
      setRecords(listed.records ?? [])
      setTruncated(listed.truncated ?? false)
      if (kind === 'ari-core') {
        const mcp = await rpc.invoke('ariCore.mcp.list')
        setServers(mcp.servers)
      } else {
        setServers([])
      }
    } catch (caught: unknown) {
      setRecords([])
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }, [kind, workspacePath])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const untrusted = records.filter((row) => row.problem === 'untrusted-project').length

  return (
    <section aria-labelledby="extensions-heading">
      <h2 id="extensions-heading" className={SETTINGS_CAPTION_CLASS}>
        Skills and MCP
      </h2>
      <p className={`mb-2.5 mt-0.5 ${SETTINGS_HINT_CLASS}`}>
        {kind === 'ari-core'
          ? 'Ari Core loads these itself. User skills apply immediately on the next message. Project skills stay off until you trust this folder.'
          : 'Claude Code and Codex load these themselves. Ari only adds the in-app browser. Changes show up on the next message. If a resumed chat still lacks a server, start a new chat.'}
      </p>
      <div className="space-y-3">
        {loading ? <Spinner size="sm" /> : null}
        {error ? (
          <p role="alert" className="text-[13px] leading-5 text-danger">
            {error}
          </p>
        ) : null}
        {truncated ? <p className={SETTINGS_HINT_CLASS}>The list is truncated.</p> : null}
        {!loading && records.length === 0 ? (
          <p className={SETTINGS_HINT_CLASS}>No skills or MCP servers found for this agent.</p>
        ) : records.length > 0 ? (
          <ul className={SETTINGS_CARD_CLASS}>
            {records.map((row) => (
              <li key={row.id} className="px-4 py-3.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[13px] font-medium text-fg">{row.name}</span>
                  <Badge tone="neutral">{KIND[row.kind]}</Badge>
                  <Badge tone="neutral">{SCOPE[row.scope]}</Badge>
                  <Badge tone="neutral">
                    {row.provider === 'claude'
                      ? 'Loaded by Claude'
                      : row.provider === 'codex'
                        ? 'Loaded by Codex'
                        : DELIVERY[row.delivery]}
                  </Badge>
                  {row.disabled ? <Badge tone="warning">Disabled</Badge> : null}
                  {row.problem ? <Badge tone="warning">{PROBLEM[row.problem]}</Badge> : null}
                </div>
                {row.summary ? (
                  <p className={`mt-1 ${SETTINGS_HINT_CLASS}`}>{row.summary}</p>
                ) : null}
                {row.command ? (
                  <p className="mt-1 break-all font-mono text-[12.5px] text-fg-subtle">
                    {row.command}
                  </p>
                ) : null}
                {row.problem === 'duplicate-name' ? (
                  <p className="mt-1 text-[13px] leading-5 text-warning">
                    This name collides with the in-app browser. Ari still sends its own ari-browser.
                  </p>
                ) : null}
                <div className="mt-2.5 flex gap-2 empty:hidden">
                  {row.kind === 'skill' && row.sourcePath ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      type="button"
                      onClick={() => {
                        void rpc
                          .invoke('providers.readExtensionFile', {
                            kind,
                            workspacePath,
                            path: row.sourcePath ?? '',
                          })
                          .then((file) => setPreview(file.content))
                          .catch((caught: unknown) =>
                            setError(caught instanceof Error ? caught.message : String(caught)),
                          )
                      }}
                    >
                      View skill
                    </Button>
                  ) : null}
                  {kind === 'ari-core' && row.kind === 'mcp' && row.scope === 'user' ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      type="button"
                      onClick={() => {
                        const id = row.id.split(':')[3]
                        if (!id) return
                        void rpc
                          .invoke('ariCore.mcp.upsert', { id, disabled: !row.disabled })
                          .then(() => refresh())
                          .catch((caught: unknown) =>
                            setError(caught instanceof Error ? caught.message : String(caught)),
                          )
                      }}
                    >
                      {row.disabled ? 'Enable' : 'Disable'}
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        {preview ? (
          <pre className="ari-scroll max-h-64 overflow-auto rounded-lg border border-border bg-surface-0 p-3 font-mono text-[12.5px] leading-5 text-fg-muted">
            {preview}
          </pre>
        ) : null}
        {kind === 'ari-core' && untrusted > 0 && workspacePath ? (
          <Button
            size="sm"
            type="button"
            onClick={() => {
              void rpc
                .invoke('ariCore.skills.trust', { workspacePath, trusted: true })
                .then(() => refresh())
                .catch((caught: unknown) =>
                  setError(caught instanceof Error ? caught.message : String(caught)),
                )
            }}
          >
            Trust skills in this folder ({untrusted})
          </Button>
        ) : null}
        {kind === 'ari-core' ? (
          <CoreMcpForm servers={servers} onSaved={() => void refresh()} />
        ) : null}
      </div>
    </section>
  )
}

function CoreMcpForm({ servers, onSaved }: { servers: PublicServer[]; onSaved: () => void }) {
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [env, setEnv] = useState('')
  const [error, setError] = useState<string | null>(null)

  return (
    <form
      className={`${card} space-y-3 p-4`}
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
          .then(() => {
            setName('')
            setCommand('')
            setArgs('')
            setEnv('')
            setError(null)
            onSaved()
          })
          .catch((caught: unknown) =>
            setError(caught instanceof Error ? caught.message : String(caught)),
          )
      }}
    >
      <div>
        <p className={SETTINGS_LABEL_CLASS}>Add an Ari Core MCP server</p>
        <p className={`mt-0.5 ${SETTINGS_HINT_CLASS}`}>
          {servers.length} saved. Env values are stored and never shown again. Leave env blank to
          keep existing values when you disable a server above.
        </p>
      </div>
      <label className={FORM_LABEL_CLASS}>
        Name
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          className={`${SETTINGS_FIELD_CLASS} mt-1.5 block w-full font-normal`}
          required
        />
      </label>
      <label className={FORM_LABEL_CLASS}>
        Command
        <input
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          className={`${SETTINGS_FIELD_CLASS} mt-1.5 block w-full font-mono font-normal`}
          required
        />
      </label>
      <label className={FORM_LABEL_CLASS}>
        Args, one per line
        <Textarea
          value={args}
          onChange={(event) => setArgs(event.target.value)}
          className="mt-1.5 block font-mono font-normal"
          rows={2}
        />
      </label>
      <label className={FORM_LABEL_CLASS}>
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
      <Button size="sm" type="submit">
        Add server
      </Button>
    </form>
  )
}

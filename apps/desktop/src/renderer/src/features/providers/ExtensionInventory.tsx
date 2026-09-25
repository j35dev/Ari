import { useCallback, useEffect, useState } from 'react'
import type { DriverKind } from '@ari/contracts/common'
import type { RpcResults } from '@ari/contracts/rpc'
import { Badge } from '@ari/ui/badge'
import { Button } from '@ari/ui/button'
import { Spinner } from '@ari/ui/spinner'
import { rpc } from '../../lib/rpc'

type RecordRow = RpcResults['providers.extensionInventory']['records'][number]
type PublicServer = RpcResults['ariCore.mcp.list']['servers'][number]

const DELIVERY: Record<RecordRow['delivery'], string> = {
  delegated: 'Loaded by the agent',
  injected: 'Ari browser',
  hosted: 'Ari Core',
}

const PROBLEM: Record<NonNullable<RecordRow['problem']>, string> = {
  'missing-binary': 'missing binary',
  unreadable: 'unreadable',
  'duplicate-name': 'name collides with ari-browser',
  'untrusted-project': 'not trusted',
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
    <section aria-labelledby="extensions-heading" className="space-y-3">
      <h2 id="extensions-heading" className="text-sm font-medium">
        Skills and MCP
      </h2>
      <p className="text-sm text-fg-muted">
        {kind === 'ari-core'
          ? 'Ari Core loads these itself. User skills apply immediately on the next message. Project skills stay off until you trust this folder.'
          : 'Claude Code and Codex load these themselves. Ari only adds the in-app browser. Changes show up on the next message. If a resumed chat still lacks a server, start a new chat.'}
      </p>
      {loading ? <Spinner size="sm" /> : null}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {truncated ? <p className="text-xs text-fg-subtle">The list is truncated.</p> : null}
      {!loading && records.length === 0 ? (
        <p className="text-sm text-fg-muted">No skills or MCP servers found for this agent.</p>
      ) : (
        <ul className="flex flex-col">
          {records.map((row) => (
            <li key={row.id} className="border-b border-border/60 py-3 last:border-b-0">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm text-fg">{row.name}</span>
                <Badge tone="neutral">{row.kind}</Badge>
                <Badge tone="neutral">{row.scope}</Badge>
                <Badge tone={row.delivery === 'injected' ? 'accent' : 'neutral'}>
                  {row.provider === 'claude'
                    ? 'Loaded by Claude'
                    : row.provider === 'codex'
                      ? 'Loaded by Codex'
                      : DELIVERY[row.delivery]}
                </Badge>
                {row.disabled ? <Badge tone="warning">disabled</Badge> : null}
                {row.problem ? <Badge tone="warning">{PROBLEM[row.problem]}</Badge> : null}
              </div>
              {row.summary ? <p className="mt-1 text-xs text-fg-muted">{row.summary}</p> : null}
              {row.command ? (
                <p className="mt-1 font-mono text-xs text-fg-subtle">{row.command}</p>
              ) : null}
              {row.problem === 'duplicate-name' ? (
                <p className="mt-1 text-xs text-warning">
                  This name collides with the in-app browser. Ari still sends its own ari-browser.
                </p>
              ) : null}
              <div className="mt-2 flex gap-2">
                {row.kind === 'skill' && row.sourcePath ? (
                  <Button
                    variant="secondary"
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
      )}
      {preview ? (
        <pre className="max-h-64 overflow-auto rounded-md border border-border bg-surface-1 p-3 font-mono text-xs text-fg">
          {preview}
        </pre>
      ) : null}
      {kind === 'ari-core' && untrusted > 0 && workspacePath ? (
        <Button
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
      {kind === 'ari-core' ? <CoreMcpForm servers={servers} onSaved={() => void refresh()} /> : null}
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
      className="space-y-2 rounded-md border border-border p-3"
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
            args: args.split('\n').map((line) => line.trim()).filter((line) => line.length > 0),
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
          .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)))
      }}
    >
      <p className="text-sm font-medium text-fg">Add an Ari Core MCP server</p>
      <p className="text-xs text-fg-muted">
        {servers.length} saved. Env values are stored and never shown again. Leave env blank to keep
        existing values when you disable a server above.
      </p>
      <label className="block text-xs text-fg-muted">
        Name
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="mt-1 w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-sm text-fg"
          required
        />
      </label>
      <label className="block text-xs text-fg-muted">
        Command
        <input
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          className="mt-1 w-full rounded-md border border-border bg-surface-1 px-2 py-1 font-mono text-sm text-fg"
          required
        />
      </label>
      <label className="block text-xs text-fg-muted">
        Args, one per line
        <textarea
          value={args}
          onChange={(event) => setArgs(event.target.value)}
          className="mt-1 w-full rounded-md border border-border bg-surface-1 px-2 py-1 font-mono text-sm text-fg"
          rows={2}
        />
      </label>
      <label className="block text-xs text-fg-muted">
        Env, KEY=value, one per line
        <textarea
          value={env}
          onChange={(event) => setEnv(event.target.value)}
          className="mt-1 w-full rounded-md border border-border bg-surface-1 px-2 py-1 font-mono text-sm text-fg"
          rows={2}
        />
      </label>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <Button type="submit">Add server</Button>
    </form>
  )
}

import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@ari/contracts/agent-event'
import { slashCommandSchema } from '@ari/contracts/slash-commands'
import { formatUnknownError } from '@ari/shared/result'
import type { AdapterSession, Driver, ProviderAdapter } from '../driver'
import { ONE_SHOT_PROVIDER_CAPABILITIES } from '../driver'
import { loadImageData, missingImagesNote, stagedImagesOf } from '../attachments'
import { AsyncQueue } from '../claude/async-queue'
import { ACP_PROVIDER_DEFAULT_EFFORT } from '../acp/thought'
import { PiCommandError, PiRpcConnection } from './rpc-connection'
import type { PiConnectionOptions, PiRecord } from './rpc-connection'
import { PI_PERMISSION_EXTENSION } from './permission-extension'
import { PiRpcMapper } from './rpc-mapper'

const CAPABILITIES = {
  ...ONE_SHOT_PROVIDER_CAPABILITIES,
  steering: 'live',
  liveResponses: 'approvals-and-input',
  terminalStatus: 'explicit',
} as const

interface PiDriverOptions extends PiConnectionOptions {
  mcpServers?: (session: AdapterSession) => Record<string, unknown>
}

interface PiState {
  sessionFile?: string
  sessionId?: string
  thinkingLevel?: string
}

export function buildPiArgs(session: AdapterSession): string[] {
  const args = ['--mode', 'rpc']
  if (session.modelId && session.modelId !== 'default') args.push('--model', session.modelId)
  if (session.resumeOf) args.push('--session', session.resumeOf)
  return args
}

function piCommands(data: unknown) {
  const commands = (data as { commands?: Record<string, unknown>[] } | undefined)?.commands
  if (!Array.isArray(commands)) return []
  return commands.slice(0, 1_000).flatMap((command) => {
    if (!command || typeof command !== 'object') return []
    const parsed = slashCommandSchema.safeParse({
      name: command.name,
      description:
        typeof command.description === 'string' ? command.description.slice(0, 2_000) : '',
      argumentHint: null,
      source: command.source === 'skill' ? 'skill' : 'user',
      run: 'prompt-text',
    })
    return parsed.success ? [parsed.data] : []
  })
}

export class PiDriver implements Driver {
  readonly kind = 'pi' as const
  readonly systemInstructions = true
  constructor(
    private readonly binaryPath: string,
    private readonly options: PiDriverOptions = {},
  ) {}
  capabilities() {
    return CAPABILITIES
  }

  async create(session: AdapterSession): Promise<ProviderAdapter> {
    const scratch = await mkdtemp(join(tmpdir(), 'ari-pi-rpc-'))
    const removeScratch = () =>
      rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    try {
      const extension = join(scratch, 'ari-permissions.mjs')
      await writeFile(extension, PI_PERMISSION_EXTENSION)
      const args = [...buildPiArgs(session), '--extension', extension]
      if (session.instructions) {
        const instructions = join(scratch, 'instructions.md')
        await writeFile(instructions, session.instructions)
        args.push('--append-system-prompt', instructions)
      }
      const wire = new PiRpcConnection(this.binaryPath, args, {
        ...this.options,
        cwd: session.workspacePath,
        env: {
          ...(session.runtimeEnv ?? process.env),
          ARI_PI_PERMISSION_MODE: session.permissionMode,
          ARI_PI_MCP_SERVERS: JSON.stringify(this.options.mcpServers?.(session) ?? {}),
        },
      })
      return createPiAdapter(wire, session, removeScratch)
    } catch (error) {
      await removeScratch()
      throw error
    }
  }
}

/** One process per Ari turn. Pi's session store carries history across processes. */
function createPiAdapter(
  wire: PiRpcConnection,
  session: AdapterSession,
  removeScratch: () => Promise<void>,
): ProviderAdapter {
  const queue = new AsyncQueue<AgentEvent>()
  const mapper = new PiRpcMapper()
  const dialogs = new Map<string, string>()
  let state: PiState | undefined
  let started = false
  let submitted = false
  let running = false
  let ended = false
  let interrupted = false

  const publish = (events: AgentEvent[]) => {
    if (ended) return
    for (const event of events) {
      if (event.type === 'done') {
        // Pi allocates a path before the first persisted message. Publishing
        // its ID too early would make a cancelled startup or local command unresumable.
        if (state?.sessionId && state.sessionFile && existsSync(state.sessionFile))
          queue.push({ type: 'session-ref', ref: state.sessionId })
        queue.push(event)
        ended = true
        queue.end()
        return
      }
      queue.push(event)
    }
  }
  const fail = (error: unknown) => {
    if (interrupted) return
    publish([
      { type: 'error', message: formatUnknownError(error), rawJson: null },
      { type: 'done', stopReason: 'error' },
    ])
  }
  const answer = (id: string, fields: Record<string, unknown>) => {
    if (!dialogs.delete(id)) return
    void wire.write({ type: 'extension_ui_response', id, ...fields }).catch(fail)
  }
  const handleUi = (record: PiRecord) => {
    const { id, method, title, message } = record
    if (typeof id !== 'string' || typeof method !== 'string') return
    if (method === 'notify') {
      if (typeof message === 'string' && message !== 'ARI_PI_BRIDGE_READY')
        publish([{ type: 'notice', message }])
      return
    }
    if (!['confirm', 'select', 'input', 'editor'].includes(method)) return
    dialogs.set(id, method)
    if (ended || interrupted) {
      answer(id, { cancelled: true })
      return
    }
    const approvalPrefix = 'ARI_PI_APPROVAL:'
    if (method === 'confirm' && typeof title === 'string' && title.startsWith(approvalPrefix)) {
      try {
        const tool = JSON.parse(title.slice(approvalPrefix.length)) as {
          toolName: string
          toolCallId: string
          args: unknown
        }
        if (typeof tool.toolName !== 'string' || typeof tool.toolCallId !== 'string')
          throw new Error()
        dialogs.set(id, 'approval')
        publish([
          {
            type: 'approval-requested',
            approvalId: id,
            providerItemId: tool.toolCallId,
            toolName: tool.toolName,
            summaryJson: JSON.stringify(tool.args ?? {}),
            options: [
              { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
            ],
          },
        ])
      } catch {
        answer(id, { confirmed: false })
        fail(new Error('Invalid Pi tool approval request.'))
      }
      return
    }
    publish([
      {
        type: 'input-requested',
        inputId: id,
        prompt: [title, message].filter((value) => typeof value === 'string').join('\n'),
        choicesJson:
          method === 'confirm'
            ? JSON.stringify(['Yes', 'No'])
            : Array.isArray(record.options)
              ? JSON.stringify(record.options)
              : null,
      },
    ])
  }
  const unsubscribe = wire.subscribe((record) => {
    if (record.type === 'extension_ui_request') handleUi(record)
    else if (record.type === 'extension_error')
      publish([{ type: 'notice', message: `Pi extension failed: ${String(record.error)}` }])
    else if (submitted && !ended) {
      if (record.type === 'agent_start') running = true
      // An abort acknowledgement means Pi is idle. It can trail agent_settled.
      if (!(interrupted && record.type === 'agent_settled')) publish(mapper.map(record))
    }
  }, fail)

  const run = async () => {
    state = (await wire.request('get_state')) as PiState
    if (!wire.bridgeReady)
      throw new Error('Pi did not load the Ari permission extension. Update Pi and retry.')
    if (!state?.sessionId || !state.sessionFile)
      throw new Error('Pi RPC did not return a persistent session reference.')
    const thinking = (await wire.request('get_available_thinking_levels')) as
      { levels?: string[] } | undefined
    if (!Array.isArray(thinking?.levels))
      throw new Error('Pi did not report model reasoning levels. Update Pi and retry.')
    const effort = session.effort
    if (effort && effort !== ACP_PROVIDER_DEFAULT_EFFORT && effort !== state.thinkingLevel) {
      if (!thinking.levels.includes(effort))
        throw new Error(`Pi does not support reasoning effort ${effort} for this model.`)
      await wire.request('set_thinking_level', { level: effort })
      const applied = (await wire.request('get_state')) as PiState | undefined
      if (applied?.thinkingLevel !== effort)
        throw new Error(`Pi did not apply reasoning effort ${effort}.`)
    }
    const commands = piCommands(await wire.request('get_commands'))
    publish([{ type: 'commands', commands }])
    const { loaded, missing } = await loadImageData(stagedImagesOf(session))
    if (ended || interrupted) return
    submitted = true
    const images = loaded.map((image) => ({
      type: 'image',
      data: image.dataBase64,
      mimeType: image.mimeType,
    }))
    const response = (await wire.request('prompt', {
      message: session.prompt + missingImagesNote(missing),
      ...(images.length ? { images } : {}),
    })) as { disposition?: string } | undefined
    if (response?.disposition === 'handled' && !running && !interrupted) {
      publish([
        { type: 'notice', message: 'A Pi extension handled this prompt.' },
        { type: 'done', stopReason: 'completed' },
      ])
    }
  }
  const cancel = async () => {
    try {
      if (submitted) {
        await wire.request('clear_queue', {}, 2_000)
        const abort = wire.request('abort', {}, 3_000)
        for (const id of dialogs.keys()) answer(id, { cancelled: true })
        await abort
      } else await wire.dispose()
    } catch {
      await wire.dispose().catch(() => undefined)
    } finally {
      publish([{ type: 'done', stopReason: 'interrupted' }])
    }
  }

  return {
    capabilities: () => CAPABILITIES,
    start: () => {
      if (!started && !interrupted && !ended) {
        started = true
        void run().catch(fail)
      }
      return queue
    },
    interrupt: () => {
      if (ended || interrupted) return
      interrupted = true
      void cancel()
    },
    steer: async (text, attachments = []) => {
      if (!running || ended || interrupted || wire.closed) return false
      const { loaded, missing } = await loadImageData([...attachments])
      if (ended || interrupted || wire.closed) return false
      const images = loaded.map((image) => ({
        type: 'image',
        data: image.dataBase64,
        mimeType: image.mimeType,
      }))
      try {
        await wire.request('steer', {
          message: text + missingImagesNote(missing),
          ...(images.length ? { images } : {}),
        })
        return true
      } catch (error) {
        if (error instanceof PiCommandError) return false
        throw error
      }
    },
    respondApproval: (id, decision) => {
      if (dialogs.get(id) !== 'approval') return
      const option = typeof decision === 'object' ? decision.optionId : decision
      if (option === 'allow' || option === 'deny') answer(id, { confirmed: option === 'allow' })
    },
    respondInput: (id, value) => {
      const method = dialogs.get(id)
      if (method === 'confirm') answer(id, { confirmed: value === 'Yes' })
      else if (method && method !== 'approval') answer(id, { value })
    },
    dispose: async () => {
      unsubscribe()
      ended = true
      queue.end()
      await wire.dispose()
      await removeScratch()
    },
  }
}

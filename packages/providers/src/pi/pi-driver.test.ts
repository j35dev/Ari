import { EventEmitter } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { AgentEvent } from '@ari/contracts/agent-event'
import { defaultSettings } from '@ari/contracts/settings'
import { expect, it, vi } from 'vitest'
import type { AdapterSession } from '../driver'
import { useTempDirs } from '../testing/temp-dirs'
import { probePiCatalog } from './catalog'
import { PiDriver } from './pi-driver'
import type { PiRecord, PiSpawn } from './rpc-connection'

const tempDir = useTempDirs()
const base: AdapterSession = {
  sessionId: 'sess_1',
  workspacePath: 'D:\\proj',
  prompt: 'Read the thing',
  modelId: 'local/model',
  permissionMode: 'ask',
  resumeOf: null,
}

function fixture(sessionFile = 'unpinned.jsonl', bridgeReady = true) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: 0,
    kill: vi.fn(() => true),
  })
  const send = (record: PiRecord) => child.stdout.write(JSON.stringify(record) + '\n')
  const ready: PiRecord = {
    type: 'extension_ui_request',
    id: 'ready',
    method: 'notify',
    message: 'ARI_PI_BRIDGE_READY',
  }
  const commands: PiRecord[] = []
  const handlers = new Map<string, (record: PiRecord) => void>()
  const reply = (record: PiRecord, data?: unknown) =>
    send({
      type: 'response',
      id: record.id,
      command: record.type,
      success: true,
      data,
    })
  let thinkingLevel = 'off'
  child.stdin.on('data', (chunk: Buffer) => {
    const record = JSON.parse(chunk.toString('utf8')) as PiRecord
    commands.push(record)
    if (handlers.has(record.type)) {
      handlers.get(record.type)!(record)
      return
    }
    if (record.type === 'get_state') {
      if (bridgeReady) send(ready)
      reply(record, {
        sessionId: 'legacy-native-id',
        sessionFile,
        thinkingLevel,
        model: { provider: 'local', id: 'model' },
      })
    }
    if (record.type === 'get_available_thinking_levels')
      reply(record, { levels: ['off', 'low', 'high'] })
    if (record.type === 'set_thinking_level') {
      thinkingLevel = String(record.level)
      reply(record)
    }
    if (record.type === 'get_commands')
      reply(record, { commands: [{ name: 'skill:demo', description: 'Demo', source: 'skill' }] })
  })
  const spawn = vi.fn<PiSpawn>(() => child as unknown as ReturnType<PiSpawn>)
  return { child, commands, handlers, send, spawn, reply, ready }
}

async function collect(source: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of source) events.push(event)
  return events
}

it('sends a resumed turn and its image over RPC and streams each content block and tool lifecycle', async () => {
  const dir = await tempDir('ari-pi-rpc-test-')
  const sessionFile = join(dir, 'session.jsonl')
  const image = join(dir, 'png')
  await writeFile(sessionFile, '')
  await writeFile(image, 'image bytes')
  const wire = fixture(sessionFile)
  wire.handlers.set('prompt', (prompt) => {
    const seed = { role: 'assistant', content: [] }
    wire.send({ type: 'agent_start' })
    wire.send({ type: 'message_start', message: seed })
    wire.send({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'Think' },
    })
    wire.send({
      type: 'tool_execution_start',
      toolCallId: 'call',
      toolName: 'read',
      args: { path: 'demo' },
    })
    wire.send({ type: 'tool_execution_update', toolCallId: 'call', partialResult: 'partial' })
    wire.send({ type: 'tool_execution_end', toolCallId: 'call', result: 'done' })
    const text =
      JSON.stringify({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'a\u2028🟩', contentIndex: 1 },
      }) + '\r\n'
    const bytes = Buffer.from(text)
    wire.child.stdout.write(bytes.subarray(0, bytes.length - 2))
    wire.child.stdout.write(bytes.subarray(bytes.length - 2))
    const message = {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Think' },
        { type: 'text', text: 'a\u2028🟩 completed' },
      ],
      usage: { input: 22, output: 4, cacheRead: 8, cacheWrite: 2 },
    }
    wire.send({ type: 'message_end', message })
    wire.send({ type: 'agent_end', messages: [message] })
    wire.send({ type: 'agent_settled', aborted: false })
    wire.reply(prompt, { disposition: 'started' })
  })
  const driver = new PiDriver('pi', { spawn: wire.spawn })
  const adapter = await driver.create({
    ...base,
    workspacePath: dir,
    resumeOf: 'legacy-native-id',
    instructions: 'project instructions',
    effort: 'low',
    attachments: [{ id: 'image', name: 'preview.png', mimeType: 'image/png', path: image }],
  })
  try {
    const call = wire.spawn.mock.calls[0]
    const argv = call?.[1] ?? []
    expect(argv.slice(0, 6)).toEqual([
      '--mode',
      'rpc',
      '--model',
      'local/model',
      '--session',
      'legacy-native-id',
    ])
    expect(argv).not.toContain(base.prompt)
    expect(await readFile(argv[argv.indexOf('--append-system-prompt') + 1]!, 'utf8')).toBe(
      'project instructions',
    )
    expect(wire.commands).toEqual([])
    const events = await collect(adapter.start())
    expect(wire.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'set_thinking_level', level: 'low' }),
        expect.objectContaining({
          type: 'prompt',
          message: base.prompt,
          images: [
            {
              type: 'image',
              data: Buffer.from('image bytes').toString('base64'),
              mimeType: 'image/png',
            },
          ],
        }),
      ]),
    )
    expect(events.map((event) => event.type)).toEqual([
      'commands',
      'thinking-delta',
      'tool-started',
      'tool-progress',
      'tool-completed',
      'text-delta',
      'text-delta',
      'usage',
      'context-usage',
      'session-ref',
      'done',
    ])
    expect(
      events.filter((event) => event.type === 'text-delta').map((event) => event.text),
    ).toEqual(['a\u2028🟩', ' completed'])
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'usage',
        inputTokens: 32,
        outputTokens: 4,
        cachedInputTokens: 8,
      }),
    )
    expect(events.slice(-2)).toEqual([
      { type: 'session-ref', ref: 'legacy-native-id' },
      { type: 'done', stopReason: 'completed' },
    ])
  } finally {
    await adapter.dispose()
  }
})

it.each([
  [
    'Qwen HTTP 400',
    '400: Unexpected reasoning effort high. Supported types are xhigh (default), medium, and low.',
  ],
  ['empty success', null],
])('surfaces %s as a failed turn even when Pi accepts the prompt', async (_label, message) => {
  const wire = fixture()
  wire.handlers.set('prompt', (prompt) => {
    wire.reply(prompt, { disposition: 'started' })
    wire.send({ type: 'agent_start' })
    if (message)
      wire.send({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'error', errorMessage: message },
      })
    wire.send({ type: 'agent_end', messages: [] })
    wire.send({ type: 'agent_settled' })
  })
  const adapter = await new PiDriver('pi', { spawn: wire.spawn }).create({
    ...base,
    effort: 'high',
  })
  try {
    const events = await collect(adapter.start())
    expect(events.slice(-2)).toEqual([
      {
        type: 'error',
        message: message ?? 'Pi completed without assistant output or tool calls.',
        rawJson: null,
      },
      { type: 'done', stopReason: 'error' },
    ])
    expect(wire.commands.filter((command) => command.type === 'prompt')).toHaveLength(1)
    expect(events.some((event) => event.type === 'session-ref')).toBe(false)
  } finally {
    await adapter.dispose()
  }
})

it('uses agent_settled rather than agent_end so a successful retry clears the earlier failure', async () => {
  const wire = fixture()
  wire.handlers.set('prompt', (prompt) => {
    wire.reply(prompt, { disposition: 'started' })
    wire.send({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'error', errorMessage: '529 overloaded' },
    })
    wire.send({ type: 'agent_end', messages: [], willRetry: true })
    wire.send({ type: 'auto_retry_start', errorMessage: '529 overloaded' })
    wire.send({
      type: 'message_end',
      message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'OK' }] },
    })
    wire.send({ type: 'agent_end', messages: [] })
    wire.send({ type: 'agent_settled' })
  })
  const adapter = await new PiDriver('pi', { spawn: wire.spawn }).create(base)
  try {
    const events = await collect(adapter.start())
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'notice', message: 'Pi retrying: 529 overloaded' }),
    )
    expect(events).toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'OK' }))
    expect(events.some((event) => event.type === 'error')).toBe(false)
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'completed' })
  } finally {
    await adapter.dispose()
  }
})

it('answers approval and input requests on their own channels and waits for Pi to acknowledge Stop', async () => {
  const wire = fixture()
  wire.handlers.set('get_state', (state) => {
    wire.handlers.delete('get_state')
    wire.send(wire.ready)
    wire.send({
      type: 'extension_ui_request',
      id: 'question',
      method: 'select',
      title: 'Choose',
      options: ['Mock'],
    })
    wire.handlers.set('extension_ui_response', (response) => {
      if (response.id === 'question')
        wire.reply(state, { sessionId: 's', sessionFile: 'unpinned.jsonl' })
    })
  })
  wire.handlers.set('prompt', (prompt) => {
    wire.reply(prompt, { disposition: 'started' })
    wire.send({ type: 'agent_start' })
    wire.send({
      type: 'extension_ui_request',
      id: 'approval',
      method: 'confirm',
      title:
        'ARI_PI_APPROVAL:' +
        JSON.stringify({ toolCallId: 'tool-1', toolName: 'write', args: { path: 'thing' } }),
    })
  })
  wire.handlers.set('steer', (command) => wire.reply(command, { disposition: 'queued' }))
  wire.handlers.set('clear_queue', (command) => wire.reply(command))
  let abort: PiRecord | undefined
  wire.handlers.set('abort', (command) => {
    abort = command
    wire.send({ type: 'agent_settled', aborted: true })
  })
  const adapter = await new PiDriver('pi', { spawn: wire.spawn }).create(base)
  const events = (async () => {
    const result: AgentEvent[] = []
    for await (const event of adapter.start()) {
      result.push(event)
      if (event.type === 'input-requested') adapter.respondInput?.(event.inputId, 'Mock')
      if (event.type === 'approval-requested') {
        adapter.respondInput?.(event.approvalId, 'Yes')
        adapter.respondApproval?.(event.approvalId, { optionId: 'deny' })
        expect(await adapter.steer?.('Queued')).toBe(true)
        adapter.interrupt()
      }
    }
    return result
  })()
  try {
    await vi.waitFor(() => expect(abort).toBeDefined())
    expect(await Promise.race([events, Promise.resolve('pending')])).toBe('pending')
    wire.reply(abort!)
    expect((await events).at(-1)).toEqual({ type: 'done', stopReason: 'interrupted' })
    expect(wire.commands.filter((command) => command.type === 'extension_ui_response')).toEqual([
      { type: 'extension_ui_response', id: 'question', value: 'Mock' },
      { type: 'extension_ui_response', id: 'approval', confirmed: false },
    ])
    expect(wire.commands.map((command) => command.type).slice(-3)).toEqual([
      'steer',
      'clear_queue',
      'abort',
    ])
  } finally {
    await adapter.dispose()
  }
})

it('does not submit a prompt when the Pi approval extension failed to load', async () => {
  const wire = fixture(undefined, false)
  const adapter = await new PiDriver('pi', { spawn: wire.spawn }).create(base)
  try {
    const events = await collect(adapter.start())
    expect(events.find((event) => event.type === 'error')?.message).toContain(
      'permission extension',
    )
    expect(wire.commands.map((command) => command.type)).toEqual(['get_state'])
  } finally {
    await adapter.dispose()
  }
})

it('ends the turn with Pi diagnostics on a mid-turn process exit', async () => {
  const wire = fixture()
  wire.handlers.set('prompt', (prompt) => {
    wire.reply(prompt, { disposition: 'started' })
    wire.send({ type: 'agent_start' })
    wire.child.stderr.write('native runtime crashed')
    wire.child.emit('close', 1, null)
  })
  const adapter = await new PiDriver('pi', { spawn: wire.spawn }).create(base)
  try {
    const events = await collect(adapter.start())
    expect(events.find((event) => event.type === 'error')?.message).toContain(
      'native runtime crashed',
    )
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'error' })
  } finally {
    await adapter.dispose()
  }
})

it('keeps Pi tools enabled and takes the permission mode from the Ari session default', async () => {
  const wire = fixture()
  const adapter = await new PiDriver('pi', { spawn: wire.spawn }).create({
    ...base,
    permissionMode: defaultSettings.sessions.defaultPermissionMode,
  })
  try {
    const [, args, options] = wire.spawn.mock.calls[0]!
    expect(args).not.toContain('--tools')
    expect(args).not.toContain('--exclude-tools')
    expect(options?.env?.['ARI_PI_PERMISSION_MODE']).toBe('full')
  } finally {
    await adapter.dispose()
  }
})

it('discovers local models and mapped thinking levels without selecting or prompting any model', async () => {
  const wire = fixture()
  wire.handlers.set('get_available_models', (command) =>
    wire.reply(command, {
      models: [
        {
          id: 'model',
          provider: 'local',
          name: 'Local',
          contextWindow: 16_000,
          reasoning: true,
          thinkingLevelMap: { high: null, minimal: null, xhigh: 'xhigh' },
        },
        { id: 'basic', provider: 'local', reasoning: false },
      ],
    }),
  )
  const catalog = await probePiCatalog('pi', base.workspacePath, {}, { spawn: wire.spawn })
  expect(catalog.defaultModelId).toBe('local/model')
  expect(
    catalog.models.map((model) => ({
      id: model.id,
      levels: model.efforts?.map((effort) => effort.id),
    })),
  ).toEqual([
    { id: 'local/model', levels: ['off', 'low', 'medium', 'xhigh'] },
    { id: 'local/basic', levels: ['off'] },
  ])
  expect(wire.commands.map((command) => command.type)).toEqual([
    'get_state',
    'get_available_models',
  ])
})

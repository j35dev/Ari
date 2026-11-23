/** Explicit read-only integration smoke. Built/run separately; never imported by Ari main. */
import { query, shutdownDaemon, startDaemon } from '@qoder-ai/qoder-agent-sdk'
import { QoderDriver } from '@ari/providers/qoder'
import { pushMessageParts, type MessagePart } from '@ari/contracts/message'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const cwd = resolve('out/provider-research/sdk-turn')
await mkdir(cwd, { recursive: true })
const binary = process.argv[2]
if (!binary) throw new Error('Pass the detected Qoder CLI path as the first argument.')
const subagent = process.argv.includes('--subagent')
const wire: { type: string; subtype?: string; taskType?: string; child: boolean }[] = []
const driver = new QoderDriver(binary, {
  pool: null,
  startDaemon,
  query: (input) => {
    const runtime = query({
      ...input,
      options: {
        ...input.options,
        maxTurns: subagent ? 4 : 1,
        settingSources: [],
        tools: subagent ? ['Agent'] : [],
        mcpServers: {},
        strictMcpConfig: true,
        ...(subagent
          ? {
              agents: {
                'fixture-replier': {
                  description: 'Read-only verification: replies with a fixed marker, no tools.',
                  prompt: 'Reply with exactly child-ready. Do not call tools.',
                  tools: [],
                  maxTurns: 1,
                },
              },
            }
          : {}),
      },
    })
    return {
      initializationResult: runtime.initializationResult.bind(runtime),
      interrupt: runtime.interrupt.bind(runtime),
      close: runtime.close.bind(runtime),
      supportedCommands: runtime.supportedCommands.bind(runtime),
      stopTask: runtime.stopTask.bind(runtime),
      async *[Symbol.asyncIterator]() {
        for await (const message of runtime) {
          if (message.type !== 'stream_event')
            wire.push({
              type: message.type,
              ...('subtype' in message ? { subtype: message.subtype } : {}),
              ...('task_type' in message ? { taskType: message.task_type } : {}),
              child: 'parent_tool_use_id' in message && !!message.parent_tool_use_id,
            })
          yield message
        }
      },
    }
  },
})
let adapter: Awaited<ReturnType<QoderDriver['create']>> | null = null
const deadline = setTimeout(() => {
  adapter?.interrupt()
}, 120_000)
try {
  adapter = await driver.create({
    sessionId: 'sdk-smoke',
    workspacePath: cwd,
    prompt: subagent
      ? 'Invoke the Agent tool exactly once, in the foreground, using subagent_type fixture-replier and prompt "Reply with exactly child-ready". After it replies, answer exactly sdk-ready. Do not use any other tools.'
      : 'Reply with exactly sdk-ready. Do not call any tools or read any files.',
    modelId: 'default',
    permissionMode: 'ask',
    resumeOf: null,
  })
  const parts: MessagePart[] = []
  const child: MessagePart[] = []
  const tasks = new Map<string, { status: string; prompt?: string | null; model?: string | null }>()
  const toolIds = new Set<string>()
  let completed = false,
    errors = 0,
    tools = 0
  for await (const event of adapter.start()) {
    if (event.type === 'text-delta')
      pushMessageParts(parts, [
        { type: 'text', text: event.text, streamId: event.streamId, replace: event.replace },
      ])
    if (event.type === 'tool-started') {
      toolIds.add(event.callId)
      tools = toolIds.size
    }
    if (event.type === 'background-task' && event.kind === 'subagent')
      tasks.set(event.id, { ...tasks.get(event.id), ...event })
    if (event.type === 'subagent-activity' && event.event.type === 'text-delta')
      pushMessageParts(child, [
        {
          type: 'text',
          text: event.event.text,
          streamId: event.event.streamId,
          replace: event.event.replace,
        },
      ])
    if (event.type === 'approval-requested')
      adapter.respondApproval?.(
        event.approvalId,
        subagent && event.toolName === 'Agent' ? 'allow' : 'deny',
      )
    if (event.type === 'input-requested') adapter.respondInput?.(event.inputId, '')
    if (event.type === 'error') errors++
    if (event.type === 'done') completed = event.stopReason === 'completed'
  }
  const answer = parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim()
  const childReply = child
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim()
  const nativeComplete =
    tasks.size === 1 && [...tasks.values()].every((task) => task.status === 'completed')
  const passed =
    completed &&
    errors === 0 &&
    answer === 'sdk-ready' &&
    (subagent ? tools === 1 && nativeComplete && childReply === 'child-ready' : tools === 0)
  process.stdout.write(
    JSON.stringify({
      sdk: true,
      subagent,
      completed,
      errors,
      tools,
      exactReply: answer === 'sdk-ready',
      ...(subagent
        ? {
            childReply: childReply === 'child-ready',
            nativeComplete,
            taskCount: tasks.size,
            hasPrompt: [...tasks.values()].some((task) => !!task.prompt),
            hasModel: [...tasks.values()].some((task) => !!task.model),
            wire,
          }
        : {}),
      passed,
    }) + '\n',
  )
  if (!passed) process.exitCode = 1
} catch (error) {
  process.stdout.write(
    JSON.stringify({ passed: false, errorType: error instanceof Error ? error.name : 'Error' }) +
      '\n',
  )
  process.exitCode = 1
} finally {
  clearTimeout(deadline)
  await adapter?.dispose()
  await shutdownDaemon()
}
